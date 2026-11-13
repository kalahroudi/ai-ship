import fs from "node:fs";
import path from "node:path";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import { loadRepoConfig, type RepoConfig } from "./config.ts";
import {
  abortRebase,
  commitAll,
  createWorktree,
  getDiff,
  isRebaseInProgress,
  pushAndOpenPR,
  rebaseOntoBase,
  runShell,
  type WorktreeHandle,
} from "./git.ts";
import { buildDreamPrompt, getMemoryPath, readMemory, writeConsolidatedMemory } from "./memory.ts";
import {
  collectRecentTranscripts,
  createOpencodeClientRunner,
  createRunner,
  DEFAULT_CLAUDE_MODEL,
  type OpencodeClient,
  type ProviderName,
} from "./runner.ts";

export interface PipelineOptions {
  repoDir: string;
  task: string;
  openPr: boolean;
  skipTests?: boolean;
  skipReview?: boolean;
  provider?: ProviderName;
  model?: string;
  serverUrl?: string;
  client?: OpencodeClient;
  onProgress?: (stage: string) => void;
}

function formatUsage(label: string, summary: string): string {
  return `  [${label}] ${summary}`;
}

async function runDeterministicVerify(
  worktreeDir: string,
  config: RepoConfig
): Promise<{ ok: boolean; failedCommand?: string; output: string }> {
  if (config.verify.length === 0) {
    return { ok: true, output: "No verify commands configured or detected." };
  }
  const logs: string[] = [];
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

export function resolveCloudflareGatewayUrl(): string | undefined {
  if (process.env.CF_AI_GATEWAY_URL) {
    return process.env.CF_AI_GATEWAY_URL.replace(/\/+$/, "");
  }
  const accountId = process.env.CF_ACCOUNT_ID;
  const gatewayId = process.env.CF_GATEWAY_ID;
  if (accountId && gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openrouter`;
  }
  return undefined;
}

export async function runPipeline(opts: PipelineOptions): Promise<void> {
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

  const worktree: WorktreeHandle = createWorktree(repoDir, config.baseBranch, opts.task);
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
        "- Run relevant local checks before finishing.",
      ].join("\n")
    );
    usageLog.push(formatUsage("Stage 1: Implement", implRes.usageSummary));

    // -------------------------------------------------------------------------
    // Stage 2: Independent Adversarial Test Session (Separate Session & Model)
    // -------------------------------------------------------------------------
    if (!opts.skipTests) {
      opts.onProgress?.("Stage 2/4: Independent adversarial tests");
      console.log("\n[Stage 2/4] Independent adversarial test generation (separate session)...");
      const diff = getDiff(worktree.worktreeDir, worktree.baseBranch);
      if (diff.trim()) {
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
        usageLog.push(formatUsage("Stage 2: Adversarial Tests", testRes.usageSummary));
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
      usageLog.push(formatUsage(`Stage 3: Fix #${attempt}`, fixRes.usageSummary));
    }

    // -------------------------------------------------------------------------
    // Stage 4: Shared-Context Parallel Multi-Lens Review
    // -------------------------------------------------------------------------
    if (!opts.skipReview) {
      const lenses = [
        {
          name: "Security",
          focus: "auth, RBAC/tenant isolation (IDOR), input validation, SQLi/XSS/SSRF, secret handling, rate limiting, and webhook/billing integrity",
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

        const reviews = await Promise.all(
          lenses.map(async (lens) => {
            const sid = await runner.createSession(`Review (${lens.name})`);
            const r = await runner.prompt(
              sid,
              "reviewer",
              [
                `Review lens: ${lens.name}`,
                `Focus strictly on: ${lens.focus}.`,
                `Read .ai-ship-shared-context.txt in the repo root.`,
                "Report ONLY concrete, reproducible high/critical issues with exact file paths, line numbers, and how to reproduce.",
                "End with `VERDICT: CLEAN` or `VERDICT: OPEN`.",
              ].join("\n")
            );
            usageLog.push(formatUsage(`Stage 4: ${lens.name} Lens`, r.usageSummary));
            return { lens: lens.name, text: r.text, verdict: parseVerdict(r.text) };
          })
        );

        fs.rmSync(sharedContextPath, { force: true });

        const openFindings = reviews.filter((r) => r.verdict === "OPEN");
        for (const r of reviews) {
          console.log(`  -> ${r.lens}: ${r.verdict}`);
        }

        if (openFindings.length === 0) {
          console.log("  -> All review lenses CLEAN.");
          break;
        }

        if (round === config.maxReviewRounds) {
          console.log("\n[ai-ship] Review findings remain open after max rounds:");
          for (const f of openFindings) {
            console.log(`\n--- ${f.lens} ---\n${f.text}`);
          }
          throw new Error("Review findings remain OPEN. Inspect the worktree before pushing.");
        }

        console.log("  -> Sending OPEN findings back to implementer...");
        const findingsText = openFindings
          .map((f) => `### ${f.lens} Review\n${f.text}`)
          .join("\n\n");
        const fixReviewRes = await runner.prompt(
          implSessionId,
          "implementer",
          `Address these review findings, then re-run local checks:\n\n${findingsText}`
        );
        usageLog.push(formatUsage(`Stage 4: Review Fix #${round}`, fixReviewRes.usageSummary));

        const reverify = await runDeterministicVerify(worktree.worktreeDir, config);
        if (!reverify.ok) {
          throw new Error(`Verify failed after review fix:\n${reverify.output}`);
        }
      }
    }

    // -------------------------------------------------------------------------
    // Commit & Optional PR
    // -------------------------------------------------------------------------
    const committed = commitAll(worktree.worktreeDir, `feat: ${opts.task.slice(0, 72)}`);
    console.log(`\n[ai-ship] Done! Branch: ${worktree.branch} (${committed ? "committed" : "no changes"})`);
    console.log(`[ai-ship] Worktree: ${worktree.worktreeDir}`);
    console.log("\n[ai-ship] Token & Cost Summary:");
    for (const line of usageLog) console.log(line);

    if (opts.openPr && committed) {
      console.log(`\n[ai-ship] Ensuring branch is up-to-date with ${worktree.baseBranch}...`);
      const rebase = rebaseOntoBase(worktree);
      if (rebase.conflicted) {
        console.log(
          `  -> Rebase onto ${rebase.targetRef} hit conflicts in: ${rebase.conflictedFiles.join(", ")}. Asking implementer to resolve...`
        );
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
        usageLog.push(formatUsage("Pre-PR Rebase", resolveRes.usageSummary));

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
      opts.onProgress?.("Pushing branch and opening PR");
      pushAndOpenPR(
        worktree,
        opts.task.slice(0, 72),
        `Automated via \`ai-ship\` (${provider}).\n\nVerified locally with:\n${config.verify.map((c) => `- \`${c}\``).join("\n")}`
      );
    }
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
      const started = await createOpencode({
        port: 0,
        ...(cfGatewayUrl
          ? {
              config: {
                provider: { openrouter: { options: { baseURL: cfGatewayUrl } } },
              },
            }
          : {}),
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
      model: opts.model ?? "openrouter/google/gemini-2.5-flash",
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
