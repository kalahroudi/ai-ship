import fs from "node:fs";
import path from "node:path";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import {
  DEFAULT_CONTEXT_LIMITS,
  DEFAULT_CONTEXT_LENS_URL,
  loadRepoConfig,
  type ModelRef,
  type RepoConfig,
} from "./config.ts";
import {
  abortRebase,
  commitAll,
  createWorktree,
  getDiff,
  getDiffStat,
  isRebaseInProgress,
  openExistingWorktree,
  pushAndOpenPR,
  rebaseOntoBase,
  runShell,
  type WorktreeHandle,
} from "./git.ts";
import { buildDreamPrompt, getMemoryPath, readMemory, writeConsolidatedMemory } from "./memory.ts";
import { assertWorktreeSafe, formatSafetyFindings, scanWorktreeSafety } from "./safety.ts";
import {
  assertProtectedPathsUnchanged,
  CHECKPOINT_PREFIX,
  createCheckpoint,
  DEFAULT_PROTECTED_PATHS,
  enforceTesterScope,
  excludeFileDigest,
  resolveRunStartRef,
  restoreTamperedFiles,
  snapshotFiles,
  snapshotIgnoredProtectedFiles,
  squashCheckpoints,
  type FileSnapshot,
} from "./integrity.ts";
import {
  buildOpencodeProviderConfig,
  collectRecentTranscripts,
  createOpencodeClientRunner,
  createRunner,
  DEFAULT_CLAUDE_MODEL,
  parseUsageSummary,
  type OpencodeClient,
  type AgentRole,
  type PipelineRunner,
  type PromptOptions,
  type PromptResult,
  type PromptUsage,
  type ProviderName,
} from "./runner.ts";

export interface PipelineOptions {
  repoDir: string;
  task: string;
  openPr: boolean;
  draft?: boolean;
  worktreeDir?: string;
  skipTests?: boolean;
  skipReview?: boolean;
  skipBughunter?: boolean;
  provider?: ProviderName;
  model?: string;
  serverUrl?: string;
  contextLens?: boolean | string;
  /** Allow agents to change protected verify/config files (see DEFAULT_PROTECTED_PATHS). */
  allowConfigChange?: boolean;
  client?: OpencodeClient;
  onProgress?: (stage: string) => void;
}

export interface BughunterFinding {
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  location: string;
  boundary: string;
  status: "CONFIRMED" | "REJECTED";
  reason: string;
}

export interface PipelineResult {
  repoDir: string;
  worktreeDir: string;
  branch: string;
  baseBranch: string;
  provider: ProviderName;
  committed: boolean;
  diffStat?: string;
  implSummary?: string;
  verifyCommands: string[];
  reviewVerdicts: Array<{ lens: string; verdict: "CLEAN" | "OPEN" }>;
  bughunterFindings?: BughunterFinding[];
  prUrl?: string;
  usageLog: string[];
  stageUsage?: StageUsageSummary[];
  totalUsage?: UsageTotals;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  totalTokens: number;
  costUsd: number;
  cacheHitRatio: number;
}

export interface StageUsageSummary extends UsageTotals {
  stage: string;
  calls: number;
}

/** Computes prompt cache-hit ratio as `cacheRead / (input + cacheRead)` in `[0, 1]`. */
export function computeCacheHitRatio(input: number, cacheRead: number): number {
  const denominator = input + cacheRead;
  return denominator > 0 ? cacheRead / denominator : 0;
}

function formatCacheHitPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatStageTelemetryLines(
  stages: StageUsageSummary[],
  totals?: UsageTotals
): string[] {
  if (stages.length === 0 && !totals) return [];
  const lines: string[] = [];
  if (stages.length > 0) {
    lines.push("  [Stage Totals]");
    for (const s of stages) {
      const callLabel = s.calls === 1 ? "1 call" : `${s.calls} calls`;
      const ratio = s.cacheHitRatio ?? computeCacheHitRatio(s.input, s.cacheRead);
      lines.push(
        `    ${s.stage}: in=${s.input} out=${s.output} cache_read=${s.cacheRead} cache_hit=${formatCacheHitPercent(ratio)} total=${s.totalTokens} | $${s.costUsd.toFixed(4)} (${callLabel})`
      );
    }
  }
  if (totals) {
    const ratio = totals.cacheHitRatio ?? computeCacheHitRatio(totals.input, totals.cacheRead);
    lines.push(
      `  [Task Total] in=${totals.input} out=${totals.output} cache_read=${totals.cacheRead} total=${totals.totalTokens} | $${totals.costUsd.toFixed(4)} (cache_hit=${formatCacheHitPercent(ratio)})`
    );
  }
  return lines;
}

export class BudgetExceededError extends Error {
  readonly totals: UsageTotals;
  readonly stageBreakdown: StageUsageSummary[];
  readonly nextStage: string;

  constructor(
    message: string,
    details: {
      totals: UsageTotals;
      stageBreakdown: StageUsageSummary[];
      nextStage: string;
    }
  ) {
    super(message);
    this.name = "BudgetExceededError";
    this.totals = details.totals;
    this.stageBreakdown = details.stageBreakdown;
    this.nextStage = details.nextStage;
  }
}

/** Tracks per-stage and per-task token/USD usage and trips when configured thresholds are reached. */
export class BudgetTracker {
  private readonly maxTaskCostUsd?: number;
  private readonly maxTaskTokens?: number;
  private readonly totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    totalTokens: 0,
    costUsd: 0,
    cacheHitRatio: 0,
  };
  private readonly stages = new Map<string, StageUsageSummary>();

  constructor(limits: { maxTaskCostUsd?: number; maxTaskTokens?: number }) {
    this.maxTaskCostUsd =
      typeof limits.maxTaskCostUsd === "number" && limits.maxTaskCostUsd > 0
        ? limits.maxTaskCostUsd
        : undefined;
    this.maxTaskTokens =
      typeof limits.maxTaskTokens === "number" && limits.maxTaskTokens > 0
        ? limits.maxTaskTokens
        : undefined;
  }

  record(stage: string, res: PromptResult): void {
    const u: PromptUsage = res.usage ??
      parseUsageSummary(res.usageSummary) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        costUsd: 0,
      };
    const tokens = u.input + u.output + u.cacheRead;

    this.totals.input += u.input;
    this.totals.output += u.output;
    this.totals.cacheRead += u.cacheRead;
    this.totals.totalTokens += tokens;
    this.totals.costUsd += u.costUsd;
    this.totals.cacheHitRatio = computeCacheHitRatio(this.totals.input, this.totals.cacheRead);

    const existing = this.stages.get(stage);
    if (existing) {
      existing.input += u.input;
      existing.output += u.output;
      existing.cacheRead += u.cacheRead;
      existing.totalTokens += tokens;
      existing.costUsd += u.costUsd;
      existing.calls += 1;
      existing.cacheHitRatio = computeCacheHitRatio(existing.input, existing.cacheRead);
    } else {
      this.stages.set(stage, {
        stage,
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        totalTokens: tokens,
        costUsd: u.costUsd,
        cacheHitRatio: computeCacheHitRatio(u.input, u.cacheRead),
        calls: 1,
      });
    }
  }

  assertWithinBudget(nextStage: string): void {
    const costExceeded =
      this.maxTaskCostUsd !== undefined && this.totals.costUsd >= this.maxTaskCostUsd;
    const tokensExceeded =
      this.maxTaskTokens !== undefined && this.totals.totalTokens >= this.maxTaskTokens;
    if (!costExceeded && !tokensExceeded) return;

    const reasons: string[] = [];
    if (costExceeded && this.maxTaskCostUsd !== undefined) {
      reasons.push(
        `task cost $${this.totals.costUsd.toFixed(4)} >= maxTaskCostUsd $${this.maxTaskCostUsd.toFixed(4)}`
      );
    }
    if (tokensExceeded && this.maxTaskTokens !== undefined) {
      reasons.push(`task tokens ${this.totals.totalTokens} >= maxTaskTokens ${this.maxTaskTokens}`);
    }

    const stageBreakdown = this.getStageSummaries();
    const breakdownLines = stageBreakdown.map(
      (s) =>
        `  - ${s.stage}: $${s.costUsd.toFixed(4)} (in=${s.input} out=${s.output} cache_read=${s.cacheRead} total=${s.totalTokens}, calls=${s.calls})`
    );
    const message = [
      `Budget exceeded before "${nextStage}": ${reasons.join(" and ")}.`,
      ...(breakdownLines.length ? ["Per-stage totals:", ...breakdownLines] : []),
    ].join("\n");

    throw new BudgetExceededError(message, {
      totals: this.getTotals(),
      stageBreakdown,
      nextStage,
    });
  }

  getTotals(): UsageTotals {
    return {
      ...this.totals,
      cacheHitRatio: computeCacheHitRatio(this.totals.input, this.totals.cacheRead),
    };
  }

  getStageSummaries(): StageUsageSummary[] {
    return Array.from(this.stages.values()).map((s) => ({
      ...s,
      cacheHitRatio: computeCacheHitRatio(s.input, s.cacheRead),
    }));
  }

  formatSummaryLines(): string[] {
    const stages = this.getStageSummaries();
    if (stages.length === 0) return [];
    return formatStageTelemetryLines(stages, this.getTotals());
  }
}

function truncateCleanly(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const slice = trimmed.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > maxChars * 0.6) {
    return `${slice.slice(0, lastNewline).trimEnd()}\n\n*(truncated)*`;
  }
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

export function buildPrBody(opts: {
  task: string;
  provider: ProviderName;
  implSummary: string;
  diffStat: string;
  verifyCommands: string[];
  adversarialTestsRan: boolean;
  reviewVerdicts: Array<{ lens: string; verdict: "CLEAN" | "OPEN" }>;
}): string {
  const sections: string[] = [
    "## Summary",
    opts.task.trim(),
  ];

  if (opts.implSummary.trim()) {
    sections.push("", "### Implementation Notes", truncateCleanly(opts.implSummary, 4000));
  }

  if (opts.diffStat.trim()) {
    sections.push("", "## Changed Files", "```text", opts.diffStat.trim(), "```");
  }

  const verifyLines = opts.verifyCommands.length
    ? opts.verifyCommands.map((c) => `- [x] \`${c}\``)
    : ["- (none configured)"];
  verifyLines.push(
    opts.adversarialTestsRan
      ? "- [x] Independent adversarial tests (Stage 2)"
      : "- [ ] Independent adversarial tests (skipped)"
  );
  sections.push("", "## Verification", ...verifyLines);

  const reviewLines = opts.reviewVerdicts.length
    ? opts.reviewVerdicts.map((r) => `- **${r.lens}:** ${r.verdict}`)
    : ["- (skipped)"];
  sections.push("", "## Multi-Lens Review", ...reviewLines);

  sections.push("", `---`, `*Automated via \`ai-ship\` (${opts.provider}).*`);
  return sections.join("\n");
}

function formatUsage(label: string, res: PromptResult): string {
  const usage = res.usage ?? parseUsageSummary(res.usageSummary);
  if (usage && !res.usageSummary.includes("cache_hit=")) {
    const ratio = computeCacheHitRatio(usage.input, usage.cacheRead);
    return `  [${label}] ${res.usageSummary} (cache_hit=${formatCacheHitPercent(ratio)})`;
  }
  return `  [${label}] ${res.usageSummary}`;
}

function recordUsage(
  usageLog: string[],
  label: string,
  res: PromptResult,
  budget?: BudgetTracker,
  stageKey?: string
): void {
  usageLog.push(formatUsage(label, res));
  if (res.fallback) {
    const line = `  [${label} Fallback] ${res.fallback.from} -> ${res.fallback.to} (${res.fallback.reason})`;
    console.log(line);
    usageLog.push(line);
  }
  budget?.record(stageKey ?? label, res);
}

/** Worktree-relative path of the shared review context (excluded from git via info/exclude). */
export const SHARED_CONTEXT_RELATIVE_PATH = ".ai-ship/shared-context.txt";

/**
 * Writes the shared reviewer context into the worktree for the duration of `fn` and always removes it,
 * even when a reviewer throws, so it can never be committed.
 */
export async function withSharedContext<T>(
  worktreeDir: string,
  content: string,
  fn: () => Promise<T>
): Promise<T> {
  const sharedContextPath = path.join(worktreeDir, SHARED_CONTEXT_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(sharedContextPath), { recursive: true });
  fs.writeFileSync(sharedContextPath, `${content}\n`, "utf8");
  try {
    return await fn();
  } finally {
    fs.rmSync(sharedContextPath, { force: true });
    try {
      fs.rmdirSync(path.dirname(sharedContextPath));
    } catch {
      // directory not empty or already gone
    }
  }
}

export const IMPLEMENTER_STATIC_INSTRUCTIONS = [
  "Instructions:",
  "- Work inside the current repository.",
  "- Read AGENTS.md if it exists.",
  "- Make clean, minimal, production-ready changes.",
  "- Prefer minimal, targeted diff/patch edits rather than full-file rewrites.",
  "- Never hardcode or commit deployment config IDs (e.g. wrangler account_id, database_id, zone_id, kv id), secrets, API keys, emails, or real account/org/user IDs.",
  "- Run relevant local checks before finishing.",
].join("\n");

export const TESTER_STATIC_INSTRUCTIONS = [
  "You are an independent adversarial tester. You did NOT write the implementation.",
  "Review the diff below and write focused tests covering:",
  "1. Security & auth/tenant isolation (IDOR, missing auth, input validation, injection).",
  "2. Edge cases, failure modes, and race conditions.",
  "3. Performance regressions (e.g., unbounded queries, N+1 loops).",
  "",
  "Only create or update test files. Do NOT modify production source files.",
].join("\n");

export const REVIEWER_STATIC_INSTRUCTIONS = [
  `Read ${SHARED_CONTEXT_RELATIVE_PATH} in the repo root.`,
  "Report ONLY concrete, reproducible high/critical issues with exact file paths, line numbers, and how to reproduce.",
  "End with `VERDICT: CLEAN` or `VERDICT: OPEN`.",
].join("\n");

export const BUGHUNTER_HUNTER_STATIC_INSTRUCTIONS = [
  "You are an adversarial Bug Hunter (read-only). Your job is to hypothesize subtle cross-boundary bugs introduced or exposed by the diff.",
  "Inspect callers, callees, shared state, auth/validation boundaries, schema/type contracts, and error propagation across files.",
  "For each hypothesis, emit a numbered block:",
  "BUG-1: <short title>",
  "- Location: <file:line>",
  "- Boundary: <caller -> callee or module A -> module B>",
  "- Trigger: <concrete input or sequence>",
  "- Impact: <failure mode or security/data corruption impact>",
  "If you find no credible cross-boundary bugs, output `NO_HYPOTHESES` and `VERDICT: CLEAN`.",
].join("\n");

export const BUGHUNTER_SKEPTIC_STATIC_INSTRUCTIONS = [
  "You are an adversarial Skeptic (read-only). Challenge every bug hypothesis from the Hunter.",
  "Verify against the actual code and diff whether existing guards, types, invariants, or caller preconditions already prevent the bug.",
  "For each BUG-N, output:",
  "CHALLENGE BUG-N: REFUTE | CONCEDE",
  "- Evidence: <exact file:line, guard, or why the trigger is/isn't reachable>",
].join("\n");

export const BUGHUNTER_REFEREE_STATIC_INSTRUCTIONS = [
  "You are the Referee (read-only). Weigh the Hunter's hypotheses against the Skeptic's challenges and emit a final structured verdict.",
  "Filter out false positives refuted by the Skeptic. Confirm only concrete, reproducible cross-boundary bugs.",
  "For each hypothesis, emit one line in this exact format:",
  "FINDING BUG-N | CONFIRMED | CRITICAL | <file:line> | <boundary> | <concise root cause & fix>",
  "(Use CONFIRMED or REJECTED, and severity CRITICAL, HIGH, MEDIUM, or LOW.)",
  "End with `VERDICT: OPEN` if any finding is CONFIRMED, or `VERDICT: CLEAN` if none are confirmed.",
].join("\n");

/** Builds a prompt-cache-safe implementer prompt with static instructions first and dynamic task/memory at the end. */
export function buildImplementerPrompt(task: string, memory?: string): string {
  const parts = [IMPLEMENTER_STATIC_INSTRUCTIONS, "", `Task: ${task}`];
  if (memory?.trim()) {
    parts.push("", `## Persistent Repository Memory\n${memory.trim()}`);
  }
  return parts.join("\n");
}

/** Builds a prompt-cache-safe tester prompt with static instructions first and dynamic context at the end. */
export function buildTesterPrompt(opts: {
  task: string;
  diff: string;
  memory?: string;
}): string {
  const parts = [TESTER_STATIC_INSTRUCTIONS, "", `Task Intent: ${opts.task}`];
  if (opts.memory?.trim()) {
    parts.push("", `## Persistent Repository Memory\n${opts.memory.trim()}`);
  }
  parts.push("", "Diff:", "```diff", opts.diff, "```");
  return parts.join("\n");
}

/** Builds a prompt-cache-safe reviewer lens prompt with static instructions first and lens focus at the end. */
export function buildReviewerLensPrompt(lens: ReviewLens): string {
  return [
    REVIEWER_STATIC_INSTRUCTIONS,
    "",
    `Review lens: ${lens.name}`,
    `Focus strictly on: ${lens.focus}.`,
  ].join("\n");
}

/** Builds a prompt-cache-safe Hunter prompt with static instructions first and dynamic task/diff at the end. */
export function buildBughunterHunterPrompt(opts: {
  task: string;
  diff: string;
  memory?: string;
}): string {
  const parts = [BUGHUNTER_HUNTER_STATIC_INSTRUCTIONS, "", `Task: ${opts.task}`];
  if (opts.memory?.trim()) {
    parts.push("", `## Persistent Repository Memory\n${opts.memory.trim()}`);
  }
  parts.push("", "Diff:", "```diff", opts.diff, "```");
  return parts.join("\n");
}

/** Builds a prompt-cache-safe Skeptic prompt with static instructions first and Hunter output + diff at the end. */
export function buildBughunterSkepticPrompt(opts: {
  hunterFindings: string;
  diff: string;
}): string {
  return [
    BUGHUNTER_SKEPTIC_STATIC_INSTRUCTIONS,
    "",
    "Hunter Hypotheses:",
    opts.hunterFindings,
    "",
    "Diff:",
    "```diff",
    opts.diff,
    "```",
  ].join("\n");
}

/** Builds a prompt-cache-safe Referee prompt with static instructions first and Hunter + Skeptic outputs at the end. */
export function buildBughunterRefereePrompt(opts: {
  hunterFindings: string;
  skepticChallenges: string;
}): string {
  return [
    BUGHUNTER_REFEREE_STATIC_INSTRUCTIONS,
    "",
    "Hunter Hypotheses:",
    opts.hunterFindings,
    "",
    "Skeptic Challenges:",
    opts.skepticChallenges,
  ].join("\n");
}

export interface ReviewLens {
  name: string;
  focus: string;
}

/** Resolves an optional per-lens model override from `config.reviewerLensModels`. */
export function resolveLensModel(config: RepoConfig, lensName: string): ModelRef | undefined {
  const map = config.reviewerLensModels;
  if (!map) return undefined;
  if (map[lensName]) return map[lensName];
  const lower = lensName.toLowerCase();
  for (const [key, val] of Object.entries(map)) {
    if (key.toLowerCase() === lower) return val;
  }
  return undefined;
}

/**
 * Runs Stage 4 review lenses with optional per-lens model/provider routing and
 * lightweight concurrency pacing (staggering same-provider launches to avoid 429 bursts).
 */
export async function runReviewLenses(opts: {
  lenses: ReviewLens[];
  config: RepoConfig;
  runner: PipelineRunner;
  usageLog: string[];
  budget?: BudgetTracker;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Array<{ lens: string; text: string; verdict: "CLEAN" | "OPEN" }>> {
  const staggerMs = Math.max(0, opts.config.reviewStaggerMs ?? 250);
  const concurrency = Math.max(1, opts.config.reviewConcurrency ?? opts.lenses.length);
  const sleepFn =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const providerCounts = new Map<string, number>();
  const launchPlan = opts.lenses.map((lens) => {
    const lensModel = resolveLensModel(opts.config, lens.name);
    const effectiveProvider =
      lensModel?.providerID ??
      opts.config.reviewerModel?.providerID ??
      opts.config.defaultProvider ??
      "default";
    const sameProviderIdx = providerCounts.get(effectiveProvider) ?? 0;
    providerCounts.set(effectiveProvider, sameProviderIdx + 1);
    return {
      lens,
      modelOverride: lensModel
        ? { providerID: lensModel.providerID, modelID: lensModel.id }
        : undefined,
      delayMs: sameProviderIdx * staggerMs,
    };
  });

  const results: Array<{ lens: string; text: string; verdict: "CLEAN" | "OPEN" }> = new Array(
    launchPlan.length
  );
  let nextIdx = 0;

  const worker = async () => {
    while (nextIdx < launchPlan.length) {
      const idx = nextIdx++;
      const item = launchPlan[idx];
      opts.budget?.assertWithinBudget(`Stage 4: ${item.lens.name} Lens`);
      if (item.delayMs > 0) {
        await sleepFn(item.delayMs);
      }
      const sid = await opts.runner.createSession(`Review (${item.lens.name})`);
      const r = await opts.runner.prompt(
        sid,
        "reviewer",
        buildReviewerLensPrompt(item.lens),
        item.modelOverride ? { modelOverride: item.modelOverride } : undefined
      );
      const label = `Stage 4: ${item.lens.name} Lens`;
      recordUsage(opts.usageLog, label, r, opts.budget, "Stage 4: Review");
      const resolved = await resolveVerdictWithReask({
        runner: opts.runner,
        sessionId: sid,
        role: "reviewer",
        label,
        text: r.text,
        usageLog: opts.usageLog,
        budget: opts.budget,
        stageKey: "Stage 4: Review",
        promptOptions: item.modelOverride ? { modelOverride: item.modelOverride } : undefined,
      });
      results[idx] = { lens: item.lens.name, text: resolved.text, verdict: resolved.verdict };
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, launchPlan.length) }, () => worker()));
  return results;
}

async function runDeterministicVerify(
  worktreeDir: string,
  config: RepoConfig
): Promise<{ ok: boolean; failedCommand?: string; output: string }> {
  const logs: string[] = [];
  const verifyOutputMaxChars =
    config.contextLimits?.verifyOutputMaxChars ?? DEFAULT_CONTEXT_LIMITS.verifyOutputMaxChars;

  if (config.safetyCheck !== false) {
    console.log("  -> running: ai-ship safety-check (secrets, deployment config, keys, emails, IDs)");
    const safety = scanWorktreeSafety(worktreeDir, {
      baseBranch: config.baseBranch,
      allowlist: config.safetyAllowlist,
    });
    const safetyOut = formatSafetyFindings(safety.findings);
    logs.push(`$ ai-ship safety-check\n${safetyOut}`);
    if (!safety.ok) {
      return {
        ok: false,
        failedCommand: "ai-ship safety-check",
        output: safetyOut.slice(-verifyOutputMaxChars),
      };
    }
  }

  if (config.verify.length === 0) {
    return { ok: true, output: logs.join("\n\n") || "No verify commands configured or detected." };
  }
  for (const cmd of config.verify) {
    console.log(`  -> running: ${cmd}`);
    const res = runShell(cmd, worktreeDir);
    logs.push(`$ ${cmd}\n${res.output}`);
    if (!res.ok) {
      return {
        ok: false,
        failedCommand: cmd,
        output: res.output.slice(-verifyOutputMaxChars),
      };
    }
  }
  return { ok: true, output: logs.join("\n\n") };
}

export type ParsedVerdict = "CLEAN" | "OPEN" | "MISSING";

// The whole line must be the verdict: only markdown emphasis/punctuation may follow the token, so
// "VERDICT: CLEAN or VERDICT: OPEN" or "VERDICT: CLEAN if X is fixed" are MISSING (and get re-asked).
const VERDICT_LINE_RE = /^[\s>*_`#-]*VERDICT[*_`]*\s*:\s*[*_`]*\s*(CLEAN|OPEN)[\s*_`.!]*$/gim;

/**
 * Returns the verdict from the LAST line that consists only of `VERDICT: CLEAN|OPEN` (markdown emphasis allowed).
 * Never guesses: text without such a line is "MISSING", so callers can re-ask and fail closed.
 */
export function parseVerdict(text: string): ParsedVerdict {
  let last: string | undefined;
  for (const m of text.matchAll(VERDICT_LINE_RE)) last = m[1];
  return last ? (last.toUpperCase() as "CLEAN" | "OPEN") : "MISSING";
}

export const VERDICT_REASK_PROMPT =
  "Your previous reply did not end with a verdict line. Reply with your findings (or 'No findings') and a final line that is exactly `VERDICT: CLEAN` or `VERDICT: OPEN`.";

/**
 * Ensures a reviewer reply carries an explicit verdict: re-asks once in the same session when it is missing,
 * and fails closed (OPEN) if the verdict is still missing after the re-ask.
 */
export async function resolveVerdictWithReask(opts: {
  runner: PipelineRunner;
  sessionId: string;
  role: AgentRole;
  label: string;
  text: string;
  usageLog: string[];
  budget?: BudgetTracker;
  stageKey: string;
  promptOptions?: PromptOptions;
  parse?: (text: string) => ParsedVerdict;
  reaskPrompt?: string;
}): Promise<{ verdict: "CLEAN" | "OPEN"; text: string; missing: boolean }> {
  const parse = opts.parse ?? parseVerdict;
  const first = parse(opts.text);
  if (first !== "MISSING") return { verdict: first, text: opts.text, missing: false };

  opts.usageLog.push(`  [${opts.label}] verdict missing; re-asking once`);
  opts.budget?.assertWithinBudget(`${opts.label} (verdict re-ask)`);
  const retry = await opts.runner.prompt(
    opts.sessionId,
    opts.role,
    opts.reaskPrompt ?? VERDICT_REASK_PROMPT,
    opts.promptOptions
  );
  recordUsage(opts.usageLog, `${opts.label} (re-ask)`, retry, opts.budget, opts.stageKey);
  const second = parse(retry.text);
  const combined = [opts.text, retry.text].filter((t) => t.trim()).join("\n\n");
  if (second !== "MISSING") return { verdict: second, text: combined, missing: false };

  opts.usageLog.push(`  [${opts.label}] verdict still missing after re-ask; failing closed (OPEN: no verdict)`);
  return {
    verdict: "OPEN",
    text: `${combined}\n\n(ai-ship: no verdict returned after re-ask; treated as OPEN)`.trim(),
    missing: true,
  };
}

const BUGHUNTER_FINDING_RE =
  /^(?:[-*]\s*)?`?FINDING\s+([A-Za-z0-9_-]+)\s*\|\s*(CONFIRMED|REJECTED)\s*\|\s*(CRITICAL|HIGH|MEDIUM|LOW)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+?)`?$/i;

/** Parses structured Referee findings and overall verdict from Bughunter output. */
export function parseBughunterVerdict(text: string): {
  verdict: "CLEAN" | "OPEN";
  findings: BughunterFinding[];
} {
  const findings: BughunterFinding[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(BUGHUNTER_FINDING_RE);
    if (!m) continue;
    findings.push({
      id: m[1].trim(),
      status: m[2].toUpperCase() as "CONFIRMED" | "REJECTED",
      severity: m[3].toUpperCase() as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      location: m[4].trim(),
      boundary: m[5].trim(),
      reason: m[6].trim(),
    });
  }

  const hasConfirmed = findings.some((f) => f.status === "CONFIRMED");
  if (hasConfirmed) {
    return { verdict: "OPEN", findings };
  }
  const explicit = parseVerdict(text);
  // Fail closed: without an explicit final verdict line the Referee result is OPEN.
  return { verdict: explicit === "CLEAN" ? "CLEAN" : "OPEN", findings };
}

/** Referee verdict for re-ask purposes: a CONFIRMED finding counts as OPEN, otherwise the explicit verdict line. */
function parseRefereeVerdict(text: string): ParsedVerdict {
  const parsed = parseBughunterVerdict(text);
  if (parsed.findings.some((f) => f.status === "CONFIRMED")) return "OPEN";
  return parseVerdict(text);
}

/** Classifies Hunter output: hypotheses to verify, an explicit NO_HYPOTHESES, or unparseable. */
export function classifyHunterOutput(text: string): "HYPOTHESES" | "NONE" | "MISSING" {
  if (/\bBUG-\d+\b/i.test(text)) return "HYPOTHESES";
  if (/^[\s>*_`-]*NO_HYPOTHESES[\s*_`.]*$/m.test(text)) return "NONE";
  return "MISSING";
}

export const HUNTER_REASK_PROMPT =
  "Your previous reply contained neither BUG-N hypothesis blocks nor NO_HYPOTHESES. Reply again using exactly the BUG-N block format, or output `NO_HYPOTHESES` and `VERDICT: CLEAN` if there are no credible cross-boundary bugs.";

/** Formats confirmed Bughunter findings (or fallback Referee text) into markdown for implementer fixes or errors. */
export function formatBughunterFindings(
  findings: BughunterFinding[],
  fallbackText?: string
): string {
  const confirmed = findings.filter((f) => f.status === "CONFIRMED");
  if (confirmed.length === 0) {
    return fallbackText?.trim() ? `### Bughunter Review\n${fallbackText.trim()}` : "";
  }
  const lines = confirmed.map(
    (f) => `- **${f.id} [${f.severity}]** \`${f.location}\` (${f.boundary}): ${f.reason}`
  );
  return `### Bughunter Confirmed Cross-Boundary Bugs\n${lines.join("\n")}`;
}

export interface BughunterResult {
  hunterText: string;
  skepticText: string;
  refereeText: string;
  verdict: "CLEAN" | "OPEN";
  findings: BughunterFinding[];
}

/** Runs the adversarial Hunter -> Skeptic -> Referee verification pass using the read-only `bughunter` role. */
export async function runBughunterPass(opts: {
  task: string;
  diff: string;
  memory?: string;
  runner: PipelineRunner;
  usageLog: string[];
  budget?: BudgetTracker;
}): Promise<BughunterResult> {
  opts.budget?.assertWithinBudget("Stage 4b: Bughunter (Hunter)");
  const hunterSessionId = await opts.runner.createSession("Bughunter: Hunter");
  const hunterRes = await opts.runner.prompt(
    hunterSessionId,
    "bughunter",
    buildBughunterHunterPrompt({
      task: opts.task,
      diff: opts.diff,
      memory: opts.memory,
    })
  );
  recordUsage(
    opts.usageLog,
    "Stage 4b: Bughunter (Hunter)",
    hunterRes,
    opts.budget,
    "Stage 4b: Bughunter"
  );

  let hunterText = hunterRes.text;
  let hunterKind = classifyHunterOutput(hunterText);
  if (hunterKind === "MISSING") {
    opts.usageLog.push("  [Stage 4b: Bughunter (Hunter)] no BUG-N or NO_HYPOTHESES; re-asking once");
    opts.budget?.assertWithinBudget("Stage 4b: Bughunter (Hunter re-ask)");
    const retry = await opts.runner.prompt(hunterSessionId, "bughunter", HUNTER_REASK_PROMPT);
    recordUsage(opts.usageLog, "Stage 4b: Bughunter (Hunter re-ask)", retry, opts.budget, "Stage 4b: Bughunter");
    hunterText = [hunterText, retry.text].filter((t) => t.trim()).join("\n\n");
    hunterKind = classifyHunterOutput(retry.text);
  }
  if (hunterKind === "NONE") {
    return {
      hunterText,
      skepticText: "",
      refereeText: "VERDICT: CLEAN",
      verdict: "CLEAN",
      findings: [],
    };
  }
  if (hunterKind === "MISSING") {
    opts.usageLog.push("  [Stage 4b: Bughunter (Hunter)] still unparseable after re-ask; failing closed (OPEN)");
    return {
      hunterText,
      skepticText: "",
      refereeText:
        "VERDICT: OPEN\n(ai-ship: the Hunter returned neither BUG-N hypotheses nor NO_HYPOTHESES after a re-ask; treated as OPEN)",
      verdict: "OPEN",
      findings: [],
    };
  }

  opts.budget?.assertWithinBudget("Stage 4b: Bughunter (Skeptic)");
  const skepticSessionId = await opts.runner.createSession("Bughunter: Skeptic");
  const skepticRes = await opts.runner.prompt(
    skepticSessionId,
    "bughunter",
    buildBughunterSkepticPrompt({
      hunterFindings: hunterText,
      diff: opts.diff,
    })
  );
  recordUsage(
    opts.usageLog,
    "Stage 4b: Bughunter (Skeptic)",
    skepticRes,
    opts.budget,
    "Stage 4b: Bughunter"
  );

  opts.budget?.assertWithinBudget("Stage 4b: Bughunter (Referee)");
  const refereeSessionId = await opts.runner.createSession("Bughunter: Referee");
  const refereeRes = await opts.runner.prompt(
    refereeSessionId,
    "bughunter",
    buildBughunterRefereePrompt({
      hunterFindings: hunterText,
      skepticChallenges: skepticRes.text,
    })
  );
  recordUsage(
    opts.usageLog,
    "Stage 4b: Bughunter (Referee)",
    refereeRes,
    opts.budget,
    "Stage 4b: Bughunter"
  );

  const referee = await resolveVerdictWithReask({
    runner: opts.runner,
    sessionId: refereeSessionId,
    role: "bughunter",
    label: "Stage 4b: Bughunter (Referee)",
    text: refereeRes.text,
    usageLog: opts.usageLog,
    budget: opts.budget,
    stageKey: "Stage 4b: Bughunter",
    parse: parseRefereeVerdict,
  });
  const parsed = parseBughunterVerdict(referee.text);
  return {
    hunterText,
    skepticText: skepticRes.text,
    refereeText: referee.text,
    verdict: referee.missing ? "OPEN" : parsed.verdict,
    findings: parsed.findings,
  };
}

export function resolveCloudflareGatewayUrl(provider?: string): string | undefined {
  const normalizedProvider = provider?.trim().replace(/^\/+|\/+$/g, "");
  if (process.env.CF_AI_GATEWAY_URL) {
    const base = process.env.CF_AI_GATEWAY_URL.replace(/\/+$/, "");
    if (!normalizedProvider) return base;
    const isBareGateway = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[^/]+\/[^/]+$/i.test(base);
    return isBareGateway ? `${base}/${normalizedProvider}` : base;
  }
  const accountId = process.env.CF_ACCOUNT_ID;
  const gatewayId = process.env.CF_GATEWAY_ID;
  if (accountId && gatewayId) {
    const base = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}`;
    const suffix = normalizedProvider || process.env.CF_GATEWAY_PROVIDER?.trim().replace(/^\/+|\/+$/g, "");
    return suffix ? `${base}/${suffix}` : base;
  }
  return undefined;
}

/**
 * Resolves the Context Lens proxy URL from (in priority order):
 * 1. Explicit CLI/pipeline override (`true` -> default URL, `false` -> disabled, string -> URL)
 * 2. `CONTEXT_LENS_URL` environment variable
 * 3. `RepoConfig.contextLens`
 */
export function resolveContextLensUrl(
  config?: Pick<RepoConfig, "contextLens">,
  override?: boolean | string
): string | undefined {
  const normalize = (value: boolean | string | undefined): string | undefined => {
    if (value === undefined || value === false) return undefined;
    if (value === true) return DEFAULT_CONTEXT_LENS_URL;
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) return undefined;
    const lower = trimmed.toLowerCase();
    if (lower === "false" || lower === "0") return undefined;
    if (lower === "true" || lower === "1") return DEFAULT_CONTEXT_LENS_URL;
    return trimmed;
  };

  if (override !== undefined) return normalize(override);
  const envVal = process.env.CONTEXT_LENS_URL;
  if (envVal !== undefined && envVal.trim() !== "") return normalize(envVal);
  return normalize(config?.contextLens);
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const repoDir = path.resolve(opts.repoDir);
  const config = loadRepoConfig(repoDir);

  // Ensure local node_modules/.bin/opencode is on PATH for createOpencode()
  const localBin = path.resolve(import.meta.dirname, "..", "node_modules", ".bin");
  if (!process.env.PATH?.includes(localBin)) {
    process.env.PATH = `${localBin}:${process.env.PATH ?? ""}`;
  }

  const provider: ProviderName = opts.provider ?? "opencode";
  const cfGatewayUrl = resolveCloudflareGatewayUrl();
  const contextLensUrl = resolveContextLensUrl(config, opts.contextLens);
  console.log(`\n[ai-ship] Repo: ${repoDir} (base: ${config.baseBranch})`);
  console.log(`[ai-ship] Provider: ${provider}${opts.model ? ` (model: ${opts.model})` : provider === "claude-code" ? ` (model: ${DEFAULT_CLAUDE_MODEL})` : ""}`);
  if (provider === "opencode" && cfGatewayUrl) console.log(`[ai-ship] Cloudflare AI Gateway: ${cfGatewayUrl}`);
  if (provider === "opencode" && contextLensUrl) console.log(`[ai-ship] Context Lens Proxy: ${contextLensUrl}`);
  console.log(`[ai-ship] Verify pipeline: ${config.verify.length ? config.verify.join(" && ") : "(none detected)"}`);

  opts.onProgress?.(opts.worktreeDir ? "Opening existing worktree" : "Creating isolated worktree");
  const worktree: WorktreeHandle = opts.worktreeDir
    ? openExistingWorktree(repoDir, config.baseBranch, opts.worktreeDir)
    : createWorktree(repoDir, config.baseBranch, opts.task);
  console.log(`[ai-ship] Worktree: ${worktree.worktreeDir} (branch: ${worktree.branch})`);

  const runner = opts.client
    ? createOpencodeClientRunner({
        client: opts.client,
        worktreeDir: worktree.worktreeDir,
        config,
        model: opts.model,
      })
    : await createRunner({
        provider,
        worktreeDir: worktree.worktreeDir,
        config,
        cfGatewayUrl,
        contextLensUrl,
        model: opts.model,
        serverUrl: opts.serverUrl,
      });
  const usageLog: string[] = [];
  const budget = new BudgetTracker({
    maxTaskCostUsd: config.maxTaskCostUsd,
    maxTaskTokens: config.maxTaskTokens,
  });
  const testDiffMaxChars =
    config.contextLimits?.testDiffMaxChars ?? DEFAULT_CONTEXT_LIMITS.testDiffMaxChars;
  const reviewDiffMaxChars =
    config.contextLimits?.reviewDiffMaxChars ?? DEFAULT_CONTEXT_LIMITS.reviewDiffMaxChars;
  const memoryMaxLines =
    config.contextLimits?.memoryMaxLines ?? DEFAULT_CONTEXT_LIMITS.memoryMaxLines;
  const memory = readMemory(repoDir, memoryMaxLines);
  let reviewVerdicts: Array<{ lens: string; verdict: "CLEAN" | "OPEN" }> = [];
  let bughunterFindings: BughunterFinding[] = [];
  let prUrl: string | undefined;

  // Gate integrity: track this run's starting point, checkpoint each agent's work, and make sure no agent
  // weakens the verify config or edits the tester's tests.
  const protectedPaths = config.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const startRef = resolveRunStartRef(worktree.worktreeDir);
  const excludeDigest = excludeFileDigest(worktree.worktreeDir);
  const ignoredBaseline = snapshotIgnoredProtectedFiles(worktree.worktreeDir, protectedPaths);
  let testerSnapshot: FileSnapshot | undefined;
  let testerRef: string | undefined;
  const integrityLog = (line: string) => {
    console.log(line);
    usageLog.push(line);
  };
  const afterImplementerTurn = (stage: string, sinceRef = startRef, failOnRestore = false) => {
    assertProtectedPathsUnchanged({
      worktreeDir: worktree.worktreeDir,
      sinceRef,
      stage,
      patterns: protectedPaths,
      allow: opts.allowConfigChange,
      excludeDigest,
      ignoredBaseline,
      log: integrityLog,
    });
    if (testerSnapshot && testerRef) {
      const restored = restoreTamperedFiles(worktree.worktreeDir, testerSnapshot, testerRef);
      if (restored.length > 0 && failOnRestore) {
        throw new Error(
          `${stage} modified or deleted tester-authored tests after the final commit (${restored.join(", ")}); refusing to push.`
        );
      }
      if (restored.length > 0) {
        integrityLog(
          `  [integrity] ${stage} modified or deleted tester-authored tests; restored: ${restored.join(", ")}`
        );
      }
    }
  };

  try {
    // -------------------------------------------------------------------------
    // Stage 1: Implementer Session
    // -------------------------------------------------------------------------
    opts.onProgress?.("Stage 1/4: Implementing in isolated worktree");
    console.log("\n[Stage 1/4] Implementing in isolated worktree...");
    const implSessionId = await runner.createSession(`Implement: ${opts.task.slice(0, 60)}`);

    const implRes = await runner.prompt(
      implSessionId,
      "implementer",
      buildImplementerPrompt(opts.task, memory)
    );
    recordUsage(usageLog, "Stage 1: Implement", implRes, budget, "Stage 1: Implement");
    afterImplementerTurn("Stage 1: Implement");
    const stage1Ref = createCheckpoint(worktree.worktreeDir, `${CHECKPOINT_PREFIX} stage 1 (implementer)`);

    // -------------------------------------------------------------------------
    // Stage 2: Independent Adversarial Test Session (Separate Session & Model)
    // -------------------------------------------------------------------------
    if (!opts.skipTests) {
      opts.onProgress?.("Stage 2/4: Independent adversarial tests");
      console.log("\n[Stage 2/4] Independent adversarial test generation (separate session)...");
      const diff = getDiff(worktree.worktreeDir, worktree.baseBranch);
      if (diff.trim()) {
        budget.assertWithinBudget("Stage 2: Adversarial Tests");
        const testSessionId = await runner.createSession(`Adversarial Tests: ${opts.task.slice(0, 50)}`);

        const testRes = await runner.prompt(
          testSessionId,
          "tester",
          buildTesterPrompt({
            task: opts.task,
            diff: diff.slice(0, testDiffMaxChars),
            memory,
          })
        );
        recordUsage(usageLog, "Stage 2: Adversarial Tests", testRes, budget, "Stage 2: Adversarial Tests");

        const scope = enforceTesterScope(worktree.worktreeDir, stage1Ref, protectedPaths);
        if (scope.reverted.length > 0) {
          integrityLog(
            `  [integrity] Tester changed non-test files (reverted): ${scope.reverted.join(", ")}`
          );
        }
        testerRef = createCheckpoint(worktree.worktreeDir, `${CHECKPOINT_PREFIX} stage 2 (tester)`);
        testerSnapshot = snapshotFiles(worktree.worktreeDir, scope.testerFiles);
        if (scope.testerFiles.length > 0) {
          integrityLog(`  [integrity] Tester-owned tests (protected from implementer edits): ${scope.testerFiles.join(", ")}`);
        }
      }
    }

    // -------------------------------------------------------------------------
    // Stage 3: Deterministic Local Verification Gate (Zero LLM Tokens)
    // -------------------------------------------------------------------------
    opts.onProgress?.("Stage 3/4: Running local verify gate");
    console.log("\n[Stage 3/4] Running deterministic local verify gate...");
    let lastAgentText = implRes.text;
    for (let attempt = 1; attempt <= config.maxFixRetries + 1; attempt++) {
      const verify = await runDeterministicVerify(worktree.worktreeDir, config);
      if (verify.ok) {
        console.log("  -> Local verify gate PASSED.");
        break;
      }
      if (attempt > config.maxFixRetries) {
        const agentNote = lastAgentText ? `\n\nLast implementer response:\n${lastAgentText.slice(-2000)}` : "";
        throw new Error(`Deterministic verify failed after ${config.maxFixRetries} fix attempts:\n${verify.output}${agentNote}`);
      }
      console.log(`  -> Verify failed (${verify.failedCommand}). Sending failure back to implementer (attempt ${attempt}/${config.maxFixRetries})...`);
      budget.assertWithinBudget(`Stage 3: Fix #${attempt}`);
      const fixRes = await runner.prompt(
        implSessionId,
        "implementer",
        [
          "Fix the root cause in the implementation (do NOT weaken or delete tests).",
          "",
          `Verification command failed: ${verify.failedCommand}`,
          "",
          "Output:",
          "```",
          verify.output,
          "```",
        ].join("\n")
      );
      lastAgentText = fixRes.text;
      recordUsage(usageLog, `Stage 3: Fix #${attempt}`, fixRes, budget, "Stage 3: Fix");
      afterImplementerTurn(`Stage 3: Fix #${attempt}`);
    }

    // -------------------------------------------------------------------------
    // Stage 4: Shared-Context Parallel Multi-Lens Review
    // -------------------------------------------------------------------------
    if (!opts.skipReview) {
      const lenses = [
        {
          name: "Security",
          focus: "auth, RBAC/tenant isolation (IDOR), input validation, SQLi/XSS/SSRF, secret handling, leaked deployment config IDs/keys/emails/PII, rate limiting, and webhook/billing integrity",
        },
        {
          name: "Performance",
          focus: "N+1 queries, missing DB indexes, unbounded fetches/pagination, blocking I/O on hot paths, memory leaks, and unnecessary client bundle weight",
        },
        {
          name: "Correctness",
          focus: "race conditions, unhandled error paths, edge cases, type safety, and dead/duplicated code",
        },
      ];

      for (let round = 1; round <= config.maxReviewRounds; round++) {
        console.log(`\n[Stage 4/4] Parallel multi-lens review (round ${round}/${config.maxReviewRounds})...`);
        const diff = getDiff(worktree.worktreeDir, worktree.baseBranch);
        if (!diff.trim()) {
          console.log("  -> No diff to review.");
          break;
        }

        const sharedContextParts = [
          `Task: ${opts.task}`,
          ...(memory ? ["", `## Persistent Repository Memory\n${memory}`] : []),
          "",
          `Diff:\n${diff.slice(0, reviewDiffMaxChars)}`,
        ];

        opts.onProgress?.(`Stage 4/4: Parallel 3-lens review (round ${round}/${config.maxReviewRounds})`);
        budget.assertWithinBudget(`Stage 4: Review (round ${round})`);
        const reviews = await withSharedContext(worktree.worktreeDir, sharedContextParts.join("\n"), () =>
          runReviewLenses({
            lenses,
            config,
            runner,
            usageLog,
            budget,
          })
        );

        const openFindings = reviews.filter((r) => r.verdict === "OPEN");
        reviewVerdicts = reviews.map((r) => ({ lens: r.lens, verdict: r.verdict }));
        for (const r of reviews) {
          console.log(`  -> ${r.lens}: ${r.verdict}`);
        }

        if (openFindings.length === 0) {
          console.log("  -> All review lenses CLEAN.");
          break;
        }

        const findingsText = formatOpenReviewFindings(openFindings);

        if (round === config.maxReviewRounds) {
          console.log("\n[ai-ship] Review findings remain open after max rounds:");
          for (const f of openFindings) {
            console.log(`\n--- ${f.lens} ---\n${f.text}`);
          }
          throw new Error(
            `Review findings remain OPEN after ${config.maxReviewRounds} round(s). Inspect the worktree (${worktree.worktreeDir}) before pushing.\n\n${findingsText}`
          );
        }

        opts.onProgress?.(`Stage 4/4: Addressing review findings (round ${round})`);
        console.log("  -> Sending OPEN findings back to implementer...");
        budget.assertWithinBudget(`Stage 4: Review Fix #${round}`);
        const fixReviewRes = await runner.prompt(
          implSessionId,
          "implementer",
          `Address these review findings, then re-run local checks:\n\n${findingsText}`
        );
        recordUsage(usageLog, `Stage 4: Review Fix #${round}`, fixReviewRes, budget, "Stage 4: Review");
        afterImplementerTurn(`Stage 4: Review Fix #${round}`);

        const reverify = await runDeterministicVerify(worktree.worktreeDir, config);
        if (!reverify.ok) {
          throw new Error(`Verify failed after review fix:\n${reverify.output}`);
        }
      }
    }

    // -------------------------------------------------------------------------
    // Stage 4b: Adversarial Bughunter Pass (Hunter -> Skeptic -> Referee)
    // -------------------------------------------------------------------------
    if (!opts.skipReview && !opts.skipBughunter && config.bughunter !== false) {
      for (let round = 1; round <= config.maxReviewRounds; round++) {
        const diff = getDiff(worktree.worktreeDir, worktree.baseBranch);
        if (!diff.trim()) {
          break;
        }

        opts.onProgress?.(
          `Stage 4b: Adversarial bughunter Hunter -> Skeptic -> Referee (round ${round}/${config.maxReviewRounds})`
        );
        console.log(
          `\n[Stage 4b] Adversarial bughunter Hunter -> Skeptic -> Referee (round ${round}/${config.maxReviewRounds})...`
        );

        const bh = await runBughunterPass({
          task: opts.task,
          diff: diff.slice(0, reviewDiffMaxChars),
          memory,
          runner,
          usageLog,
          budget,
        });

        bughunterFindings = bh.findings;
        reviewVerdicts = [
          ...reviewVerdicts.filter((r) => r.lens !== "Bughunter"),
          { lens: "Bughunter", verdict: bh.verdict },
        ];
        console.log(`  -> Bughunter: ${bh.verdict}`);

        if (bh.verdict === "CLEAN") {
          break;
        }

        const bhFindingsText = formatBughunterFindings(bh.findings, bh.refereeText);
        if (round === config.maxReviewRounds) {
          console.log("\n[ai-ship] Bughunter findings remain open after max rounds:");
          console.log(`\n${bhFindingsText}`);
          throw new Error(
            `Bughunter findings remain OPEN after ${config.maxReviewRounds} round(s). Inspect the worktree (${worktree.worktreeDir}) before pushing.\n\n${bhFindingsText}`
          );
        }

        opts.onProgress?.(`Stage 4b: Addressing bughunter findings (round ${round})`);
        console.log("  -> Sending confirmed Bughunter findings back to implementer...");
        budget.assertWithinBudget(`Stage 4b: Bughunter Fix #${round}`);
        const fixBhRes = await runner.prompt(
          implSessionId,
          "implementer",
          `Address these confirmed cross-boundary bugs, then re-run local checks:\n\n${bhFindingsText}`
        );
        recordUsage(
          usageLog,
          `Stage 4b: Bughunter Fix #${round}`,
          fixBhRes,
          budget,
          "Stage 4b: Bughunter"
        );
        afterImplementerTurn(`Stage 4b: Bughunter Fix #${round}`);

        const reverify = await runDeterministicVerify(worktree.worktreeDir, config);
        if (!reverify.ok) {
          throw new Error(`Verify failed after bughunter fix:\n${reverify.output}`);
        }
      }
    }

    // -------------------------------------------------------------------------
    // Commit & Optional PR
    // -------------------------------------------------------------------------
    if (config.safetyCheck !== false) {
      assertWorktreeSafe(worktree.worktreeDir, {
        baseBranch: worktree.baseBranch,
        allowlist: config.safetyAllowlist,
      });
    }
    afterImplementerTurn("Pre-commit");
    squashCheckpoints(worktree.worktreeDir, startRef);
    const committed = commitAll(worktree.worktreeDir, `feat: ${opts.task.slice(0, 72)}`);
    console.log(`\n[ai-ship] Done! Branch: ${worktree.branch} (${committed ? "committed" : "no changes"})`);
    console.log(`[ai-ship] Worktree: ${worktree.worktreeDir}`);
    console.log("\n[ai-ship] Token & Cost Summary:");
    for (const line of usageLog) console.log(line);

    if (opts.openPr && committed) {
      opts.onProgress?.(`Rebasing onto ${worktree.baseBranch}`);
      console.log(`\n[ai-ship] Ensuring branch is up-to-date with ${worktree.baseBranch}...`);
      const rebase = rebaseOntoBase(worktree);
      if (rebase.conflicted) {
        console.log(
          `  -> Rebase onto ${rebase.targetRef} hit conflicts in: ${rebase.conflictedFiles.join(", ")}. Asking implementer to resolve...`
        );
        budget.assertWithinBudget("Pre-PR Rebase");
        const resolveRes = await runner.prompt(
          implSessionId,
          "implementer",
          [
            "Instructions:",
            "- Resolve all conflict markers while preserving both upstream changes and your task implementation.",
            "- Stage resolved files with `git add` and complete the rebase with `GIT_EDITOR=true git rebase --continue`.",
            "",
            `Rebase onto ${rebase.targetRef} hit merge conflicts in:`,
            ...rebase.conflictedFiles.map((f) => `- ${f}`),
          ].join("\n")
        );
        recordUsage(usageLog, "Pre-PR Rebase", resolveRes, budget, "Pre-PR Rebase");

        if (isRebaseInProgress(worktree.worktreeDir)) {
          abortRebase(worktree.worktreeDir);
          throw new Error(`Rebase onto ${rebase.targetRef} remained incomplete after conflict resolution.`);
        }
        // Upstream changes are legitimate; only this branch's changes relative to the rebase target count.
        afterImplementerTurn("Pre-PR Rebase conflict resolution", rebase.targetRef, true);
      }

      if (rebase.updated) {
        console.log(`  -> Rebased onto ${rebase.targetRef}. Re-running verify gate...`);
        const postRebaseVerify = await runDeterministicVerify(worktree.worktreeDir, config);
        if (!postRebaseVerify.ok) {
          throw new Error(`Verify failed after rebasing onto ${rebase.targetRef}:\n${postRebaseVerify.output}`);
        }
      }

      console.log("\n[ai-ship] Pushing branch and opening PR...");
      opts.onProgress?.(opts.draft ? "Pushing branch and opening draft PR" : "Pushing branch and opening PR");
      const prTitle = opts.task.split(/\r?\n/)[0].trim().slice(0, 72);
      const prBody = buildPrBody({
        task: opts.task,
        provider,
        implSummary: implRes.text,
        diffStat: getDiffStat(worktree.worktreeDir, worktree.baseBranch),
        verifyCommands: config.verify,
        adversarialTestsRan: !opts.skipTests,
        reviewVerdicts,
      });
      prUrl = pushAndOpenPR(worktree, prTitle, prBody, { draft: opts.draft });
    }

    const diffStat = getDiffStat(worktree.worktreeDir, worktree.baseBranch);
    const stageUsage = budget.getStageSummaries();
    const totalUsage = budget.getTotals();
    const summaryLines = budget.formatSummaryLines();
    if (summaryLines.length) {
      usageLog.push(...summaryLines);
      console.log("\n[ai-ship] Per-Stage & Task Totals:");
      for (const line of summaryLines) console.log(line);
    }

    return {
      repoDir,
      worktreeDir: worktree.worktreeDir,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      provider,
      committed,
      diffStat,
      implSummary: implRes.text,
      verifyCommands: config.verify,
      reviewVerdicts,
      ...(bughunterFindings.length > 0 ? { bughunterFindings } : {}),
      prUrl,
      usageLog,
      stageUsage,
      totalUsage,
    };
  } finally {
    runner.close();
  }
}

/** Runs an offline "dream" pass to consolidate repo memory from recent OpenCode transcripts. */
export async function runDreamConsolidation(opts: {
  repoDir: string;
  client?: OpencodeClient;
  serverUrl?: string;
  model?: string;
}): Promise<{ memoryPath: string; usageSummary: string; consolidated: string }> {
  const repoDir = path.resolve(opts.repoDir);
  const config = loadRepoConfig(repoDir);
  const repoName = path.basename(repoDir);
  const currentMemory = readMemory(repoDir, 500);

  const localBin = path.resolve(import.meta.dirname, "..", "node_modules", ".bin");
  if (!process.env.PATH?.includes(localBin)) {
    process.env.PATH = `${localBin}:${process.env.PATH ?? ""}`;
  }

  let client = opts.client;
  let closeServer: (() => void) | undefined;
  if (!client) {
    if (opts.serverUrl) {
      client = createOpencodeClient({ baseUrl: opts.serverUrl });
    } else {
      const cfGatewayUrl = resolveCloudflareGatewayUrl();
      const contextLensUrl = resolveContextLensUrl(config);
      const providerConfig = buildOpencodeProviderConfig(config, cfGatewayUrl, contextLensUrl);
      const started = await createOpencode({
        port: 0,
        ...(providerConfig ? { config: { provider: providerConfig as never } } : {}),
      });
      client = started.client;
      closeServer = () => started.server.close();
    }
  }

  try {
    const transcriptsText = await collectRecentTranscripts(client, repoDir);
    if (!currentMemory && !transcriptsText) {
      return {
        memoryPath: getMemoryPath(repoDir),
        usageSummary: "skipped (no memory or transcripts)",
        consolidated: "",
      };
    }

    const runner = createOpencodeClientRunner({
      client,
      worktreeDir: repoDir,
      config,
      model: opts.model,
    });

    const sessionId = await runner.createSession(`Dream: ${repoName}`);
    const prompt = buildDreamPrompt(repoName, currentMemory, transcriptsText);
    const res = await runner.prompt(sessionId, "reviewer", prompt);
    const consolidated = res.text.trim();
    if (!consolidated) {
      throw new Error("Dream consolidation returned empty output.");
    }
    const memoryPath = writeConsolidatedMemory(repoDir, consolidated);
    return { memoryPath, usageSummary: res.usageSummary, consolidated };
  } finally {
    closeServer?.();
  }
}

/** Formats open review-lens findings into readable markdown sections. */
export function formatOpenReviewFindings(
  openFindings: Array<{ lens: string; text: string }>
): string {
  return openFindings.map((f) => `### ${f.lens} Review\n${f.text}`).join("\n\n");
}

/** Formats a PipelineResult for MCP and plugin tool responses. */
export function formatPipelineResult(
  result: PipelineResult,
  label: string,
  openPrRequested: boolean
): string {
  const reviewSummary = result.reviewVerdicts.length
    ? result.reviewVerdicts.map((r) => `${r.lens}: ${r.verdict}`).join(", ")
    : "(skipped)";
  const verifySummary = result.verifyCommands.length
    ? `${result.verifyCommands.join(" && ")} (passed)`
    : "(none)";
  const lines = [
    `ai-ship pipeline completed for "${label}"`,
    `- Repo: ${result.repoDir}`,
    `- Branch: ${result.branch} (base: ${result.baseBranch}, ${result.committed ? "committed" : "no changes"})`,
    `- Worktree: ${result.worktreeDir}`,
    `- Provider: ${result.provider}`,
    `- Verify: ${verifySummary}`,
    `- Review: ${reviewSummary}`,
    `- PR: ${result.prUrl ?? (openPrRequested ? "(not created — no changes or gh failed)" : "(not requested)")}`,
  ];
  if (result.diffStat?.trim()) {
    lines.push("- Changed files:", "```text", result.diffStat.trim(), "```");
  }
  if (result.implSummary?.trim()) {
    lines.push("- Implementation summary:", truncateCleanly(result.implSummary, 2500));
  }
  const hasSummaryInLog = result.usageLog.some(
    (l) => l.includes("[Stage Totals]") || l.includes("[Task Total]")
  );
  const extraTelemetry =
    !hasSummaryInLog && (result.stageUsage?.length || result.totalUsage)
      ? formatStageTelemetryLines(result.stageUsage ?? [], result.totalUsage)
      : [];
  const usageLines = [...result.usageLog, ...extraTelemetry];
  if (usageLines.length) {
    lines.push("- Usage:", ...usageLines);
  }
  return lines.join("\n");
}
