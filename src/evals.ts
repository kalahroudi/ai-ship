import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendLedger } from "./budget.ts";
import { parseVerdict } from "./pipeline.ts";
import type { AgentRole, PipelineRunner, PromptResult } from "./runner.ts";

/**
 * Model eval harness (task 17). Implementer evals: the model gets a small fixture repo + task; HIDDEN
 * acceptance tests are copied in only after it finishes, then run. Reviewer evals: the model reviews a diff
 * with a known planted bug (expected OPEN) or a clean diff (expected CLEAN); scored as verdict accuracy plus
 * recall/precision on OPEN. Results are JSON reports under ~/.local/share/ai-ship/evals/.
 */

export type EvalRole = "implementer" | "reviewer";

export interface ImplementerCase {
  kind: "implementer";
  name: string;
  dir: string;
  task: string;
  test: string;
}

export interface ReviewerCase {
  kind: "reviewer";
  name: string;
  diff: string;
  expected: "OPEN" | "CLEAN";
  note?: string;
}

export interface CaseResult {
  name: string;
  attempt: number;
  pass: boolean;
  costUsd: number;
  latencyMs: number;
  verdict?: string;
  expected?: string;
  error?: string;
}

export interface EvalReport {
  ts: string;
  model: string;
  role: EvalRole;
  n: number;
  cases: CaseResult[];
  passRate: number;
  costUsd: number;
  avgLatencyMs: number;
  /** Reviewer only: OPEN recall/precision over all attempts. */
  recall?: number;
  precision?: number;
}

export function defaultSuiteDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "evals");
}

export function getEvalsDir(): string {
  if (process.env.AI_SHIP_EVALS_DIR) return process.env.AI_SHIP_EVALS_DIR;
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `ai-ship-test-evals-${process.pid}`);
  return path.join(os.homedir(), ".local", "share", "ai-ship", "evals");
}

export function loadSuite(role: EvalRole, suiteDir = defaultSuiteDir(), only?: string[]): Array<ImplementerCase | ReviewerCase> {
  const dir = path.join(suiteDir, role);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  const out: Array<ImplementerCase | ReviewerCase> = [];
  for (const entry of names) {
    const full = path.join(dir, entry);
    if (role === "implementer") {
      if (!fs.statSync(full).isDirectory()) continue;
      if (only?.length && !only.includes(entry)) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(full, "eval.json"), "utf8")) as { test?: string };
      if (!fs.existsSync(path.join(full, "repo")) || !fs.existsSync(path.join(full, "hidden"))) continue;
      out.push({ kind: "implementer", name: entry, dir: full, task: fs.readFileSync(path.join(full, "task.md"), "utf8").trim(), test: meta.test ?? "node --test hidden/" });
    } else {
      if (!entry.endsWith(".json")) continue;
      const name = entry.slice(0, -5);
      if (only?.length && !only.includes(name)) continue;
      const c = JSON.parse(fs.readFileSync(full, "utf8")) as { diff?: string; expected?: string; note?: string };
      if (typeof c.diff !== "string" || (c.expected !== "OPEN" && c.expected !== "CLEAN")) continue;
      out.push({ kind: "reviewer", name, diff: c.diff, expected: c.expected, ...(c.note ? { note: c.note } : {}) });
    }
  }
  if (out.length === 0) throw new Error(`No ${role} eval cases found in ${dir}`);
  return out;
}

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** Copies the fixture repo (without hidden tests) into a fresh git repo. */
export function prepareWorkspace(c: ImplementerCase, parent = os.tmpdir()): string {
  const ws = fs.mkdtempSync(path.join(parent, `ai-ship-eval-${c.name}-`));
  fs.cpSync(path.join(c.dir, "repo"), ws, { recursive: true });
  git(ws, ["init", "-q"]);
  git(ws, ["add", "-A"]);
  git(ws, ["-c", "user.name=ai-ship-eval", "-c", "user.email=eval@localhost", "commit", "-q", "-m", "fixture"]);
  return ws;
}

/** Copies the hidden tests in AFTER the agent finished (overwriting any agent file at those paths) and runs them. */
export function runHiddenTests(c: ImplementerCase, ws: string, timeoutMs = 120_000): { pass: boolean; output: string } {
  const hiddenDest = path.join(ws, "hidden");
  fs.rmSync(hiddenDest, { recursive: true, force: true });
  fs.cpSync(path.join(c.dir, "hidden"), hiddenDest, { recursive: true });
  // Never inherit NODE_TEST_CONTEXT: under it a child `node --test` reports success even when tests fail.
  const { NODE_TEST_CONTEXT: _ntc, ...env } = process.env;
  const r = spawnSync(c.test, { cwd: ws, shell: true, encoding: "utf8", timeout: timeoutMs, env });
  return { pass: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-4000) };
}

export const IMPLEMENTER_EVAL_PROMPT = (task: string) =>
  `${task}\n\nWork only in this repository. Edit the source files to complete the task. Do not create a "hidden" directory. When done, reply with a one-paragraph summary.`;

export const REVIEWER_EVAL_PROMPT = (diff: string) =>
  `Review this diff for correctness and security bugs. List concrete findings (or "No findings"), then end with a final line that is exactly \`VERDICT: CLEAN\` or \`VERDICT: OPEN\` (OPEN only for a real bug).\n\n\`\`\`diff\n${diff}\n\`\`\``;

function costOf(res: PromptResult | undefined): number {
  return res?.usage?.costUsd ?? 0;
}

export interface RunEvalOptions {
  role: EvalRole;
  model: string;
  n?: number;
  suiteDir?: string;
  only?: string[];
  /** Builds a runner rooted at `dir` whose `role` runs on `model`. */
  makeRunner: (dir: string, role: AgentRole, model: string) => Promise<PipelineRunner>;
  now?: () => number;
  onCase?: (r: CaseResult) => void;
  /** Record spend in the budget ledger (default true). */
  ledger?: boolean;
  /** Stop starting new cases once this much (USD) has been spent. */
  maxCostUsd?: number;
}

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const n = Math.max(1, Math.min(10, Math.floor(opts.n ?? 1)));
  const now = opts.now ?? Date.now;
  const cases = loadSuite(opts.role, opts.suiteDir, opts.only);
  const results: CaseResult[] = [];
  let spent = 0;
  const record = (stage: string, res: PromptResult | undefined) => {
    if (opts.ledger === false || !res?.usage) return;
    try {
      appendLedger({
        ts: new Date().toISOString(),
        taskId: `eval:${opts.role}:${opts.model}`,
        repo: "(eval)",
        stage,
        model: opts.model,
        input: res.usage.input,
        output: res.usage.output,
        cacheRead: res.usage.cacheRead ?? 0,
        costUsd: res.usage.costUsd ?? 0,
        ...(res.usage.costSource ? { costSource: res.usage.costSource } : {}),
      });
    } catch {
      // ledger is best effort here
    }
  };
  outer: for (let attempt = 1; attempt <= n; attempt++) {
    for (const c of cases) {
      if (opts.maxCostUsd !== undefined && spent >= opts.maxCostUsd) break outer;
      const t0 = now();
      let res: PromptResult | undefined;
      let r: CaseResult;
      if (c.kind === "implementer") {
        const ws = prepareWorkspace(c);
        let runner: PipelineRunner | undefined;
        try {
          runner = await opts.makeRunner(ws, "implementer", opts.model);
          const sid = await runner.createSession(`eval: ${c.name}`);
          res = await runner.prompt(sid, "implementer", IMPLEMENTER_EVAL_PROMPT(c.task));
          const t = runHiddenTests(c, ws);
          r = { name: c.name, attempt, pass: t.pass, costUsd: costOf(res), latencyMs: now() - t0, ...(t.pass ? {} : { error: t.output.slice(-500) }) };
        } catch (err) {
          r = { name: c.name, attempt, pass: false, costUsd: costOf(res), latencyMs: now() - t0, error: (err as Error).message.slice(0, 500) };
        } finally {
          runner?.close();
          fs.rmSync(ws, { recursive: true, force: true });
        }
      } else {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), `ai-ship-eval-review-`));
        let runner: PipelineRunner | undefined;
        try {
          runner = await opts.makeRunner(ws, "reviewer", opts.model);
          const sid = await runner.createSession(`eval: ${c.name}`);
          res = await runner.prompt(sid, "reviewer", REVIEWER_EVAL_PROMPT(c.diff));
          const verdict = parseVerdict(res.text);
          r = { name: c.name, attempt, pass: verdict === c.expected, verdict, expected: c.expected, costUsd: costOf(res), latencyMs: now() - t0 };
        } catch (err) {
          r = { name: c.name, attempt, pass: false, expected: c.expected, costUsd: costOf(res), latencyMs: now() - t0, error: (err as Error).message.slice(0, 500) };
        } finally {
          runner?.close();
          fs.rmSync(ws, { recursive: true, force: true });
        }
      }
      record(`eval:${c.name}`, res);
      spent += r.costUsd;
      results.push(r);
      opts.onCase?.(r);
    }
  }
  const report: EvalReport = {
    ts: new Date(now()).toISOString(),
    model: opts.model,
    role: opts.role,
    n,
    cases: results,
    passRate: results.length ? results.filter((r) => r.pass).length / results.length : 0,
    costUsd: results.reduce((a, r) => a + r.costUsd, 0),
    avgLatencyMs: results.length ? Math.round(results.reduce((a, r) => a + r.latencyMs, 0) / results.length) : 0,
  };
  if (opts.role === "reviewer") {
    const tp = results.filter((r) => r.expected === "OPEN" && r.verdict === "OPEN").length;
    const fn = results.filter((r) => r.expected === "OPEN" && r.verdict !== "OPEN").length;
    const fp = results.filter((r) => r.expected === "CLEAN" && r.verdict === "OPEN").length;
    report.recall = tp + fn ? tp / (tp + fn) : 0;
    report.precision = tp + fp ? tp / (tp + fp) : 0;
  }
  return report;
}

export function saveEvalReport(report: EvalReport, dir = getEvalsDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  const safe = report.model.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const file = path.join(dir, `${report.ts.replace(/[:.]/g, "-")}-${report.role}-${safe}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
  return file;
}

/** Latest saved report per (role, model). */
export function latestEvalReports(dir = getEvalsDir()): EvalReport[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const latest = new Map<string, EvalReport>();
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as EvalReport;
      if (typeof r.model !== "string" || typeof r.role !== "string") continue;
      latest.set(`${r.role}:${r.model}`, r);
    } catch {
      // skip corrupt report
    }
  }
  return [...latest.values()];
}

export function formatEvalReport(r: EvalReport): string[] {
  const lines = [
    `Eval ${r.role} ${r.model}: ${Math.round(r.passRate * 100)}% pass (${r.cases.filter((c) => c.pass).length}/${r.cases.length}), $${r.costUsd.toFixed(4)}, avg ${(r.avgLatencyMs / 1000).toFixed(1)}s`,
  ];
  if (r.recall !== undefined) lines.push(`  OPEN recall ${Math.round(r.recall * 100)}%, precision ${Math.round((r.precision ?? 0) * 100)}%`);
  for (const c of r.cases) lines.push(`  ${c.pass ? "PASS" : "FAIL"} ${c.name}#${c.attempt}${c.verdict ? ` (${c.verdict}, expected ${c.expected})` : ""}${c.error ? ` — ${c.error.split("\n")[0].slice(0, 120)}` : ""}`);
  return lines;
}
