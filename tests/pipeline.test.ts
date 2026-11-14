import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  BudgetExceededError,
  BudgetTracker,
  formatOpenReviewFindings,
  formatPipelineResult,
  runPipeline,
  runReviewLenses,
} from "../src/pipeline.ts";
import type { RepoConfig } from "../src/config.ts";
import type { OpencodeClient, PipelineRunner, PromptOptions } from "../src/runner.ts";
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

test("BudgetTracker accumulates structured and summary usage per stage and trips on USD or token limits", () => {
  const tracker = new BudgetTracker({ maxTaskCostUsd: 0.05, maxTaskTokens: 1000 });
  tracker.record("Stage 1: Implement", {
    text: "ok",
    usageSummary: "in=200 out=100 cache_read=50 | $0.0200",
    usage: { input: 200, output: 100, cacheRead: 50, costUsd: 0.02 },
  });
  tracker.assertWithinBudget("Stage 2: Adversarial Tests");

  // Fallback parsing from usageSummary when structured usage is omitted
  tracker.record("Stage 3: Fix", {
    text: "fixed",
    usageSummary: "in=300 out=100 cache_read=100 | $0.0200",
  });
  tracker.assertWithinBudget("Stage 3: Fix #2");

  // Trip cost threshold
  tracker.record("Stage 3: Fix", {
    text: "fixed again",
    usageSummary: "in=100 out=50 cache_read=0 | $0.0150",
    usage: { input: 100, output: 50, cacheRead: 0, costUsd: 0.015 },
  });

  const totals = tracker.getTotals();
  assert.equal(totals.input, 600);
  assert.equal(totals.output, 250);
  assert.equal(totals.cacheRead, 150);
  assert.equal(totals.totalTokens, 1000);
  assert.ok(Math.abs(totals.costUsd - 0.055) < 1e-9);

  const stages = tracker.getStageSummaries();
  assert.equal(stages.length, 2);
  assert.equal(stages[0].stage, "Stage 1: Implement");
  assert.equal(stages[0].calls, 1);
  assert.equal(stages[1].stage, "Stage 3: Fix");
  assert.equal(stages[1].calls, 2);

  assert.throws(
    () => tracker.assertWithinBudget("Stage 4: Review (round 1)"),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.match(err.message, /Budget exceeded before "Stage 4: Review \(round 1\)"/);
      assert.match(err.message, /maxTaskCostUsd \$0\.0500/);
      assert.match(err.message, /maxTaskTokens 1000/);
      assert.match(err.message, /Stage 1: Implement: \$0\.0200/);
      assert.match(err.message, /Stage 3: Fix: \$0\.0350/);
      return true;
    }
  );
});

test("runReviewLenses aborts with BudgetExceededError before launching next lens when budget is reached", async () => {
  let promptCount = 0;
  let sessionIdx = 0;
  const mockRunner: PipelineRunner = {
    async createSession() {
      return `s-${++sessionIdx}`;
    },
    async prompt() {
      promptCount += 1;
      return {
        text: "VERDICT: CLEAN",
        usageSummary: "in=100 out=50 cache_read=0 | $0.0300",
        usage: { input: 100, output: 50, cacheRead: 0, costUsd: 0.03 },
      };
    },
    close() {},
  };

  const budget = new BudgetTracker({ maxTaskCostUsd: 0.03 });
  const config: RepoConfig = {
    baseBranch: "main",
    verify: [],
    testCommand: null,
    reviewConcurrency: 1,
    reviewStaggerMs: 0,
    maxFixRetries: 3,
    maxReviewRounds: 2,
    securityScan: false,
    safetyCheck: false,
  };

  await assert.rejects(
    () =>
      runReviewLenses({
        lenses: [
          { name: "Security", focus: "auth" },
          { name: "Performance", focus: "perf" },
        ],
        config,
        runner: mockRunner,
        usageLog: [],
        budget,
      }),
    BudgetExceededError
  );
  assert.equal(promptCount, 1);
});

function initTempGitRepo(aiShipConfig: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-budget-pipe-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  fs.writeFileSync(path.join(dir, ".ai-ship.json"), JSON.stringify(aiShipConfig, null, 2));
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

test("runPipeline records per-stage cost totals and trips circuit breaker before stuck fix retry", async () => {
  const repoDir = initTempGitRepo({
    baseBranch: "main",
    verify: ["node -e \"process.exit(1)\""],
    maxFixRetries: 3,
    maxReviewRounds: 1,
    maxTaskCostUsd: 0.05,
    maxTaskTokens: 10000,
    securityScan: false,
    safetyCheck: false,
  });

  let promptCalls = 0;
  let sessionIdx = 0;
  const fakeClient = {
    session: {
      async create() {
        return { data: { id: `sess-${++sessionIdx}` } };
      },
      async prompt() {
        promptCalls += 1;
        return {
          data: {
            parts: [{ type: "text", text: "Attempted change" }],
            info: {
              cost: 0.06,
              tokens: { input: 300, output: 150, cache: { read: 50 } },
            },
          },
        };
      },
    },
  } as unknown as OpencodeClient;

  try {
    await assert.rejects(
      () =>
        runPipeline({
          repoDir,
          task: "Test budget breaker",
          openPr: false,
          skipTests: true,
          skipReview: true,
          client: fakeClient,
        }),
      (err: unknown) => {
        assert.ok(err instanceof BudgetExceededError);
        assert.match(err.message, /Budget exceeded before "Stage 3: Fix #1"/);
        assert.match(err.message, /Stage 1: Implement: \$0\.0600/);
        return true;
      }
    );
    // Only Stage 1 ran; Stage 3 Fix #1 was blocked before launching
    assert.equal(promptCalls, 1);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("runPipeline includes per-stage and task totals in result and usageLog on success", async () => {
  const repoDir = initTempGitRepo({
    baseBranch: "main",
    verify: [],
    maxFixRetries: 1,
    maxReviewRounds: 1,
    maxTaskCostUsd: 5,
    maxTaskTokens: 100000,
    securityScan: false,
    safetyCheck: false,
  });

  let sessionIdx = 0;
  const fakeClient = {
    session: {
      async create() {
        return { data: { id: `sess-${++sessionIdx}` } };
      },
      async prompt() {
        return {
          data: {
            parts: [{ type: "text", text: "Done.\nVERDICT: CLEAN" }],
            info: {
              cost: 0.025,
              tokens: { input: 100, output: 40, cache: { read: 10 } },
            },
          },
        };
      },
    },
  } as unknown as OpencodeClient;

  try {
    const result = await runPipeline({
      repoDir,
      task: "Test usage summary",
      openPr: false,
      skipTests: true,
      skipReview: true,
      client: fakeClient,
    });

    assert.equal(result.totalUsage?.input, 100);
    assert.equal(result.totalUsage?.output, 40);
    assert.equal(result.totalUsage?.cacheRead, 10);
    assert.equal(result.totalUsage?.totalTokens, 150);
    assert.ok(Math.abs((result.totalUsage?.costUsd ?? 0) - 0.025) < 1e-9);
    assert.equal(result.stageUsage?.length, 1);
    assert.equal(result.stageUsage?.[0].stage, "Stage 1: Implement");
    assert.ok(result.usageLog.some((l) => l.includes("[Stage Totals]")));
    assert.ok(result.usageLog.some((l) => l.includes("[Task Total] in=100 out=40 cache_read=10 total=150 | $0.0250")));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
