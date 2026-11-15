import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  computeCost,
  findPricing,
  findUnpricedModels,
  loadPricingTable,
  normalizePricing,
  resolveCost,
  toOpencodeCost,
  type PricingTable,
} from "../src/pricing.ts";
import {
  buildOpencodeProviderConfig,
  createOpencodeClientRunner,
  EmptyModelResponseError,
  parseClaudeJsonOutput,
  sumStepUsage,
  executeWithFailoverAndRetry,
  type OpencodeClient,
  type PromptResult,
} from "../src/runner.ts";
import { BudgetExceededError, BudgetTracker, runPipeline } from "../src/pipeline.ts";
import type { RepoConfig } from "../src/config.ts";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withModelsFile<T>(content: string | null, fn: (file: string) => T): T {
  const dir = tmpDir("ai-ship-pricing-");
  const file = path.join(dir, "models.json");
  if (content !== null) fs.writeFileSync(file, content, "utf8");
  const prev = process.env.AI_SHIP_MODELS_FILE;
  process.env.AI_SHIP_MODELS_FILE = file;
  const restore = () => {
    if (prev === undefined) delete process.env.AI_SHIP_MODELS_FILE;
    else process.env.AI_SHIP_MODELS_FILE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  let res: T;
  try {
    res = fn(file);
  } catch (e) {
    restore();
    throw e;
  }
  if (res instanceof Promise) return res.finally(restore) as T;
  restore();
  return res;
}

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

test("normalizePricing drops entries without numeric in/out (null placeholders)", () => {
  const t = normalizePricing({
    "a/ok": { in: 1, out: 2, cacheRead: 0.1, checked: "2026-01-01" },
    "a/nulls": { in: null, out: null },
    "a/half": { in: 1 },
    "a/str": { in: "1", out: "2" },
    "a/neg": { in: -1, out: 2 },
    "a/notobj": 5,
  });
  assert.deepEqual(Object.keys(t), ["a/ok"]);
  assert.deepEqual(t["a/ok"], { in: 1, out: 2, cacheRead: 0.1, checked: "2026-01-01" });
  assert.deepEqual(normalizePricing(null), {});
  assert.deepEqual(normalizePricing([1, 2]), {});
});

test("templates/models.json normalizes without throwing (null entries are dropped)", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "templates", "models.json"), "utf8"));
  const t = normalizePricing(raw.pricing);
  for (const p of Object.values(t)) {
    assert.equal(typeof p.in, "number");
    assert.equal(typeof p.out, "number");
  }
});

test("loadPricingTable merges file and repo override (repo wins) and tolerates a malformed file", () => {
  withModelsFile(
    JSON.stringify({ pricing: { "p/a": { in: 1, out: 2 }, "p/b": { in: 3, out: 4 } } }),
    (file) => {
      const t = loadPricingTable({ "p/b": { in: 30, out: 40 }, "p/c": { in: 5, out: 6 } }, file);
      assert.deepEqual(t["p/a"], { in: 1, out: 2 });
      assert.deepEqual(t["p/b"], { in: 30, out: 40 });
      assert.deepEqual(t["p/c"], { in: 5, out: 6 });
      // default path comes from the env var
      assert.deepEqual(loadPricingTable()["p/a"], { in: 1, out: 2 });
    }
  );
  withModelsFile("{ not json", (file) => {
    const orig = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(loadPricingTable({ "p/c": { in: 5, out: 6 } }, file), { "p/c": { in: 5, out: 6 } });
      assert.deepEqual(loadPricingTable(undefined, file), {});
    } finally {
      console.error = orig;
    }
  });
  withModelsFile(null, (file) => assert.deepEqual(loadPricingTable(undefined, file), {}));
});

test("findPricing: exact, case-insensitive, suffix, longest suffix wins, missing", () => {
  const table: PricingTable = {
    "deepseek/deepseek-chat": { in: 1, out: 2 },
    "Parasail/Foo": { in: 3, out: 4 },
    "deepseek-chat": { in: 9, out: 9 },
    "x/deepseek/deepseek-chat": { in: 7, out: 7 },
  };
  assert.equal(findPricing(table, "deepseek/deepseek-chat")?.in, 1);
  assert.equal(findPricing(table, "parasail/foo")?.in, 3);
  assert.equal(findPricing(table, "DEEPSEEK/DEEPSEEK-CHAT")?.in, 1);
  // longest suffix wins over the shorter `deepseek-chat` key
  assert.equal(findPricing(table, "cloudflare-ai-gateway/deepseek/deepseek-chat")?.in, 1);
  assert.equal(findPricing(table, "y/x/deepseek/deepseek-chat")?.in, 7);
  assert.equal(findPricing(table, "other/unknown"), undefined);
  assert.equal(findPricing(table, undefined), undefined);
  assert.equal(findPricing({ "chat": { in: 1, out: 1 } }, "xchat"), undefined, "suffix must be on a path boundary");
});

test("computeCost: reasoning billed as output; cache prices default to the input price", () => {
  const p = { in: 1, out: 4 };
  near(computeCost({ input: 1_000_000, output: 0, cacheRead: 0 }, p), 1);
  near(computeCost({ input: 0, output: 500_000, reasoning: 500_000, cacheRead: 0 }, p), 4);
  near(computeCost({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, p), 2);
  near(
    computeCost({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, { ...p, cacheRead: 0.1, cacheWrite: 1.25 }),
    1.35
  );
  near(computeCost({ input: 1_000_000, output: 1_000_000, reasoning: 1_000_000, cacheRead: 0 }, p), 9);
});

test("resolveCost: provider cost kept, zero provider cost computed, unknown, none", () => {
  const table: PricingTable = { "p/m": { in: 1, out: 2 } };
  const u = { input: 1_000_000, output: 1_000_000, cacheRead: 0 };
  assert.deepEqual(resolveCost(u, 0.5, "p/m", table), { costUsd: 0.5, costSource: "provider" });
  const c = resolveCost(u, 0, "p/m", table);
  assert.equal(c.costSource, "computed");
  near(c.costUsd, 3);
  assert.equal(resolveCost(u, undefined, "p/m", table).costSource, "computed");
  assert.deepEqual(resolveCost(u, 0, "p/none", table), { costUsd: 0, costSource: "unknown" });
  assert.deepEqual(resolveCost({ input: 0, output: 0, cacheRead: 0 }, 0, "p/m", table), { costUsd: 0, costSource: "none" });
  assert.deepEqual(resolveCost({ input: 0, output: 0, cacheRead: 0 }, 0, "p/none", table), { costUsd: 0, costSource: "none" });
});

test("findUnpricedModels / toOpencodeCost", () => {
  const table: PricingTable = { "p/m": { in: 1, out: 2, cacheRead: 0.5 } };
  assert.deepEqual(findUnpricedModels(table, ["p/m", "q/x", undefined, "q/x"]), ["q/x"]);
  assert.deepEqual(toOpencodeCost(table["p/m"]), { input: 1, output: 2, cache_read: 0.5, cache_write: 1 });
  assert.deepEqual(toOpencodeCost({ in: 3, out: 4 }), { input: 3, output: 4, cache_read: 3, cache_write: 3 });
});

function fakeClient(info: Record<string, unknown>, seenModels?: unknown[]): OpencodeClient {
  return {
    session: {
      create: async () => ({ data: { id: "s1" } }),
      prompt: async (args: { body?: { model?: unknown } }) => {
        seenModels?.push(args.body?.model);
        return { data: { parts: [{ type: "text", text: "ok" }], info } };
      },
    },
  } as unknown as OpencodeClient;
}

function cfg(extra: Partial<RepoConfig> = {}): RepoConfig {
  return {
    baseBranch: "main",
    verify: [],
    testCommand: null,
    implementerModel: { providerID: "custom", id: "big-model" },
    testerModel: { providerID: "parasail", id: "tester-m" },
    reviewerModel: { providerID: "deepseek", id: "deepseek-reasoner" },
    bughunterModel: { providerID: "parasail", id: "hunter-m" },
    maxFixRetries: 1,
    maxReviewRounds: 1,
    securityScan: false,
    safetyCheck: false,
    ...extra,
  } as RepoConfig;
}

test("opencode runner: info.cost 0 + tokens -> computed cost from the pricing table", async () => {
  const client = fakeClient({
    cost: 0,
    tokens: { input: 1_000_000, output: 500_000, reasoning: 500_000, cache: { read: 1_000_000, write: 1_000_000 } },
  });
  const runner = createOpencodeClientRunner({
    client,
    worktreeDir: "/tmp/r",
    config: cfg(),
    pricing: { "custom/big-model": { in: 1, out: 2, cacheRead: 0.1, cacheWrite: 1.5 } },
  });
  const res = await runner.prompt("s1", "implementer", "hi");
  assert.equal(res.usage?.costSource, "computed");
  // 1*1 + (0.5+0.5)*2 + 1*0.1 + 1*1.5 = 4.6
  near(res.usage!.costUsd, 4.6);
  assert.equal(res.usage?.reasoning, 500_000);
  assert.equal(res.usage?.cacheWrite, 1_000_000);
  assert.equal(res.model, "custom/big-model");
  assert.match(res.usageSummary ?? "", /computed/);
});

test("opencode runner: unpriced model reports costSource unknown; provider cost is kept", async () => {
  const unpriced = createOpencodeClientRunner({
    client: fakeClient({ cost: 0, tokens: { input: 100, output: 50 } }),
    worktreeDir: "/tmp/r",
    config: cfg(),
    pricing: {},
  });
  const r1 = await unpriced.prompt("s1", "implementer", "hi");
  assert.equal(r1.usage?.costSource, "unknown");
  assert.equal(r1.usage?.costUsd, 0);
  assert.match(r1.usageSummary ?? "", /unknown/);

  const provider = createOpencodeClientRunner({
    client: fakeClient({ cost: 0.42, tokens: { input: 100, output: 50 } }),
    worktreeDir: "/tmp/r",
    config: cfg(),
    pricing: { "custom/big-model": { in: 100, out: 100 } },
  });
  const r2 = await provider.prompt("s1", "implementer", "hi");
  assert.equal(r2.usage?.costSource, "provider");
  assert.equal(r2.usage?.costUsd, 0.42);
});

test("opencode runner: model label falls back to info.providerID/modelID when no model is configured", async () => {
  const runner = createOpencodeClientRunner({
    client: fakeClient({ cost: 0, providerID: "gw", modelID: "acme/model-x", tokens: { input: 1_000_000, output: 0 } }),
    worktreeDir: "/tmp/r",
    config: { baseBranch: "main", verify: [], testCommand: null, maxFixRetries: 1, maxReviewRounds: 1 } as unknown as RepoConfig,
    pricing: { "acme/model-x": { in: 2, out: 2 } },
  });
  const res = await runner.prompt("s1", "implementer", "hi");
  assert.equal(res.model, "gw/acme/model-x");
  assert.equal(res.usage?.costSource, "computed");
  near(res.usage!.costUsd, 2);
});

test("executeWithFailoverAndRetry folds usage of wasted empty-reply attempts into the final result", async () => {
  const u1 = { input: 100, output: 10, cacheRead: 0, costUsd: 0.01, reasoning: 5, costSource: "computed" as const };
  const u2 = { input: 200, output: 20, cacheRead: 7, costUsd: 0.02, cacheWrite: 3, costSource: "computed" as const };
  let calls = 0;
  const res = await executeWithFailoverAndRetry({
    role: "reviewer",
    retry: { maxRetries: 3, sleep: async () => {} },
    invoke: async (): Promise<PromptResult> => {
      calls += 1;
      if (calls === 1) throw new EmptyModelResponseError("reviewer", u1);
      if (calls === 2) throw new EmptyModelResponseError("reviewer", u2);
      return {
        text: "VERDICT: CLEAN",
        usageSummary: "",
        usage: { input: 1000, output: 100, cacheRead: 0, costUsd: 0.1, costSource: "computed" },
      };
    },
  });
  assert.equal(calls, 3);
  assert.equal(res.wastedAttempts, 2);
  assert.equal(res.usage?.input, 1300);
  assert.equal(res.usage?.output, 130);
  assert.equal(res.usage?.cacheRead, 7);
  assert.equal(res.usage?.reasoning, 5);
  assert.equal(res.usage?.cacheWrite, 3);
  near(res.usage!.costUsd, 0.13);
  assert.match(res.usageSummary ?? "", /in=1300/);
});

test("executeWithFailoverAndRetry: single wasted attempt counts once; clean run has no wastedAttempts", async () => {
  let n = 0;
  const res = await executeWithFailoverAndRetry({
    role: "reviewer",
    retry: { maxRetries: 2, sleep: async () => {} },
    invoke: async () => {
      if (++n === 1)
        throw new EmptyModelResponseError("reviewer", { input: 10, output: 1, cacheRead: 0, costUsd: 0.5 });
      return { text: "x", usageSummary: "", usage: { input: 1, output: 1, cacheRead: 0, costUsd: 0.25 } };
    },
  });
  assert.equal(res.wastedAttempts, 1);
  near(res.usage!.costUsd, 0.75);

  const clean = await executeWithFailoverAndRetry({
    role: "reviewer",
    retry: { maxRetries: 2, sleep: async () => {} },
    invoke: async () => ({ text: "x", usageSummary: "", usage: { input: 1, output: 1, cacheRead: 0, costUsd: 0.25 } }),
  });
  assert.equal(clean.wastedAttempts, undefined);
  assert.equal(clean.usage?.costUsd, 0.25);
});

test("BudgetTracker: a computed-cost call trips maxTaskCostUsd (old $0 bug)", () => {
  const table: PricingTable = { "custom/big-model": { in: 10, out: 30 } };
  const raw = { input: 1_000_000, output: 500_000, reasoning: 500_000, cacheRead: 0 };
  const resolved = resolveCost(raw, 0, "custom/big-model", table);
  const tracker = new BudgetTracker({ maxTaskCostUsd: 1 });
  tracker.record("Stage 1: Implement", {
    text: "ok",
    usageSummary: "",
    usage: { ...raw, costUsd: resolved.costUsd, costSource: resolved.costSource },
  });
  assert.equal(tracker.getTotals().costUsd, 40);
  assert.throws(() => tracker.assertWithinBudget("Stage 2"), BudgetExceededError);
});

test("BudgetTracker counts reasoning and cacheWrite tokens and unknown-cost calls with a [WARNING] line", () => {
  const tracker = new BudgetTracker({ maxTaskTokens: 1000 });
  tracker.record("Stage 1: Implement", {
    text: "ok",
    usageSummary: "",
    usage: { input: 100, output: 100, cacheRead: 100, reasoning: 300, cacheWrite: 300, costUsd: 0, costSource: "unknown" },
  });
  tracker.record("Stage 1: Implement", {
    text: "ok",
    usageSummary: "",
    usage: { input: 1, output: 1, cacheRead: 0, costUsd: 0.01, costSource: "provider" },
  });
  const totals = tracker.getTotals();
  assert.equal(totals.totalTokens, 902);
  assert.equal(totals.unknownCostCalls, 1);
  assert.equal(tracker.getStageSummaries()[0].unknownCostCalls, 1);
  const lines = tracker.formatSummaryLines().join("\n");
  assert.match(lines, /\[WARNING\] 1 call\(s\) had no provider cost and no pricing entry/);
  assert.match(lines, /1 with UNKNOWN cost/);

  tracker.record("Stage 2", { text: "ok", usageSummary: "", usage: { input: 0, output: 0, cacheRead: 0, reasoning: 200, costUsd: 0 } });
  assert.throws(() => tracker.assertWithinBudget("Stage 3"), BudgetExceededError);

  const clean = new BudgetTracker({});
  clean.record("S", { text: "ok", usageSummary: "", usage: { input: 1, output: 1, cacheRead: 0, costUsd: 0.01, costSource: "provider" } });
  assert.ok(!clean.formatSummaryLines().join("\n").includes("[WARNING]"));
});

test("buildOpencodeProviderConfig adds cost to priced declared models and leaves explicit cost alone", () => {
  const config = {
    baseBranch: "main",
    verify: [],
    testCommand: null,
    providers: {
      custom: {
        npm: "@ai-sdk/openai-compatible",
        baseURL: "https://example.invalid/v1",
        models: {
          priced: { name: "Priced" },
          explicit: { name: "Explicit", cost: { input: 99, output: 99 } },
          unpriced: { name: "Unpriced" },
        },
      },
    },
  } as unknown as RepoConfig;
  const pricing: PricingTable = {
    "custom/priced": { in: 1, out: 2, cacheRead: 0.5 },
    "custom/explicit": { in: 1, out: 2 },
  };
  const out = buildOpencodeProviderConfig(config, undefined, undefined, pricing);
  const models = out?.custom?.models as Record<string, Record<string, unknown>>;
  assert.deepEqual(models.priced, { name: "Priced", cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 1 } });
  assert.deepEqual(models.explicit.cost, { input: 99, output: 99 });
  assert.equal("cost" in models.unpriced, false);
});

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd: dir, stdio: "ignore" });
}

test("runPipeline preflight with requirePricing rejects an unpriced model before creating a worktree or prompting", async () => {
  const repoDir = tmpDir("ai-ship-pricing-repo-");
  try {
    git(repoDir, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# t\n");
    fs.writeFileSync(path.join(repoDir, ".gitignore"), ".ai-ship-worktrees/\n");
    fs.writeFileSync(
      path.join(repoDir, ".ai-ship.json"),
      JSON.stringify({
        baseBranch: "main",
        verify: [],
        maxFixRetries: 1,
        maxReviewRounds: 1,
        securityScan: false,
        safetyCheck: false,
        requirePricing: true,
      })
    );
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-q", "-m", "init");
    let prompted = 0;
    const client = {
      session: {
        create: async () => {
          prompted++;
          return { data: { id: "s" } };
        },
        prompt: async () => {
          prompted++;
          return { data: { parts: [{ type: "text", text: "x" }], info: { cost: 0, tokens: { input: 1, output: 1 } } } };
        },
      },
    } as unknown as OpencodeClient;
    await withModelsFile(JSON.stringify({ pricing: {} }), async () => {
      await assert.rejects(
        () => runPipeline({ repoDir, task: "t", openPr: false, skipTests: true, skipReview: true, client }),
        /No pricing for .*requirePricing/s
      );
    });
    assert.equal(prompted, 0);
    assert.equal(fs.existsSync(path.join(repoDir, ".ai-ship-worktrees")), false);
    assert.equal(execFileSync("git", ["branch", "--list"], { cwd: repoDir, encoding: "utf8" }).trim().split("\n").length, 1);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

const step = (role: string, parentID: string, cost: number, tokens: Record<string, unknown>) => ({
  info: { role, parentID, cost, tokens },
});

test("sumStepUsage sums assistant steps with the matching parentID only", () => {
  const msgs = [
    step("user", "p1", 5, { input: 999, output: 999 }),
    step("assistant", "p1", 0.1, { input: 100, output: 10, reasoning: 5, cache: { read: 20, write: 3 } }),
    step("assistant", "p2", 7, { input: 5000, output: 5000 }),
    step("assistant", "p1", 0.2, { input: 200, output: 20, cache: { read: 30 } }),
  ];
  const u = sumStepUsage(msgs, "p1")!;
  assert.equal(u.input, 300);
  assert.equal(u.output, 30);
  assert.equal(u.reasoning, 5);
  assert.equal(u.cacheRead, 50);
  assert.equal(u.cacheWrite, 3);
  near(u.costUsd, 0.3);
  assert.equal(u.costSource, "provider");
  assert.equal(sumStepUsage(msgs, "nope"), undefined);
  assert.equal(sumStepUsage([step("assistant", "p1", 0, { input: 1, output: 1 })], "p1")?.costSource, "unknown");
});

function multiStepClient(messages: () => Promise<unknown>, lastCost: number): OpencodeClient {
  return {
    session: {
      create: async () => ({ data: { id: "s1" } }),
      prompt: async () => ({
        data: { parts: [{ type: "text", text: "ok" }], info: { parentID: "p1", cost: lastCost, tokens: { input: 1, output: 1 } } },
      }),
      messages,
    },
  } as unknown as OpencodeClient;
}

test("opencode runner sums all steps via session.messages (provider cost, priced fallback, error fallback)", async () => {
  const msgs = (c1: number, c2: number) => async () => ({
    data: [
      step("assistant", "p1", c1, { input: 1_000_000, output: 0 }),
      step("assistant", "other", 9, { input: 9_000_000, output: 0 }),
      step("assistant", "p1", c2, { input: 1_000_000, output: 0 }),
    ],
  });
  const mk = (client: OpencodeClient, pricing: PricingTable) =>
    createOpencodeClientRunner({ client, worktreeDir: "/tmp/r", config: cfg(), pricing });

  const r1 = await mk(multiStepClient(msgs(0.5, 0.25), 0.25), {}).prompt("s1", "implementer", "x");
  assert.equal(r1.usage?.input, 2_000_000);
  assert.equal(r1.usage?.costSource, "provider");
  near(r1.usage!.costUsd, 0.75);

  const r2 = await mk(multiStepClient(msgs(0, 0), 0), { "custom/big-model": { in: 1, out: 1 } }).prompt("s1", "implementer", "x");
  assert.equal(r2.usage?.input, 2_000_000);
  assert.equal(r2.usage?.costSource, "computed");
  near(r2.usage!.costUsd, 2);

  const r3 = await mk(
    multiStepClient(async () => {
      throw new Error("boom");
    }, 0),
    { "custom/big-model": { in: 1, out: 1 } }
  ).prompt("s1", "implementer", "x");
  assert.equal(r3.usage?.input, 1, "falls back to last-step usage");
});

test("BudgetTracker failOnUnknownCost throws on an unknown-cost call but not on known ones", () => {
  const t = new BudgetTracker({ failOnUnknownCost: true });
  t.record("S", { text: "ok", usageSummary: "", usage: { input: 1, output: 1, cacheRead: 0, costUsd: 0.1, costSource: "provider" } });
  t.record("S", { text: "ok", usageSummary: "", usage: { input: 0, output: 0, cacheRead: 0, costUsd: 0, costSource: "none" } });
  assert.throws(
    () => t.record("S", { text: "ok", usageSummary: "", usage: { input: 1, output: 1, cacheRead: 0, costUsd: 0, costSource: "unknown" } }),
    /cost is unknown/
  );
  const lenient = new BudgetTracker({});
  assert.doesNotThrow(() =>
    lenient.record("S", { text: "ok", usageSummary: "", usage: { input: 1, output: 1, cacheRead: 0, costUsd: 0, costSource: "unknown" } })
  );
});

test("executeWithFailoverAndRetry attaches wastedUsage to the error when retries are exhausted", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      executeWithFailoverAndRetry({
        role: "reviewer",
        retry: { maxRetries: 2, sleep: async () => {} },
        invoke: async () => {
          calls++;
          throw new EmptyModelResponseError("reviewer", { input: 10, output: 1, cacheRead: 0, costUsd: 0.5 });
        },
      }),
    (err: unknown) => {
      const w = (err as { wastedUsage?: { input: number; costUsd: number } }).wastedUsage;
      assert.ok(w);
      assert.equal(w.input, 10 * calls);
      near(w.costUsd, 0.5 * calls);
      return err instanceof EmptyModelResponseError;
    }
  );
  assert.equal(calls, 3);
});

test("parseClaudeJsonOutput: costSource provider / unknown / none", () => {
  const mk = (o: Record<string, unknown>) => parseClaudeJsonOutput(JSON.stringify({ type: "result", result: "hi", ...o })).usage;
  assert.equal(mk({ total_cost_usd: 0.1, usage: { input_tokens: 5, output_tokens: 5 } })?.costSource, "provider");
  assert.equal(mk({ usage: { input_tokens: 5, output_tokens: 5 } })?.costSource, "unknown");
  assert.equal(mk({ usage: { input_tokens: 0, output_tokens: 0 } })?.costSource, "none");
});

test("runPipeline requirePricing also rejects roles with no configured model", async () => {
  const repoDir = tmpDir("ai-ship-pricing-repo2-");
  try {
    git(repoDir, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# t\n");
    fs.writeFileSync(path.join(repoDir, ".gitignore"), ".ai-ship-worktrees/\n");
    fs.writeFileSync(
      path.join(repoDir, ".ai-ship.json"),
      JSON.stringify({
        baseBranch: "main",
        verify: [],
        securityScan: false,
        safetyCheck: false,
        requirePricing: true,
        implementerModel: { providerID: "p", id: "impl" },
        reviewerModel: { providerID: "p", id: "rev" },
        bughunterModel: { providerID: "p", id: "hunt" },
        testerModel: null,
        pricing: { "p/impl": { in: 1, out: 1 }, "p/rev": { in: 1, out: 1 }, "p/hunt": { in: 1, out: 1 } },
      })
    );
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-q", "-m", "init");
    const client = { session: { create: async () => ({ data: { id: "s" } }), prompt: async () => ({}) } } as unknown as OpencodeClient;
    await withModelsFile(null, async () => {
      await assert.rejects(
        () => runPipeline({ repoDir, task: "t", openPr: false, skipTests: true, skipReview: true, client, model: undefined }),
        (err: unknown) => {
          const m = (err as Error).message;
          assert.match(m, /roles without a configured model/);
          assert.match(m, /tester/);
          assert.doesNotMatch(m, /No pricing for/);
          return true;
        }
      );
    });
    assert.equal(fs.existsSync(path.join(repoDir, ".ai-ship-worktrees")), false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
