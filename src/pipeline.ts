import fs from "node:fs";
import path from "node:path";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import { loadRepoConfig, type ModelRef, type RepoConfig } from "./config.ts";
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
  buildOpencodeProviderConfig,
  collectRecentTranscripts,
  createOpencodeClientRunner,
  createRunner,
  DEFAULT_CLAUDE_MODEL,
  parseUsageSummary,
  type OpencodeClient,
  type PipelineRunner,
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
  provider?: ProviderName;
  model?: string;
  serverUrl?: string;
  client?: OpencodeClient;
  onProgress?: (stage: string) => void;
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
}

export interface StageUsageSummary extends UsageTotals {
  stage: string;
  calls: number;
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

    const existing = this.stages.get(stage);
    if (existing) {
      existing.input += u.input;
      existing.output += u.output;
      existing.cacheRead += u.cacheRead;
      existing.totalTokens += tokens;
      existing.costUsd += u.costUsd;
      existing.calls += 1;
    } else {
      this.stages.set(stage, {
        stage,
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        totalTokens: tokens,
        costUsd: u.costUsd,
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
    return { ...this.totals };
  }

  getStageSummaries(): StageUsageSummary[] {
    return Array.from(this.stages.values()).map((s) => ({ ...s }));
  }

  formatSummaryLines(): string[] {
    const stages = this.getStageSummaries();
    if (stages.length === 0) return [];
    const lines = ["  [Stage Totals]"];
    for (const s of stages) {
      const callLabel = s.calls === 1 ? "1 call" : `${s.calls} calls`;
      lines.push(
        `    ${s.stage}: in=${s.input} out=${s.output} cache_read=${s.cacheRead} total=${s.totalTokens} | $${s.costUsd.toFixed(4)} (${callLabel})`
      );
    }
    lines.push(
      `  [Task Total] in=${this.totals.input} out=${this.totals.output} cache_read=${this.totals.cacheRead} total=${this.totals.totalTokens} | $${this.totals.costUsd.toFixed(4)}`
    );
    return lines;
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

function formatUsage(label: string, summary: string): string {
  return `  [${label}] ${summary}`;
}

function recordUsage(
  usageLog: string[],
  label: string,
  res: PromptResult,
  budget?: BudgetTracker,
  stageKey?: string
): void {
  usageLog.push(formatUsage(label, res.usageSummary));
  if (res.fallback) {
    const line = `  [${label} Fallback] ${res.fallback.from} -> ${res.fallback.to} (${res.fallback.reason})`;
    console.log(line);
    usageLog.push(line);
  }
  budget?.record(stageKey ?? label, res);
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
        [
          `Review lens: ${item.lens.name}`,
          `Focus strictly on: ${item.lens.focus}.`,
          `Read .ai-ship-shared-context.txt in the repo root.`,
          "Report ONLY concrete, reproducible high/critical issues with exact file paths, line numbers, and how to reproduce.",
          "End with `VERDICT: CLEAN` or `VERDICT: OPEN`.",
        ].join("\n"),
        item.modelOverride ? { modelOverride: item.modelOverride } : undefined
      );
      recordUsage(opts.usageLog, `Stage 4: ${item.lens.name} Lens`, r, opts.budget, "Stage 4: Review");
      results[idx] = { lens: item.lens.name, text: r.text, verdict: parseVerdict(r.text) };
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
        output: safetyOut.slice(-6000),
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
        output: res.output.slice(-6000),
      };
    }
  }
  return { ok: true, output: logs.join("\n\n") };
}

function parseVerdict(text: string): "CLEAN" | "OPEN" {
  const match = text.match(/VERDICT:\s*(CLEAN|OPEN)/i);
  if (match) return match[1].toUpperCase() as "CLEAN" | "OPEN";
  return text.toLowerCase().includes("critical") || text.toLowerCase().includes("vulnerability")
    ? "OPEN"
    : "CLEAN";
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
  console.log(`\n[ai-ship] Repo: ${repoDir} (base: ${config.baseBranch})`);
  console.log(`[ai-ship] Provider: ${provider}${opts.model ? ` (model: ${opts.model})` : provider === "claude-code" ? ` (model: ${DEFAULT_CLAUDE_MODEL})` : ""}`);
  if (provider === "opencode" && cfGatewayUrl) console.log(`[ai-ship] Cloudflare AI Gateway: ${cfGatewayUrl}`);
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
        model: opts.model,
        serverUrl: opts.serverUrl,
      });
  const usageLog: string[] = [];
  const budget = new BudgetTracker({
    maxTaskCostUsd: config.maxTaskCostUsd,
    maxTaskTokens: config.maxTaskTokens,
  });
  let reviewVerdicts: Array<{ lens: string; verdict: "CLEAN" | "OPEN" }> = [];
  let prUrl: string | undefined;

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
      [
        `Task: ${opts.task}`,
        "",
        "Instructions:",
        "- Work inside the current repository.",
        "- Read AGENTS.md if it exists.",
        "- Make clean, minimal, production-ready changes.",
        "- Never hardcode or commit deployment config IDs (e.g. wrangler account_id, database_id, zone_id, kv id), secrets, API keys, emails, or real account/org/user IDs.",
        "- Run relevant local checks before finishing.",
      ].join("\n")
    );
    recordUsage(usageLog, "Stage 1: Implement", implRes, budget, "Stage 1: Implement");

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
          [
            `Task Intent: ${opts.task}`,
            "",
            "You are an independent adversarial tester. You did NOT write the implementation.",
            "Review the diff below and write focused tests covering:",
            "1. Security & auth/tenant isolation (IDOR, missing auth, input validation, injection).",
            "2. Edge cases, failure modes, and race conditions.",
            "3. Performance regressions (e.g., unbounded queries, N+1 loops).",
            "",
            "Only create or update test files. Do NOT modify production source files.",
            "",
            "Diff:",
            "```diff",
            diff.slice(0, 40000),
            "```",
          ].join("\n")
        );
        recordUsage(usageLog, "Stage 2: Adversarial Tests", testRes, budget, "Stage 2: Adversarial Tests");
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
          `Verification command failed: ${verify.failedCommand}`,
          "Fix the root cause in the implementation (do NOT weaken or delete tests).",
          "",
          "Output:",
          "```",
          verify.output,
          "```",
        ].join("\n")
      );
      lastAgentText = fixRes.text;
      recordUsage(usageLog, `Stage 3: Fix #${attempt}`, fixRes, budget, "Stage 3: Fix");
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

        const sharedContextPath = path.join(worktree.worktreeDir, ".ai-ship-shared-context.txt");
        fs.writeFileSync(
          sharedContextPath,
          `Task: ${opts.task}\n\nDiff:\n${diff.slice(0, 60000)}\n`,
          "utf8"
        );

        opts.onProgress?.(`Stage 4/4: Parallel 3-lens review (round ${round}/${config.maxReviewRounds})`);
        budget.assertWithinBudget(`Stage 4: Review (round ${round})`);
        const reviews = await runReviewLenses({
          lenses,
          config,
          runner,
          usageLog,
          budget,
        });

        fs.rmSync(sharedContextPath, { force: true });

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

        const reverify = await runDeterministicVerify(worktree.worktreeDir, config);
        if (!reverify.ok) {
          throw new Error(`Verify failed after review fix:\n${reverify.output}`);
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
            `Rebase onto ${rebase.targetRef} hit merge conflicts in:`,
            ...rebase.conflictedFiles.map((f) => `- ${f}`),
            "",
            "Instructions:",
            "- Resolve all conflict markers while preserving both upstream changes and your task implementation.",
            "- Stage resolved files with `git add` and complete the rebase with `GIT_EDITOR=true git rebase --continue`.",
          ].join("\n")
        );
        recordUsage(usageLog, "Pre-PR Rebase", resolveRes, budget, "Pre-PR Rebase");

        if (isRebaseInProgress(worktree.worktreeDir)) {
          abortRebase(worktree.worktreeDir);
          throw new Error(`Rebase onto ${rebase.targetRef} remained incomplete after conflict resolution.`);
        }
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
      const providerConfig = buildOpencodeProviderConfig(config, cfGatewayUrl);
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
  if (result.usageLog.length) {
    lines.push("- Usage:", ...result.usageLog);
  }
  return lines.join("\n");
}
