import test from "node:test";
import assert from "node:assert/strict";
import { formatOpenReviewFindings, formatPipelineResult, runReviewLenses } from "../src/pipeline.ts";
import type { RepoConfig } from "../src/config.ts";
import type { PipelineRunner, PromptOptions } from "../src/runner.ts";
import { resolveShipTaskInput } from "../plugin/index.ts";

test("formatOpenReviewFindings formats each open lens into a markdown section", () => {
  const formatted = formatOpenReviewFindings([
    { lens: "Security", text: "Missing tenant check on line 42.\nVERDICT: OPEN" },
    { lens: "Correctness", text: "Audit event not emitted.\nVERDICT: OPEN" },
  ]);

  assert.equal(
    formatted,
    [
      "### Security Review",
      "Missing tenant check on line 42.",
      "VERDICT: OPEN",
      "",
      "### Correctness Review",
      "Audit event not emitted.",
      "VERDICT: OPEN",
    ].join("\n")
  );
});

test("formatPipelineResult includes diffStat and implSummary even when openPr is false", () => {
  const out = formatPipelineResult(
    {
      repoDir: "/tmp/repo",
      worktreeDir: "/tmp/repo/.ai-ship-worktrees/m2",
      branch: "ai/m2",
      baseBranch: "main",
      provider: "claude-code",
      committed: true,
      diffStat: " src/auth.ts | 12 +++++++++---\n 1 file changed, 9 insertions(+), 3 deletions(-)",
      implSummary: "Added break-glass audit logging.",
      verifyCommands: ["pnpm test"],
      reviewVerdicts: [{ lens: "Security", verdict: "CLEAN" }],
      usageLog: [],
    },
    "M2",
    false
  );

  assert.match(out, /PR: \(not requested\)/);
  assert.match(out, /- Changed files:\n```text\nsrc\/auth\.ts \| 12 \+\+\+\+\+\+\+\+\+---/);
  assert.match(out, /- Implementation summary:\nAdded break-glass audit logging\./);
});

test("resolveShipTaskInput parses --draft and --worktree flags", () => {
  const res = resolveShipTaskInput("Add UI --draft --worktree /tmp/wt");
  assert.equal(res.task, "Add UI");
  assert.equal(res.openPr, true);
  assert.equal(res.draft, true);
  assert.equal(res.worktreeDir, "/tmp/wt");
});


test("runReviewLenses supports per-lens model routing, same-provider pacing, and fallback usage logging", async () => {
  const sleeps: number[] = [];
  const promptCalls: Array<{ title: string; modelOverride?: { providerID: string; modelID: string } }> = [];
  let sessionIdx = 0;
  const sessionTitles = new Map<string, string>();

  const mockRunner: PipelineRunner = {
    async createSession(title: string) {
      const id = `s-${++sessionIdx}`;
      sessionTitles.set(id, title);
      return id;
    },
    async prompt(sessionId: string, _role, _text: string, options?: PromptOptions) {
      const title = sessionTitles.get(sessionId) ?? "";
      promptCalls.push({ title, modelOverride: options?.modelOverride });
      const isSecurity = title.includes("Security");
      return {
        text: "Looks good.\nVERDICT: CLEAN",
        usageSummary: "in=10 out=5",
        ...(isSecurity
          ? {
              fallback: {
                role: "reviewer" as const,
                from: "deepseek/deepseek-reasoner",
                to: "parasail/Qwen/Qwen2.5-Coder-32B-Instruct",
                reason: "HTTP 429",
              },
            }
          : {}),
      };
    },
    close() {},
  };

  const config: RepoConfig = {
    baseBranch: "main",
    verify: [],
    testCommand: null,
    reviewerModel: { providerID: "deepseek", id: "deepseek-reasoner" },
    reviewerLensModels: {
      Performance: { providerID: "parasail", id: "Qwen/Qwen2.5-Coder-32B-Instruct" },
    },
    reviewStaggerMs: 200,
    maxFixRetries: 3,
    maxReviewRounds: 2,
    securityScan: true,
    safetyCheck: true,
  };

  const usageLog: string[] = [];
  const results = await runReviewLenses({
    lenses: [
      { name: "Security", focus: "auth" },
      { name: "Performance", focus: "perf" },
      { name: "Correctness", focus: "bugs" },
    ],
    config,
    runner: mockRunner,
    usageLog,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((r) => ({ lens: r.lens, verdict: r.verdict })),
    [
      { lens: "Security", verdict: "CLEAN" },
      { lens: "Performance", verdict: "CLEAN" },
      { lens: "Correctness", verdict: "CLEAN" },
    ]
  );

  // Security & Correctness share deepseek -> 1st has 0ms, 2nd has 200ms stagger; Performance is on parasail -> 0ms
  assert.deepEqual(sleeps, [200]);

  const perfCall = promptCalls.find((c) => c.title.includes("Performance"));
  assert.deepEqual(perfCall?.modelOverride, {
    providerID: "parasail",
    modelID: "Qwen/Qwen2.5-Coder-32B-Instruct",
  });

  assert.ok(
    usageLog.some((line) =>
      line.includes("[Stage 4: Security Lens Fallback] deepseek/deepseek-reasoner -> parasail/Qwen/Qwen2.5-Coder-32B-Instruct (HTTP 429)")
    )
  );
});
