import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Per-task outcome log (`~/.local/share/ai-ship/outcomes.jsonl`, override AI_SHIP_OUTCOMES_FILE) and the
 * learned per-(role, model) scores the router uses as a small bonus. A task "succeeds" for a model when it
 * was committed with at most one implementer fix round and no review round left OPEN.
 */

export interface TaskOutcome {
  ts: string;
  taskId: string;
  repo: string;
  result: "committed" | "no-changes" | "failed" | "cancelled";
  size?: string;
  risk?: string;
  models: Partial<Record<"implementer" | "tester" | "reviewer" | "bughunter", string>>;
  fixRounds: number;
  reviewRounds: number;
  openFindings: number;
  costUsd: number;
  error?: string;
  /** HEAD of the task branch when it was committed (used to detect later reverts). */
  commitSha?: string;
  /** Filled in later by `ai-ship --outcomes-refresh` from the PR's CI checks and the base branch history. */
  postMerge?: "ok" | "pending" | "ci-failed" | "reverted" | "closed";
  /** Merge commit on the base branch (differs from commitSha for squash/rebase merges). */
  mergeSha?: string;
  prState?: string;
  refreshedAt?: string;
}

export function getOutcomesPath(): string {
  if (process.env.AI_SHIP_OUTCOMES_FILE) return process.env.AI_SHIP_OUTCOMES_FILE;
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `ai-ship-test-outcomes-${process.pid}.jsonl`);
  return path.join(os.homedir(), ".local", "share", "ai-ship", "outcomes.jsonl");
}

export function appendOutcome(o: TaskOutcome, file = getOutcomesPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(o)}\n`, "utf8");
}

export function readOutcomes(file = getOutcomesPath(), since?: Date): TaskOutcome[] {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: TaskOutcome[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as TaskOutcome;
      const t = new Date(o.ts);
      if (Number.isNaN(t.getTime()) || typeof o.result !== "string") continue;
      if (since && t < since) continue;
      out.push(o);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function isSuccess(o: TaskOutcome): boolean {
  return (
    o.result === "committed" &&
    o.fixRounds <= 1 &&
    o.openFindings === 0 &&
    o.postMerge !== "ci-failed" &&
    o.postMerge !== "reverted" &&
    o.postMerge !== "closed"
  );
}

export interface ModelScore {
  n: number;
  successes: number;
  successRate: number;
  avgCostUsd: number;
}

/** Scores keyed `role:model`; outcomes older than `halfLifeDays` count half (exponential decay). */
export function computeModelScores(outcomes: TaskOutcome[], now = new Date(), halfLifeDays = 30): Map<string, ModelScore> {
  const acc = new Map<string, { w: number; s: number; cost: number; n: number }>();
  for (const o of outcomes) {
    // Only model-attributable outcomes: cancellations, no-op runs and failures with no fix/review signal
    // (budget stops, infra errors) say nothing about model quality.
    if (o.result === "cancelled" || o.result === "no-changes") continue;
    if (o.result === "failed" && o.fixRounds === 0 && o.openFindings === 0) continue;
    const ageDays = (now.getTime() - new Date(o.ts).getTime()) / 86_400_000;
    const w = Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
    for (const [role, model] of Object.entries(o.models)) {
      if (!model) continue;
      const key = `${role}:${model}`;
      const a = acc.get(key) ?? { w: 0, s: 0, cost: 0, n: 0 };
      a.w += w;
      a.s += isSuccess(o) ? w : 0;
      a.cost += o.costUsd * w;
      a.n += 1;
      acc.set(key, a);
    }
  }
  const out = new Map<string, ModelScore>();
  for (const [k, a] of acc) {
    out.set(k, { n: a.n, successes: Math.round(a.s), successRate: a.w > 0 ? a.s / a.w : 0, avgCostUsd: a.w > 0 ? a.cost / a.w : 0 });
  }
  return out;
}

/**
 * Router bonus from learned scores: ±0.1 at most, only after ≥3 observations, so the static policy and
 * strengths still dominate until there is real evidence.
 */
export function learnedBonus(scores: Map<string, ModelScore>): (modelId: string, role: string) => number {
  const roleKey = (role: string) => (role === "security" ? "reviewer" : role);
  return (modelId, role) => {
    const s = scores.get(`${roleKey(role)}:${modelId}`) ?? scores.get(`${roleKey(role)}:aig/${modelId}`);
    if (!s || s.n < 3) return 0;
    return Math.max(-0.1, Math.min(0.1, (s.successRate - 0.5) * 0.2));
  };
}

export function formatReport(opts: {
  outcomes: TaskOutcome[];
  spendLines: string[];
  scores: Map<string, ModelScore>;
}): string[] {
  const o = opts.outcomes;
  const committed = o.filter((x) => x.result === "committed");
  const cost = o.reduce((a, x) => a + x.costUsd, 0);
  const attempted = o.filter((x) => x.result !== "cancelled");
  const lines = [
    ...opts.spendLines,
    `Tasks: ${o.length} (committed ${committed.length}, failed ${o.filter((x) => x.result === "failed").length}, cancelled ${o.filter((x) => x.result === "cancelled").length})`,
    `First-pass success: ${attempted.length ? `${Math.round((attempted.filter(isSuccess).length / attempted.length) * 100)}%` : "n/a"}; cost per committed task: ${committed.length ? `$${(cost / committed.length).toFixed(3)}` : "n/a"}`,
  ];
  const rows = [...opts.scores].sort((a, b) => b[1].n - a[1].n).slice(0, 15);
  if (rows.length) {
    lines.push("Quality per model (role:model — n, success, avg $):");
    for (const [k, s] of rows) lines.push(`  ${k} — ${s.n}, ${Math.round(s.successRate * 100)}%, $${s.avgCostUsd.toFixed(3)}`);
  }
  return lines;
}

export type Exec = (cmd: string, args: string[], cwd: string) => { ok: boolean; stdout: string };

const defaultExec: Exec = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 30_000 });
  return { ok: r.status === 0, stdout: r.stdout ?? "" };
};

/** CI verdict from `gh pr view --json state,statusCheckRollup` output. */
export function ciVerdict(json: string): "ok" | "pending" | "ci-failed" | undefined {
  let v: { state?: string; statusCheckRollup?: Array<{ conclusion?: string | null; state?: string | null; status?: string | null }> };
  try {
    v = JSON.parse(json);
  } catch {
    return undefined;
  }
  const checks = v.statusCheckRollup ?? [];
  const results = checks.map((c) => String(c.conclusion ?? c.state ?? "").toUpperCase());
  if (results.some((r) => ["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"].includes(r))) return "ci-failed";
  // CANCELLED/ACTION_REQUIRED are usually superseded runs or approvals, not a verdict: wait for a re-run.
  if (results.some((r) => !r || ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "CANCELLED", "ACTION_REQUIRED"].includes(r))) return "pending";
  return v.state === "MERGED" ? "ok" : "pending";
}

/**
 * Updates committed outcomes with what happened after the pipeline: a revert of the task's commit on any
 * branch → "reverted"; the PR's CI checks failing → "ci-failed"; merged with green checks → "ok". Final
 * verdicts (ok/ci-failed/reverted) are re-checked only for reverts. Rewrites the log atomically and returns
 * the number of outcomes changed.
 */
export function refreshOutcomes(opts: { file?: string; exec?: Exec; now?: Date; maxAgeDays?: number } = {}): { checked: number; changed: number } {
  const file = opts.file ?? getOutcomesPath();
  const exec = opts.exec ?? defaultExec;
  const now = opts.now ?? new Date();
  const maxAge = (opts.maxAgeDays ?? 60) * 86_400_000;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { checked: 0, changed: 0 };
  }
  let checked = 0;
  const updates = new Map<string, string>();
  const fetched = new Set<string>();
  const keyOf = (o: TaskOutcome) => `${o.ts}\u0000${o.taskId}`;
  const isSha = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{7,40}$/i.test(x);
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: TaskOutcome;
    try {
      o = JSON.parse(line) as TaskOutcome;
    } catch {
      continue;
    }
    if (o.result !== "committed" || o.postMerge === "reverted") continue;
    if (now.getTime() - new Date(o.ts).getTime() > maxAge || !o.repo || !fs.existsSync(o.repo)) continue;
    checked++;
    let next: TaskOutcome["postMerge"] = o.postMerge;
    let mergeSha = o.mergeSha;
    let prState = o.prState;
    // CI verdict is final only once the PR is merged or closed; until then a failed run may be re-run green.
    const prFinal = prState === "MERGED" || prState === "CLOSED";
    if (!prFinal && next !== "closed") {
      const pr = exec("gh", ["pr", "view", o.taskId, "--json", "state,statusCheckRollup,mergeCommit"], o.repo);
      if (pr.ok) {
        try {
          const v = JSON.parse(pr.stdout) as { state?: string; mergeCommit?: { oid?: string } | null };
          if (typeof v.state === "string") prState = v.state;
          if (isSha(v.mergeCommit?.oid)) mergeSha = v.mergeCommit.oid;
        } catch {
          // ciVerdict below handles bad JSON
        }
        const ci = ciVerdict(pr.stdout);
        next = prState === "CLOSED" ? "closed" : (ci ?? next);
      }
    }
    const shas = [o.commitSha, mergeSha].filter(isSha);
    if (shas.length && next !== "closed") {
      if (!fetched.has(o.repo)) {
        fetched.add(o.repo);
        exec("git", ["fetch", "--quiet", "origin"], o.repo); // reverts merged on GitHub; failure is fine
      }
      for (const sha of shas) {
        const rev = exec("git", ["log", "--all", "--format=%H", "-n", "1", "-F", `--grep=This reverts commit ${sha}`], o.repo);
        if (rev.ok && rev.stdout.trim()) next = "reverted";
      }
    }
    if (next === o.postMerge && mergeSha === o.mergeSha && prState === o.prState) continue;
    updates.set(
      keyOf(o),
      JSON.stringify({ ...o, postMerge: next, ...(mergeSha ? { mergeSha } : {}), ...(prState ? { prState } : {}), refreshedAt: now.toISOString() })
    );
  }
  if (updates.size > 0) {
    // Re-read right before writing: pipelines may have appended outcomes while git/gh were running.
    const fresh = fs.readFileSync(file, "utf8");
    const out = fresh.split("\n").map((line) => {
      if (!line.trim()) return line;
      try {
        const o = JSON.parse(line) as TaskOutcome;
        return updates.get(keyOf(o)) ?? line;
      } catch {
        return line;
      }
    });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, out.join("\n"), "utf8");
    fs.renameSync(tmp, file);
  }
  const changed = updates.size;
  return { checked, changed };
}
