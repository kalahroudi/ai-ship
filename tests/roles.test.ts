import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runPipeline } from "../src/pipeline.ts";
import {
  checkModelIndependence,
  createClaudeCodeRunner,
  createOpencodeClientRunner,
  formatRoleModelTable,
  ModelIndependenceError,
  resolveRoleModelLabels,
  type OpencodeClient,
} from "../src/runner.ts";
import { parseCliArgs, type RepoConfig } from "../src/config.ts";
import { handleMcpRequest, type McpToolDeps } from "../src/mcp.ts";

// Hermetic pricing: never read the developer's real ~/.config/ai-ship/models.json.
const prevModelsFile = process.env.AI_SHIP_MODELS_FILE;
process.env.AI_SHIP_MODELS_FILE = path.join(os.tmpdir(), `ai-ship-no-models-${process.pid}.json`);
process.on("exit", () => {
  if (prevModelsFile === undefined) delete process.env.AI_SHIP_MODELS_FILE;
  else process.env.AI_SHIP_MODELS_FILE = prevModelsFile;
});


type M = { providerID: string; modelID: string } | undefined;

function baseConfig(extra: Partial<RepoConfig> = {}): RepoConfig {
  return {
    baseBranch: "main",
    verify: [],
    testCommand: null,
    implementerModel: { providerID: "deepseek", id: "deepseek-chat" },
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

function recordingClient(seen: M[]): OpencodeClient {
  return {
    session: {
      create: async () => ({ data: { id: "s1" } }),
      prompt: async (args: { body?: { model?: M } }) => {
        seen.push(args.body?.model);
        return { data: { parts: [{ type: "text", text: "ok" }], info: { cost: 0, tokens: { input: 1, output: 1 } } } };
      },
    },
  } as unknown as OpencodeClient;
}

async function runRoles(runner: any, overrideForReviewer?: M): Promise<void> {
  await runner.prompt("s1", "implementer", "a");
  await runner.prompt("s1", "tester", "b");
  await runner.prompt("s1", "reviewer", "c", overrideForReviewer ? { modelOverride: overrideForReviewer } : undefined);
  await runner.prompt("s1", "bughunter", "d");
}

test("opencode: --model only affects the implementer", async () => {
  const seen: M[] = [];
  const runner = createOpencodeClientRunner({
    client: recordingClient(seen),
    worktreeDir: "/tmp/r",
    config: baseConfig(),
    model: "x/impl",
  });
  await runRoles(runner);
  assert.deepEqual(seen[0], { providerID: "x", modelID: "impl" });
  assert.deepEqual(seen[1], { providerID: "parasail", modelID: "tester-m" });
  assert.deepEqual(seen[2], { providerID: "deepseek", modelID: "deepseek-reasoner" });
  assert.deepEqual(seen[3], { providerID: "parasail", modelID: "hunter-m" });
});

test("opencode: roleModels.tester overrides tester only; lens modelOverride wins for reviewer", async () => {
  const seen: M[] = [];
  const runner = createOpencodeClientRunner({
    client: recordingClient(seen),
    worktreeDir: "/tmp/r",
    config: baseConfig(),
    roleModels: { tester: "t/over" },
  });
  await runRoles(runner, { providerID: "lens", modelID: "lm" });
  assert.deepEqual(seen[0], { providerID: "deepseek", modelID: "deepseek-chat" });
  assert.deepEqual(seen[1], { providerID: "t", modelID: "over" });
  assert.deepEqual(seen[2], { providerID: "lens", modelID: "lm" });
  assert.deepEqual(seen[3], { providerID: "parasail", modelID: "hunter-m" });

  const seen2: M[] = [];
  const r2 = createOpencodeClientRunner({
    client: recordingClient(seen2),
    worktreeDir: "/tmp/r",
    config: baseConfig(),
    roleModels: { reviewer: "rv/over" },
  });
  await runRoles(r2, { providerID: "lens", modelID: "lm" });
  assert.deepEqual(seen2[2], { providerID: "lens", modelID: "lm" });
  await r2.prompt("s1", "reviewer", "again");
  assert.deepEqual(seen2[4], { providerID: "rv", modelID: "over" });
});

const CLAUDE_OUT = JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "sid", usage: { input_tokens: 1, output_tokens: 1 } });

async function claudeModels(opts: { model?: string; roleModels?: any; config?: RepoConfig }): Promise<Record<string, string>> {
  const calls: string[][] = [];
  const runner = createClaudeCodeRunner({
    worktreeDir: "/tmp/r",
    config: opts.config ?? baseConfig(),
    model: opts.model,
    roleModels: opts.roleModels,
    exec: async (_cwd, args) => {
      calls.push(args);
      return CLAUDE_OUT;
    },
  });
  const out: Record<string, string> = {};
  for (const role of ["implementer", "tester", "reviewer", "bughunter"] as const) {
    calls.length = 0;
    await runner.prompt("local-1", role, "hi");
    const i = calls[0].indexOf("--model");
    assert.ok(i >= 0, "args contain --model");
    out[role] = calls[0][i + 1];
  }
  return out;
}

test("claude-code: per-role default models", async () => {
  assert.deepEqual(await claudeModels({}), { implementer: "opus", tester: "sonnet", reviewer: "haiku", bughunter: "sonnet" });
});

test("claude-code: config.claudeModels, roleModels and model override", async () => {
  const cfg = baseConfig({ claudeModels: { reviewer: "sonnet" } });
  assert.equal((await claudeModels({ config: cfg })).reviewer, "sonnet");
  const m = await claudeModels({ model: "x" });
  assert.deepEqual(m, { implementer: "x", tester: "sonnet", reviewer: "haiku", bughunter: "sonnet" });
  const r = await claudeModels({ roleModels: { tester: "haiku" }, config: cfg });
  assert.equal(r.tester, "haiku");
  assert.equal(r.reviewer, "sonnet");
  assert.equal(r.implementer, "opus");
});

test("checkModelIndependence strict throws, non-strict warns, distinct passes", () => {
  const labels = { implementer: "a/m", tester: "a/m", reviewer: "b/r", bughunter: "c/h" };
  assert.throws(() => checkModelIndependence({ labels, strict: true }), ModelIndependenceError);
  assert.throws(() => checkModelIndependence({ labels, strict: true }), /tester/);
  const warns = checkModelIndependence({ labels, strict: false });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /tester/);

  const ok = { implementer: "a/m", tester: "b/t", reviewer: "c/r", bughunter: "d/h" };
  assert.deepEqual(checkModelIndependence({ labels: ok, strict: true }), []);

  assert.throws(
    () => checkModelIndependence({ labels: ok, lensModels: { sec: { providerID: "a", id: "m" } }, strict: true }),
    ModelIndependenceError
  );
  const lensWarn = checkModelIndependence({ labels: ok, lensModels: { sec: { providerID: "a", id: "m" } }, strict: false });
  assert.equal(lensWarn.length, 1);
  assert.match(lensWarn[0], /sec/);

  const unresolved = checkModelIndependence({ labels: { ...ok, implementer: undefined }, strict: true });
  assert.ok(unresolved.length >= 1);
  assert.match(unresolved[0], /implementer/);
  const allUnresolved = checkModelIndependence({
    labels: { implementer: undefined, tester: undefined, reviewer: "c/r", bughunter: undefined },
    strict: true,
  });
  assert.equal(allUnresolved.length, 3); // implementer, tester, bughunter
});

test("resolveRoleModelLabels for opencode and claude-code", () => {
  const cfg = baseConfig();
  assert.deepEqual(resolveRoleModelLabels("opencode", cfg, {}), {
    implementer: "deepseek/deepseek-chat",
    tester: "parasail/tester-m",
    reviewer: "deepseek/deepseek-reasoner",
    bughunter: "parasail/hunter-m",
  });
  const o = resolveRoleModelLabels("opencode", cfg, { implementer: "x/impl", tester: "y/t" });
  assert.equal(o.implementer, "x/impl");
  assert.equal(o.tester, "y/t");
  assert.equal(o.reviewer, "deepseek/deepseek-reasoner");
  assert.equal(resolveRoleModelLabels("opencode", { ...cfg, implementerModel: undefined }, {}).implementer, undefined);

  assert.deepEqual(resolveRoleModelLabels("claude-code", cfg, {}), {
    implementer: "opus",
    tester: "sonnet",
    reviewer: "haiku",
    bughunter: "sonnet",
  });
  const c = resolveRoleModelLabels("claude-code", baseConfig({ claudeModels: { tester: "haiku" } }), { reviewer: "opus" });
  assert.equal(c.tester, "haiku");
  assert.equal(c.reviewer, "opus");

  const table = formatRoleModelTable(resolveRoleModelLabels("claude-code", cfg, {}));
  assert.equal(table.length, 4);
  assert.match(table[0], /implementer\s+opus/);
});

test("parseCliArgs parses per-role model flags in both forms", () => {
  const a = parseCliArgs(["task", "--tester-model", "t/a", "--reviewer-model", "r/b", "--bughunter-model", "h/c", "--model", "i/d"], "/tmp");
  assert.equal(a.testerModel, "t/a");
  assert.equal(a.reviewerModel, "r/b");
  assert.equal(a.bughunterModel, "h/c");
  assert.equal(a.model, "i/d");
  const b = parseCliArgs(["task", "--tester-model=t/a", "--reviewer-model=r/b", "--bughunter-model=h/c"], "/tmp");
  assert.equal(b.testerModel, "t/a");
  assert.equal(b.reviewerModel, "r/b");
  assert.equal(b.bughunterModel, "h/c");
});

test("MCP ship_task forwards tester/reviewer/bughunter models to runPipeline", async () => {
  const calls: any[] = [];
  const deps = {
    resolveShipTaskInput: () => ({ task: "T", openPr: false, skipTests: false, skipReview: false }),
    runPipeline: async (opts: any) => {
      calls.push(opts);
    },
    notify: () => {},
  } as unknown as McpToolDeps;
  const resp = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ship_task",
        arguments: { task: "T", repoDir: "/tmp/r", provider: "claude-code", model: "opus", testerModel: "sonnet", reviewerModel: "haiku", bughunterModel: "sonnet" },
      },
    },
    deps
  );
  assert.equal(resp?.result.isError, undefined);
  assert.equal(calls[0].model, "opus");
  assert.equal(calls[0].testerModel, "sonnet");
  assert.equal(calls[0].reviewerModel, "haiku");
  assert.equal(calls[0].bughunterModel, "sonnet");
});

const OK = { implementer: "a/m", tester: "b/t", reviewer: "c/r", bughunter: "d/h" };

test("checkModelIndependence covers fallbacks, case-insensitivity, cross-provider names and hints", () => {
  assert.throws(
    () => checkModelIndependence({ labels: OK, fallbacks: { tester: "a/m" }, strict: true }),
    /tester fallback/
  );
  assert.throws(
    () => checkModelIndependence({ labels: OK, fallbacks: { implementer: "c/r" }, strict: true }),
    ModelIndependenceError
  );
  assert.throws(
    () =>
      checkModelIndependence({
        labels: { ...OK, implementer: "OpenRouter/Anthropic/X", tester: "openrouter/anthropic/x" },
        strict: true,
      }),
    ModelIndependenceError
  );
  const warns = checkModelIndependence({
    labels: { ...OK, implementer: "openrouter/anthropic/x", tester: "cloudflare-ai-gateway/anthropic/x" },
    strict: true,
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /different provider/);

  assert.throws(
    () => checkModelIndependence({ labels: { ...OK, tester: "a/m" }, strict: true, provider: "claude-code" }),
    /claudeModels/
  );
});

test("claude-code: empty-string claudeModels entry falls back to the default", async () => {
  const m = await claudeModels({ config: baseConfig({ claudeModels: { tester: "" } }) });
  assert.equal(m.tester, "sonnet");
});

function pipelineRepo(cfg: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-roles-"));
  const g = (...a: string[]) =>
    execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...a], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "# t\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".ai-ship-worktrees/\n");
  fs.writeFileSync(
    path.join(dir, ".ai-ship.json"),
    JSON.stringify({ baseBranch: "main", verify: [], maxFixRetries: 1, maxReviewRounds: 1, securityScan: false, safetyCheck: false, ...cfg })
  );
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return dir;
}

const SAME = {
  implementerModel: { providerID: "deepseek", id: "deepseek-chat" },
  testerModel: { providerID: "deepseek", id: "deepseek-chat" },
  reviewerModel: { providerID: "parasail", id: "r" },
  bughunterModel: { providerID: "parasail", id: "h" },
};

function okClient(): OpencodeClient {
  return {
    session: {
      create: async () => ({ data: { id: "s" } }),
      prompt: async () => ({ data: { parts: [{ type: "text", text: "Done.\nVERDICT: CLEAN" }], info: { cost: 0, tokens: { input: 1, output: 1 } } } }),
    },
  } as unknown as OpencodeClient;
}

test("runPipeline rejects tester == implementer before creating any worktree", async () => {
  const dir = pipelineRepo(SAME);
  try {
    await assert.rejects(
      () => runPipeline({ repoDir: dir, task: "t", openPr: false, skipTests: true, skipReview: true, client: okClient() }),
      (e: unknown) => e instanceof ModelIndependenceError
    );
    assert.equal(fs.existsSync(path.join(dir, ".ai-ship-worktrees")), false);
    const list = execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
    assert.equal(list.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runPipeline with strictIndependence:false does not throw ModelIndependenceError", async () => {
  const dir = pipelineRepo({ ...SAME, strictIndependence: false });
  try {
    try {
      await runPipeline({ repoDir: dir, task: "t", openPr: false, skipTests: true, skipReview: true, client: okClient() });
    } catch (e) {
      assert.ok(!(e instanceof ModelIndependenceError), "must not be a ModelIndependenceError");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkModelIndependence: exact match with implementer fallback is not shadowed by a same-name warning on the primary", () => {
  // implementer primary a/m, fallback b/m; reviewer b/m equals the fallback exactly (must throw),
  // even though its base name also matches the primary via a different provider.
  assert.throws(
    () =>
      checkModelIndependence({
        labels: { ...OK, reviewer: "b/m" },
        fallbacks: { implementer: "b/m" },
        strict: true,
      }),
    ModelIndependenceError
  );
});
