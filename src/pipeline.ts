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
  buildCommitMessage,
  commitAll,
  createWorktree,
  getDiff,
  getDiffStat,
  isRebaseInProgress,
  openExistingWorktree,
  pushAndOpenPR,
  rebaseOntoBase,
  runShellAsync,
  type WorktreeHandle,
} from "./git.ts";
import { buildDreamPrompt, getMemoryPath, readMemory, writeConsolidatedMemory } from "./memory.ts";
import { assertWorktreeSafe, formatSafetyFindings, scanWorktreeSafety } from "./safety.ts";
import { findUnpricedModels, getModelsFilePath, loadPricingTable } from "./pricing.ts";
import type { ProgressSink } from "./progress.ts";
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
  snapshotBinTools,
  findTamperedBinTools,
  findScriptInvokedPaths,
  squashCheckpoints,
  isTesterPath,
  revertAllChangesSince,
  revertPathsToRef,
  changedFilesSince,
  type FileSnapshot,
} from "./integrity.ts";
import {
  buildOpencodeProviderConfig,
  collectRecentTranscripts,
  createOpencodeClientRunner,
  createRunner,
  checkAttachedReadOnlyAgents,
  checkModelIndependence,
  describeIgnoredForAttachedServer,
  buildOpencodeAgentConfig,
  formatRoleModelTable,
  resolveRoleFallbackLabels,
  resolveRoleModelLabels,
  type RoleModelOverrides,
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
  /** Implementer model override. Does not change the tester/reviewer/bughunter models. */
  model?: string;
  testerModel?: string;
  reviewerModel?: string;
  bughunterModel?: string;
  serverUrl?: string;
  contextLens?: boolean | string;
  /** Pre-built runner (e.g. an OpenCode 2.x runner from the native plugin or `--attach`). */
  runner?: PipelineRunner;
  /** Fine-grained per-agent progress events (sessions, tool calls, usage). */
  onEvent?: ProgressSink;
  /** Called once the worktree exists (lets lazily-built runners learn its path). */
  onWorktree?: (worktreeDir: string) => void;
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
  /** Calls whose cost could not be determined (tokens used, no provider cost, no pricing entry). */
  unknownCostCalls?: number;
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
      const unknownNote = s.unknownCostCalls ? `, ${s.unknownCostCalls} with UNKNOWN cost` : "";
      lines.push(
        `    ${s.stage}: in=${s.input} out=${s.output} cache_read=${s.cacheRead} cache_hit=${formatCacheHitPercent(ratio)} total=${s.totalTokens} | $${s.costUsd.toFixed(4)} (${callLabel}${unknownNote})`
      );
    }
  }
  if (totals) {
    const ratio = totals.cacheHitRatio ?? computeCacheHitRatio(totals.input, totals.cacheRead);
    lines.push(
      `  [Task Total] in=${totals.input} out=${totals.output} cache_read=${totals.cacheRead} total=${totals.totalTokens} | $${totals.costUsd.toFixed(4)} (cache_hit=${formatCacheHitPercent(ratio)})`
    );
    if (totals.unknownCostCalls) {
      lines.push(
        `  [WARNING] ${totals.unknownCostCalls} call(s) had no provider cost and no pricing entry: the $ total and maxTaskCostUsd are understated. Add prices to ~/.config/ai-ship/models.json ("pricing") or .ai-ship.json.`
      );
    }
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

  private readonly failOnUnknownCost: boolean;

  constructor(limits: { maxTaskCostUsd?: number; maxTaskTokens?: number; failOnUnknownCost?: boolean }) {
    this.failOnUnknownCost = Boolean(limits.failOnUnknownCost);
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
    const tokens = u.input + u.output + u.cacheRead + (u.reasoning ?? 0) + (u.cacheWrite ?? 0);
    const unknown = u.costSource === "unknown" ? 1 : 0;
    if (unknown && this.failOnUnknownCost) {
      throw new Error(
        `[ai-ship] ${stage}: call${res.model ? ` to ${res.model}` : ""} used tokens but its cost is unknown and requirePricing is set.`
      );
    }
    this.totals.unknownCostCalls = (this.totals.unknownCostCalls ?? 0) + unknown;

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
      existing.unknownCostCalls = (existing.unknownCostCalls ?? 0) + unknown;
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
        unknownCostCalls: unknown,
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

interface DiffBlock {
  file: string;
  text: string;
  index: number;
}

/** Splits a combined diff (git diff output + ai-ship untracked-file sections) into per-file blocks. */
export function splitDiffBlocks(diff: string): DiffBlock[] {
  const lines = diff.split("\n");
  const blocks: DiffBlock[] = [];
  let current: string[] = [];
  let currentFile = "";
  // Inside a `diff --git` header (until its first hunk) a `--- /dev/null` line belongs to that header.
  let inGitHeader = false;
  let headerHasPlus = false;
  const flush = () => {
    const text = current.join("\n");
    if (text.trim()) blocks.push({ file: currentFile || "(preamble)", text, index: blocks.length });
    current = [];
    currentFile = "";
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const gitHeader = line.startsWith("diff --git ");
    // A hunk-less git block (pure rename/mode change) never reaches "@@", so also start a new untracked
    // section once the current git header already had its own "+++" line.
    const untrackedHeader =
      (!inGitHeader || headerHasPlus) && line === "--- /dev/null" && lines[i + 1]?.startsWith("+++ b/");
    const binary = line.match(/^Binary file (.+) added \(/);
    if (gitHeader || untrackedHeader || binary) {
      flush();
      if (gitHeader) {
        inGitHeader = true;
        // Prefer the `+++ b/` path from the header (robust to paths containing " b/"), else parse the header line.
        const lookahead: string[] = [];
        for (let j = i + 1; j < Math.min(lines.length, i + 8) && !lines[j].startsWith("diff --git "); j++) lookahead.push(lines[j]);
        const plus = lookahead.find((l) => l.startsWith("+++ b/"));
        headerHasPlus = false;
        const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        currentFile = plus ? plus.slice("+++ b/".length) : m ? m[2] : line.slice("diff --git ".length);
      } else {
        inGitHeader = false;
        headerHasPlus = false;
        currentFile = binary ? binary[1] : lines[i + 1].slice("+++ b/".length);
      }
    } else if (inGitHeader && line.startsWith("+++ ")) {
      headerHasPlus = true;
    } else if (inGitHeader && (line.startsWith("@@") || line.startsWith("Binary files "))) {
      inGitHeader = false;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * Truncates a diff to `maxChars` without cutting files in half: whole per-file blocks are kept, production
 * files before tests and smaller before larger, in their original order; omitted files are listed so the
 * reader can open them directly. A single oversize block is cut at a line boundary.
 */
export function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  const blocks = splitDiffBlocks(diff);
  const reserve = Math.min(2000, Math.floor(maxChars * 0.1));
  const budget = Math.max(0, maxChars - reserve);
  const priority = [...blocks].sort((a, b) => {
    const ta = isTesterPath(a.file) ? 1 : 0;
    const tb = isTesterPath(b.file) ? 1 : 0;
    return ta - tb || a.text.length - b.text.length || a.index - b.index;
  });
  const kept = new Set<number>();
  let used = 0;
  for (const b of priority) {
    if (used + b.text.length + 1 <= budget) {
      kept.add(b.index);
      used += b.text.length + 1;
    }
  }
  let body: string;
  if (kept.size === 0 && priority.length > 0) {
    const first = priority[0];
    const cut = first.text.slice(0, budget);
    const nl = cut.lastIndexOf("\n");
    body = `${nl > 0 ? cut.slice(0, nl) : cut}\n(ai-ship: ${first.file} truncated)`;
    kept.add(first.index);
  } else {
    body = blocks.filter((b) => kept.has(b.index)).map((b) => b.text).join("\n");
  }
  const omitted = blocks.filter((b) => !kept.has(b.index)).map((b) => b.file);
  const shown = omitted.slice(0, 40);
  const more = omitted.length - shown.length;
  const note = omitted.length
    ? `\n\n(ai-ship: diff truncated to ~${maxChars} chars; omitted file diffs — read these files directly if relevant:\n${shown.map((f) => `- ${f}`).join("\n")}${more > 0 ? `\n- …and ${more} more (see git diff --stat)` : ""})`
    : "";
  return `${body}${note}`;
}

export type TestDisputeVerdict = "TEST_BUG" | "IMPL_BUG" | "MISSING";

/** Parses the tester's dispute answer from its last `TEST_BUG` / `IMPL_BUG` line. */
export function parseTestDispute(text: string): TestDisputeVerdict {
  let last: TestDisputeVerdict = "MISSING";
  for (const m of text.matchAll(/^[\s>*_`#-]*(TEST_BUG|IMPL_BUG)\b/gim)) {
    last = m[1].toUpperCase() as TestDisputeVerdict;
  }
  return last;
}

const FAILURE_LINE_RE = /(fail|error|✖|✗|×|not ok|assert|expected|panic|traceback)/i;

/**
 * Tester-owned test files that a verify failure points at: the file's full repo-relative path (or the
 * worktree-absolute path) must appear on a failure-looking line, bounded by non-path characters, so passing
 * file listings or a same-named test in another directory do not trigger a dispute.
 */
export function findDisputedTestFiles(output: string, testerFiles: readonly string[], worktreeDir?: string): string[] {
  const failureLines = output.split(/\r?\n/).filter((l) => FAILURE_LINE_RE.test(l));
  if (failureLines.length === 0) return [];
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return testerFiles.filter((f) => {
    const rel = new RegExp(`(^|[^\\w./-])${esc(f)}($|[^\\w./-])`);
    const abs = worktreeDir ? new RegExp(`${esc(path.join(worktreeDir, f))}($|[^\\w./-])`) : undefined;
    return failureLines.some((l) => rel.test(l) || (abs ? abs.test(l) : false));
  });
}

export function buildTestDisputePrompt(opts: { task: string; files: string[]; failedCommand: string; output: string }): string {
  return [
    "You wrote the tests below for this task. They now fail in the verify gate.",
    "Decide, given ONLY the task intent, whether the failing tests are wrong (they assert behaviour the task does not require, or contain a bug) or the implementation is wrong.",
    "Do not edit any files in this reply.",
    "Answer with a short reason and a final line that is exactly `TEST_BUG` or `IMPL_BUG`.",
    "",
    `Task Intent: ${opts.task}`,
    `Failing tester-owned files: ${opts.files.join(", ")}`,
    `Failed command: ${opts.failedCommand}`,
    "",
    "Output:",
    "```",
    opts.output,
    "```",
  ].join("\n");
}

export const TEST_FIX_PROMPT = [
  "Fix your failing test(s) so they assert only behaviour the task requires.",
  "Only edit the test files you wrote; do NOT modify production code, other tests, or config.",
].join("\n");

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
    const res = await runShellAsync(cmd, worktreeDir);
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
  if (opts.onEvent) {
    const stageSink = opts.onEvent;
    const original = opts.onProgress;
    opts = { ...opts, onProgress: (stage: string) => {
      original?.(stage);
      stageSink({ ts: Date.now(), kind: "stage", stage, text: stage });
    } };
  }
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
  const roleModels: RoleModelOverrides = {
    ...(opts.model ? { implementer: opts.model } : {}),
    ...(opts.testerModel ? { tester: opts.testerModel } : {}),
    ...(opts.reviewerModel ? { reviewer: opts.reviewerModel } : {}),
    ...(opts.bughunterModel ? { bughunter: opts.bughunterModel } : {}),
  };
  const roleLabels = resolveRoleModelLabels(provider, config, roleModels);
  console.log(`[ai-ship] Provider: ${provider}`);
  console.log("[ai-ship] Role models:");
  for (const line of formatRoleModelTable(roleLabels)) console.log(line);
  const independenceWarnings = checkModelIndependence({
    labels: roleLabels,
    fallbacks: resolveRoleFallbackLabels(provider, config),
    lensModels:
      provider === "claude-code"
        ? undefined
        : Object.fromEntries(
            Object.entries(config.reviewerLensModels ?? {}).map(([lens, ref]) => [
              lens,
              { ...ref, providerID: ref.providerID || config.reviewerModel?.providerID || config.defaultProvider || "" },
            ])
          ),
    strict: config.strictIndependence !== false,
    provider,
  });
  for (const w of independenceWarnings) console.log(`[ai-ship] Warning: ${w}`);

  // Cost accounting preflight: OpenCode reports $0 for models it has no price for, which would make the
  // budget breaker blind. claude-code reports its own cost.
  if (provider !== "claude-code") {
    const pricing = loadPricingTable(config.pricing);
    const fallbackLabels = resolveRoleFallbackLabels(provider, config);
    const lensLabels = Object.values(config.reviewerLensModels ?? {}).map((r) => `${r.providerID}/${r.id}`);
    const unpriced = findUnpricedModels(pricing, [
      ...Object.values(roleLabels),
      ...Object.values(fallbackLabels),
      ...lensLabels,
    ]);
    const unresolved = (Object.entries(roleLabels) as Array<[string, string | undefined]>)
      .filter(([, label]) => !label)
      .map(([role]) => role);
    if (unpriced.length > 0 || (config.requirePricing && unresolved.length > 0)) {
      const parts = [
        unpriced.length ? `No pricing for ${unpriced.join(", ")}` : "",
        unresolved.length ? `roles without a configured model (OpenCode agent default, price unknown): ${unresolved.join(", ")}` : "",
      ].filter(Boolean);
      const msg = `${parts.join("; ")}. If the provider does not report cost, the budget breaker cannot see it. Add entries under "pricing" in ${getModelsFilePath()} or .ai-ship.json (use { "in": 0, "out": 0 } for free/local models).`;
      if (config.requirePricing) throw new Error(`[ai-ship] ${msg} (requirePricing is set)`);
      console.log(`[ai-ship] Warning: ${msg}`);
    }
  }
  if (provider === "opencode" && cfGatewayUrl) console.log(`[ai-ship] Cloudflare AI Gateway: ${cfGatewayUrl}`);
  if (provider === "opencode" && contextLensUrl) console.log(`[ai-ship] Context Lens Proxy: ${contextLensUrl}`);
  console.log(`[ai-ship] Verify pipeline: ${config.verify.length ? config.verify.join(" && ") : "(none detected)"}`);

  opts.onProgress?.(opts.worktreeDir ? "Opening existing worktree" : "Creating isolated worktree");
  const worktree: WorktreeHandle = opts.worktreeDir
    ? openExistingWorktree(repoDir, config.baseBranch, opts.worktreeDir)
    : createWorktree(repoDir, config.baseBranch, opts.task);
  console.log(`[ai-ship] Worktree: ${worktree.worktreeDir} (branch: ${worktree.branch})`);
  opts.onWorktree?.(worktree.worktreeDir);

  if (provider === "opencode" && !opts.runner && (opts.client || opts.serverUrl)) {
    const ignored = describeIgnoredForAttachedServer({ cfGatewayUrl, contextLensUrl, config });
    console.log(`[ai-ship] Attached to an existing OpenCode ${opts.client ? "client" : "server"}; ignored settings: ${ignored.join("; ")}.`);
    const attached = opts.client ?? createOpencodeClient({ baseUrl: opts.serverUrl as string });
    for (const w of await checkAttachedReadOnlyAgents(attached)) console.log(`[ai-ship] Warning: ${w}`);
  }

  const runner = opts.runner
    ? opts.runner
    : opts.client
    ? createOpencodeClientRunner({
        client: opts.client,
        worktreeDir: worktree.worktreeDir,
        config,
        roleModels,
      })
    : await createRunner({
        provider,
        worktreeDir: worktree.worktreeDir,
        config,
        cfGatewayUrl,
        contextLensUrl,
        roleModels,
        serverUrl: opts.serverUrl,
      });
  const usageLog: string[] = [];
  const budget = new BudgetTracker({
    maxTaskCostUsd: config.maxTaskCostUsd,
    maxTaskTokens: config.maxTaskTokens,
    failOnUnknownCost: config.requirePricing === true,
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
  // Files the verify commands invoke (e.g. scripts/test.sh behind `npm test`) are gates too.
  const scriptInvoked = findScriptInvokedPaths(worktree.worktreeDir, config.verify);
  const protectedPaths = [...(config.protectedPaths ?? DEFAULT_PROTECTED_PATHS), ...scriptInvoked];
  if (scriptInvoked.length > 0) console.log(`[ai-ship] Protected verify-invoked files: ${scriptInvoked.join(", ")}`);
  // Tool binaries the verify commands run (tsc, vitest, eslint, ...) must not be rewritten mid-run.
  const binBaseline = snapshotBinTools(worktree.worktreeDir);
  const verifyGate = async () => {
    const tampered = findTamperedBinTools(worktree.worktreeDir, binBaseline);
    if (tampered.length > 0) {
      throw new Error(
        `node_modules tool binaries changed during the run (${tampered.join(", ")}); refusing to trust the verify gate.`
      );
    }
    return runDeterministicVerify(worktree.worktreeDir, config);
  };
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
    let testSessionId: string | undefined;
    let testerFiles: string[] = [];
    const disputedFiles = new Set<string>();

    // Implementer context control: compact the implementer session once its accumulated input grows large,
    // then re-state the task so the next turn does not depend on the dropped history.
    const compactAfterTokens = config.compactAfterTokens ?? 120_000;
    // Approximate context size by the last implementer turn's prompt tokens (input + cache read).
    let implInputSinceCompact = (implRes.usage?.input ?? 0) + (implRes.usage?.cacheRead ?? 0);
    let lastAgentText = implRes.text;
    const implementerTurn = async (label: string, stageKey: string, promptText: string) => {
      budget.assertWithinBudget(label);
      let text = promptText;
      if (compactAfterTokens > 0 && implInputSinceCompact >= compactAfterTokens && runner.compact) {
        const compacted = await runner.compact(implSessionId, "implementer");
        if (compacted) {
          integrityLog(`  [context] Implementer session compacted after ~${implInputSinceCompact} input tokens.`);
          implInputSinceCompact = 0;
          text = [
            "Context (session was compacted). Original instructions and task follow.",
            buildImplementerPrompt(opts.task, memory),
            "",
            `Files changed so far:\n${getDiffStat(worktree.worktreeDir, worktree.baseBranch) || "(see git status)"}`,
            "",
            promptText,
          ].join("\n");
        }
      }
      const res = await runner.prompt(implSessionId, "implementer", text);
      implInputSinceCompact = (res.usage?.input ?? 0) + (res.usage?.cacheRead ?? 0);
      lastAgentText = res.text;
      recordUsage(usageLog, label, res, budget, stageKey);
      afterImplementerTurn(label);
      return res;
    };

    // -------------------------------------------------------------------------
    // Stage 2: Independent Adversarial Test Session (Separate Session & Model)
    // -------------------------------------------------------------------------
    if (!opts.skipTests) {
      opts.onProgress?.("Stage 2/4: Independent adversarial tests");
      console.log("\n[Stage 2/4] Independent adversarial test generation (separate session)...");
      const diff = getDiff(worktree.worktreeDir, worktree.baseBranch);
      if (diff.trim()) {
        budget.assertWithinBudget("Stage 2: Adversarial Tests");
        testSessionId = await runner.createSession(`Adversarial Tests: ${opts.task.slice(0, 50)}`);

        const testRes = await runner.prompt(
          testSessionId,
          "tester",
          buildTesterPrompt({
            task: opts.task,
            diff: truncateDiff(diff, testDiffMaxChars),
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
        testerFiles = scope.testerFiles;
        testerSnapshot = snapshotFiles(worktree.worktreeDir, scope.testerFiles);
        if (scope.testerFiles.length > 0) {
          integrityLog(`  [integrity] Tester-owned tests (protected from implementer edits): ${scope.testerFiles.join(", ")}`);
        }
      }
    }

    // -------------------------------------------------------------------------
    // Stage 3: Deterministic Local Verification Gate (Zero LLM Tokens)
    // -------------------------------------------------------------------------
    /**
     * Runs the verify gate and loops failures back to the implementer (up to maxFixRetries). When the failure
     * points at tester-owned tests, the tester is asked first whether its test is wrong (TEST_BUG); if so it
     * may fix that test once. Used after Stage 2 and after every review fix.
     */
    const verifyWithFixes = async (context: string) => {
      // Implementer attempts are bounded by maxFixRetries; test disputes are bounded separately (at most once
      // per tester-owned file) and do not consume implementer attempts.
      let implementerAttempts = 0;
      for (;;) {
        const verify = await verifyGate();
        if (verify.ok) {
          console.log(`  -> Local verify gate PASSED${context ? ` (${context})` : ""}.`);
          return;
        }

        const disputed = findDisputedTestFiles(verify.output, testerFiles, worktree.worktreeDir).filter(
          (f) => !disputedFiles.has(f)
        );
        if (testSessionId && disputed.length > 0) {
          for (const f of disputed) disputedFiles.add(f);
          // Checkpoint first, and undo anything the (read-only by instruction) dispute session writes.
          const preDispute = createCheckpoint(worktree.worktreeDir, `${CHECKPOINT_PREFIX} before test dispute`);
          budget.assertWithinBudget("Stage 3: Test dispute");
          const disputeSession = await runner.createSession(`Test dispute: ${opts.task.slice(0, 50)}`);
          const dispute = await runner.prompt(
            disputeSession,
            "tester",
            buildTestDisputePrompt({
              task: opts.task,
              files: disputed,
              failedCommand: verify.failedCommand ?? "verify",
              output: verify.output,
            })
          );
          recordUsage(usageLog, "Stage 3: Test dispute", dispute, budget, "Stage 3: Fix");
          const disputeEdits = revertAllChangesSince(worktree.worktreeDir, preDispute);
          if (disputeEdits.length > 0) {
            integrityLog(`  [integrity] Test-dispute session edited files (reverted): ${disputeEdits.join(", ")}`);
          }
          const ruling = parseTestDispute(dispute.text);
          integrityLog(`  [dispute] Tester ruling on ${disputed.join(", ")}: ${ruling}`);
          if (ruling === "TEST_BUG") {
            budget.assertWithinBudget("Stage 3: Tester fix");
            const testFix = await runner.prompt(
              testSessionId,
              "tester",
              `${TEST_FIX_PROMPT}\n\nFiles: ${disputed.join(", ")}\n\nOutput:\n\`\`\`\n${verify.output}\n\`\`\``
            );
            recordUsage(usageLog, "Stage 3: Tester fix", testFix, budget, "Stage 3: Fix");
            // Only the disputed test files may change: revert everything else (other tests, prod code, config).
            // Deleting a disputed test is not a fix: restore it too.
            const outOfScope = changedFilesSince(worktree.worktreeDir, preDispute)
              .filter((f) => !disputed.includes(f.path) || f.status === "deleted")
              .map((f) => f.path);
            revertPathsToRef(worktree.worktreeDir, preDispute, outOfScope);
            if (outOfScope.length > 0) {
              integrityLog(`  [integrity] Tester fix touched files outside the disputed tests (reverted): ${outOfScope.join(", ")}`);
            }
            testerRef = createCheckpoint(worktree.worktreeDir, `${CHECKPOINT_PREFIX} tester test fix`);
            testerSnapshot = snapshotFiles(worktree.worktreeDir, testerFiles);
            continue;
          }
          continue;
        }

        if (implementerAttempts >= config.maxFixRetries) {
          const agentNote = lastAgentText ? `\n\nLast implementer response:\n${lastAgentText.slice(-2000)}` : "";
          throw new Error(
            `Deterministic verify failed after ${config.maxFixRetries} fix attempts${context ? ` (${context})` : ""}:\n${verify.output}${agentNote}`
          );
        }
        implementerAttempts += 1;
        console.log(
          `  -> Verify failed (${verify.failedCommand}). Sending failure back to implementer (attempt ${implementerAttempts}/${config.maxFixRetries})...`
        );
        await implementerTurn(
          `Stage 3: Fix #${implementerAttempts}${context ? ` (${context})` : ""}`,
          "Stage 3: Fix",
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
      }
    };

    opts.onProgress?.("Stage 3/4: Running local verify gate");
    console.log("\n[Stage 3/4] Running deterministic local verify gate...");
    await verifyWithFixes("");

    // -------------------------------------------------------------------------
    // Stage 4: Review lenses + adversarial bughunter, run concurrently on the same diff snapshot.
    // OPEN findings are merged into ONE implementer fix round, re-verified (with fix loop), and then only the
    // lenses that were OPEN (plus Correctness) and the bughunter (if it was OPEN) review the new diff.
    // -------------------------------------------------------------------------
    if (!opts.skipReview) {
      const lenses: ReviewLens[] = [
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
      const bughunterEnabled = !opts.skipBughunter && config.bughunter !== false;
      let pendingLenses = lenses;
      let runBughunterThisRound = bughunterEnabled;

      for (let round = 1; round <= config.maxReviewRounds; round++) {
        const diff = getDiff(worktree.worktreeDir, worktree.baseBranch);
        if (!diff.trim()) {
          console.log("  -> No diff to review.");
          break;
        }
        const reviewDiff = truncateDiff(diff, reviewDiffMaxChars);
        const parts = [
          pendingLenses.length ? `${pendingLenses.map((l) => l.name).join("/")} lenses` : "",
          runBughunterThisRound ? "bughunter" : "",
        ].filter(Boolean);
        console.log(`\n[Stage 4/4] Review round ${round}/${config.maxReviewRounds}: ${parts.join(" + ")} (concurrent)...`);
        opts.onProgress?.(`Stage 4/4: Review round ${round}/${config.maxReviewRounds} (${parts.join(" + ")})`);
        budget.assertWithinBudget(`Stage 4: Review (round ${round})`);

        const sharedContext = [
          `Task: ${opts.task}`,
          ...(memory ? ["", `## Persistent Repository Memory\n${memory}`] : []),
          "",
          `Diff:\n${reviewDiff}`,
        ].join("\n");
        // Reviewers are read-only. OpenCode 2.x prompts have no per-prompt tool switches, so enforce it here for
        // every backend: checkpoint before the round and revert anything a reviewer wrote.
        const preReview = createCheckpoint(worktree.worktreeDir, `${CHECKPOINT_PREFIX} before review round ${round}`);
        const revertReviewerEdits = () => {
          const edits = revertAllChangesSince(worktree.worktreeDir, preReview);
          if (edits.length > 0) integrityLog(`  [integrity] Read-only reviewers changed files (reverted): ${edits.join(", ")}`);
        };
        let roundResult;
        try {
          roundResult = await withSharedContext(worktree.worktreeDir, sharedContext, async () => {
          // allSettled: never leave one reviewer running in the background while another failed.
          const settled = await Promise.allSettled([
            pendingLenses.length
              ? runReviewLenses({ lenses: pendingLenses, config, runner, usageLog, budget })
              : Promise.resolve([] as Array<{ lens: string; text: string; verdict: "CLEAN" | "OPEN" }>),
            runBughunterThisRound
              ? runBughunterPass({ task: opts.task, diff: reviewDiff, memory, runner, usageLog, budget })
              : Promise.resolve(undefined),
          ] as const);
          const failed = settled.find((r) => r.status === "rejected");
          if (failed && failed.status === "rejected") throw failed.reason;
          return [
            (settled[0] as PromiseFulfilledResult<Array<{ lens: string; text: string; verdict: "CLEAN" | "OPEN" }>>).value,
            (settled[1] as PromiseFulfilledResult<BughunterResult | undefined>).value,
          ] as const;
        });

        } finally {
          revertReviewerEdits();
        }
        const [reviews, bh] = roundResult;

        const verdictMap = new Map(reviewVerdicts.map((r) => [r.lens, r.verdict] as const));
        for (const r of reviews) {
          verdictMap.set(r.lens, r.verdict);
          console.log(`  -> ${r.lens}: ${r.verdict}`);
        }
        if (bh) {
          bughunterFindings = bh.findings;
          verdictMap.set("Bughunter", bh.verdict);
          console.log(`  -> Bughunter: ${bh.verdict}`);
        }
        reviewVerdicts = [...verdictMap].map(([lens, verdict]) => ({ lens, verdict }));

        const openLenses = reviews.filter((r) => r.verdict === "OPEN");
        const bughunterOpen = bh?.verdict === "OPEN";
        if (openLenses.length === 0 && !bughunterOpen) {
          console.log("  -> All reviewers CLEAN.");
          break;
        }

        const findingsText = [
          openLenses.length ? formatOpenReviewFindings(openLenses) : "",
          bughunterOpen && bh ? formatBughunterFindings(bh.findings, bh.refereeText) : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        if (round === config.maxReviewRounds) {
          console.log("\n[ai-ship] Review findings remain open after max rounds:");
          console.log(`\n${findingsText}`);
          throw new Error(
            `Review findings remain OPEN after ${config.maxReviewRounds} round(s). Inspect the worktree (${worktree.worktreeDir}) before pushing.\n\n${findingsText}`
          );
        }

        opts.onProgress?.(`Stage 4/4: Addressing review findings (round ${round})`);
        console.log("  -> Sending merged OPEN findings back to implementer (one fix round)...");
        await implementerTurn(
          `Stage 4: Review Fix #${round}`,
          "Stage 4: Review",
          `Address these review findings, then re-run local checks:\n\n${findingsText}`
        );
        await verifyWithFixes(`after review fix #${round}`);

        const openNames = new Set(openLenses.map((r) => r.lens));
        pendingLenses = lenses.filter((l) => openNames.has(l.name) || l.name === "Correctness");
        runBughunterThisRound = bughunterEnabled && bughunterOpen;
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
    const committed = commitAll(worktree.worktreeDir, buildCommitMessage(opts.task));
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
        const postRebaseVerify = await verifyGate();
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
  if (client || opts.serverUrl) {
    const ignored = describeIgnoredForAttachedServer({
      cfGatewayUrl: resolveCloudflareGatewayUrl(),
      contextLensUrl: resolveContextLensUrl(config),
      config,
    });
    console.log(`[ai-ship] Dream attached to an existing OpenCode ${client ? "client" : "server"}; ignored settings: ${ignored.join("; ")}.`);
  }
  if (!client) {
    if (opts.serverUrl) {
      client = createOpencodeClient({ baseUrl: opts.serverUrl });
    } else {
      const cfGatewayUrl = resolveCloudflareGatewayUrl();
      const contextLensUrl = resolveContextLensUrl(config);
      const providerConfig = buildOpencodeProviderConfig(config, cfGatewayUrl, contextLensUrl);
      const started = await createOpencode({
        port: 0,
        config: {
          ...(providerConfig ? { provider: providerConfig as never } : {}),
          // dream runs as the read-only reviewer role: keep its agent permissions locked down too
          agent: buildOpencodeAgentConfig() as never,
        },
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
      // dream consolidation runs as the read-only reviewer role
      roleModels: opts.model ? { reviewer: opts.model } : undefined,
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
