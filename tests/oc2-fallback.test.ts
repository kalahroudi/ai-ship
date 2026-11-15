import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Oc2Api, Oc2Message } from "../src/oc2/api.ts";
import { createLazyRunner, createOc2Runner } from "../src/oc2/runner.ts";
import { loadRepoConfig, type RepoConfig } from "../src/config.ts";
import type { PipelineRunner } from "../src/runner.ts";

// Hermetic pricing.
process.env.AI_SHIP_MODELS_FILE = path.join(os.tmpdir(), `ai-ship-no-models-oc2fb-${process.pid}.json`);

const PRIMARY = "p/primary";
const FB = { providerID: "f", id: "fallback" };
const HANDOVER = /git diff/;

function cfg(extra: Partial<RepoConfig> = {}): RepoConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-oc2fb-"));
  const c = loadRepoConfig(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...c, ...extra };
}

const failed = (error: unknown, tokens?: { input: number; output: number }): Oc2Message[] => [
  ...(tokens ? [{ id: "a0", type: "assistant", tokens } as Oc2Message] : []),
  { id: "e", type: "assistant", error },
  { id: "i", type: "idle", outcome: "error" },
];

/**
 * Fake api. Sessions are indexed by creation order (0 = ship parent, 1 = primary, 2 = fallback, ...).
 * `script[i]` = messages after the user message for session i (default: a successful reply).
 */
function fakeApi(
  script: Record<number, Oc2Message[]> = {},
  hooks: { createThrowsAt?: number; promptThrows?: Error; messagesThrows?: Error; callLog?: string[] } = {}
) {
  const created: Array<Record<string, any> & { id: string }> = [];
  const prompts: Array<{ sid: string; text: string }> = [];
  const interrupts: string[] = [];
  const log = hooks.callLog ?? [];
  let attempts = 0;
  const api: Oc2Api = {
    async createSession(input) {
      if (hooks.createThrowsAt === attempts++) throw new Error("create boom");
      const id = `ses_${created.length + 1}`;
      created.push({ ...input, id });
      log.push(`create:${id}`);
      return { id };
    },
    async prompt(sid, text) {
      if (hooks.promptThrows) throw hooks.promptThrows;
      prompts.push({ sid, text });
      return { id: `u_${prompts.length}` };
    },
    async wait() {},
    async interrupt(sid) {
      interrupts.push(sid);
      log.push(`interrupt:${sid}`);
    },
    async messages(sid) {
      if (hooks.messagesThrows) throw hooks.messagesThrows;
      const i = prompts.map((p) => p.sid).lastIndexOf(sid);
      const base: Oc2Message[] = [{ id: `u_${i + 1}`, type: "user" }];
      const idx = created.findIndex((c) => c.id === sid);
      const rest = script[idx] ?? [
        { id: "a", type: "assistant", content: [{ type: "text", text: `ok from ${sid}` }] },
        { id: "i", type: "idle", outcome: "succeeded" },
      ];
      return [...base, ...rest];
    },
  };
  return { api, created, prompts, interrupts, log };
}

function mk(api: Oc2Api, config: RepoConfig) {
  return createOc2Runner({
    api,
    worktreeDir: "/wt",
    config,
    task: "t",
    pollMs: 1,
    roleModels: { implementer: PRIMARY, tester: PRIMARY, reviewer: PRIMARY, bughunter: PRIMARY },
  });
}

test("failover: transient 429 creates a sibling '(fallback)' session on the fallback model and reports it", async () => {
  const { api, created, prompts } = fakeApi({ 1: failed({ statusCode: 429, message: "rate limit" }) });
  const runner = mk(api, cfg({ reviewerFallbackModel: FB }));
  const sid = await runner.createSession("Review");
  const res = await runner.prompt(sid, "reviewer", "do it");
  assert.match(res.text, /ok from ses_3/);
  assert.equal(created.length, 3); // ship parent, primary, fallback
  const [ship, primary, fb] = created;
  assert.equal(fb.parentID, ship.id);
  assert.equal(primary.parentID, ship.id);
  assert.equal(fb.title, "Review (fallback)");
  assert.deepEqual(fb.model, FB);
  assert.deepEqual(primary.model, { providerID: "p", id: "primary" });
  assert.equal(prompts.at(-1)?.sid, fb.id);
  assert.equal(prompts.at(-1)?.text, "do it"); // read-only role, first turn: no handover
  assert.deepEqual(res.fallback, { role: "reviewer", from: PRIMARY, to: "f/fallback", reason: "HTTP 429" });
});

test("failover: each role uses its own fallback model; later prompts go to the fallback session", async () => {
  for (const [role, key] of [
    ["implementer", "implementerFallbackModel"],
    ["tester", "testerFallbackModel"],
    ["bughunter", "bughunterFallbackModel"],
  ] as const) {
    const { api, created, prompts } = fakeApi({ 1: failed("HTTP 503 overloaded") });
    const runner = mk(api, cfg({ [key]: FB }));
    const sid = await runner.createSession("S");
    const res = await runner.prompt(sid, role, "one");
    assert.equal(res.fallback?.role, role);
    assert.equal(res.fallback?.reason, "HTTP 503");
    const second = await runner.prompt(sid, role, "two");
    assert.equal(second.fallback, undefined);
    assert.equal(prompts.at(-1)?.sid, created[2].id);
    assert.equal(created.length, 3);
  }
});

test("handover: writer roles get a git diff note even on the first turn; read-only roles only after the first turn", async () => {
  // writer, first turn
  let f = fakeApi({ 1: failed("HTTP 500") });
  let r = mk(f.api, cfg({ implementerFallbackModel: FB }));
  let sid = await r.createSession("Impl");
  await r.prompt(sid, "implementer", "build it");
  assert.match(f.prompts.at(-1)!.text, HANDOVER);
  assert.ok(f.prompts.at(-1)!.text.endsWith("build it"));

  // read-only, first turn: verbatim
  f = fakeApi({ 1: failed("HTTP 500") });
  r = mk(f.api, cfg({ bughunterFallbackModel: FB }));
  sid = await r.createSession("Bug");
  await r.prompt(sid, "bughunter", "hunt");
  assert.equal(f.prompts.at(-1)!.text, "hunt");

  // read-only, second turn: primary succeeds first, then fails
  const script: Record<number, Oc2Message[]> = {};
  f = fakeApi(script);
  r = mk(f.api, cfg({ reviewerFallbackModel: FB }));
  sid = await r.createSession("Rev");
  await r.prompt(sid, "reviewer", "round one");
  script[1] = failed("HTTP 500");
  const res = await r.prompt(sid, "reviewer", "round two");
  assert.ok(res.fallback);
  assert.match(f.prompts.at(-1)!.text, HANDOVER);
  assert.ok(f.prompts.at(-1)!.text.endsWith("round two"));
});

test("failover: the old session is interrupted before the fallback session is created", async () => {
  const log: string[] = [];
  const { api } = fakeApi({ 1: failed("HTTP 429") }, { callLog: log });
  const runner = mk(api, cfg({ implementerFallbackModel: FB }));
  const sid = await runner.createSession("Impl");
  await runner.prompt(sid, "implementer", "x");
  assert.ok(log.indexOf("interrupt:ses_2") >= 0);
  assert.ok(log.indexOf("interrupt:ses_2") < log.indexOf("create:ses_3"), log.join(","));
});

test("classification uses the LAST errored message's status (statusCode / status / data.statusCode)", async () => {
  const cases: Array<{ name: string; msgs: Oc2Message[]; failover: boolean }> = [
    { name: "503 statusCode", msgs: failed({ statusCode: 503, message: "upstream" }), failover: true },
    { name: "nested data.statusCode 502", msgs: failed({ data: { statusCode: 502 }, message: "x" }), failover: true },
    { name: "status 429", msgs: failed({ status: 429 }), failover: true },
    { name: "400 beats 'rate limit' text", msgs: failed({ statusCode: 400, message: "rate limit" }), failover: false },
    {
      name: "earlier 429 then later non-transient",
      msgs: [{ id: "e1", type: "assistant", error: { statusCode: 429, message: "rate limit" } }, ...failed({ statusCode: 400, message: "bad request" })],
      failover: false,
    },
  ];
  for (const c of cases) {
    const { api, created } = fakeApi({ 1: c.msgs });
    const runner = mk(api, cfg({ implementerFallbackModel: FB }));
    const sid = await runner.createSession("Impl");
    if (c.failover) {
      const res = await runner.prompt(sid, "implementer", "x");
      assert.ok(res.fallback, c.name);
      assert.equal(created.length, 3, c.name);
    } else {
      await assert.rejects(runner.prompt(sid, "implementer", "x"), /ended with outcome "error"/, c.name);
      assert.equal(created.length, 2, c.name);
    }
  }
});

test("no failover: no fallback configured / fallback equals primary / modelOverride / cancelled", async () => {
  const run = async (config: RepoConfig, optsFn?: (r: ReturnType<typeof mk>, api: Oc2Api) => any) => {
    const f = fakeApi({ 1: failed("HTTP 429") });
    const r = mk(f.api, config);
    optsFn?.(r, f.api);
    const sid = await r.createSession("Impl");
    return { f, p: r.prompt(sid, "implementer", "x", (r as any).__opts) };
  };
  let x = await run(cfg());
  await assert.rejects(x.p, /429/);
  assert.equal(x.f.created.length, 2);

  x = await run(cfg({ implementerFallbackModel: { providerID: "p", id: "primary" } }));
  await assert.rejects(x.p, /429/);
  assert.equal(x.f.created.length, 2);

  const f = fakeApi({ 1: failed("HTTP 429") });
  const r = mk(f.api, cfg({ implementerFallbackModel: FB }));
  const sid = await r.createSession("Impl");
  await assert.rejects(r.prompt(sid, "implementer", "x", { modelOverride: { providerID: "o", modelID: "other" } }), /429/);
  assert.equal(f.created.length, 2);

  const c = fakeApi({ 1: failed("HTTP 429") });
  const rc = mk(c.api, cfg({ implementerFallbackModel: FB }));
  const origWait = c.api.wait.bind(c.api);
  c.api.wait = async (...a) => {
    await rc.cancel();
    return origWait(...a);
  };
  const csid = await rc.createSession("Impl");
  await assert.rejects(rc.prompt(csid, "implementer", "x"), /429/);
  assert.equal(c.created.length, 2);
});

test("no failover: transport errors from api.prompt / api.messages (status 502) are rethrown", async () => {
  const transport = Object.assign(new Error("Bad Gateway"), { status: 502 });
  for (const hooks of [{ promptThrows: transport }, { messagesThrows: transport }]) {
    const { api, created } = fakeApi({}, hooks);
    const runner = mk(api, cfg({ implementerFallbackModel: FB }));
    const sid = await runner.createSession("Impl");
    await assert.rejects(runner.prompt(sid, "implementer", "x"), (e: unknown) => e === transport);
    assert.equal(created.length, 2); // no fallback session
  }
});

test("a second transient failure on the fallback session does not create a third session", async () => {
  const { api, created } = fakeApi({ 1: failed("HTTP 429"), 2: failed("HTTP 503") });
  const runner = mk(api, cfg({ implementerFallbackModel: FB }));
  const sid = await runner.createSession("Impl");
  await assert.rejects(runner.prompt(sid, "implementer", "x"), /503/);
  assert.equal(created.length, 3);
  // Subsequent prompts also stay on the fallback session and still do not fail over again.
  await assert.rejects(runner.prompt(sid, "implementer", "y"), /503/);
  assert.equal(created.length, 3);
});

test("if creating the fallback session throws, the local session keeps its original session and title", async () => {
  const script: Record<number, Oc2Message[]> = { 1: failed("HTTP 429") };
  // attempts: ship=0, primary=1, fallback=2 (throws)
  const { api, created, prompts } = fakeApi(script, { createThrowsAt: 2 });
  const runner = mk(api, cfg({ implementerFallbackModel: FB }));
  const sid = await runner.createSession("Impl");
  await assert.rejects(runner.prompt(sid, "implementer", "x"), /create boom/);
  assert.equal(created.length, 2);
  delete script[1]; // primary recovers
  const res = await runner.prompt(sid, "implementer", "again");
  assert.equal(res.fallback, undefined);
  assert.equal(prompts.at(-1)?.sid, created[1].id);
  assert.equal(created.length, 2);
});

test("result usage = failed turn usage + fallback usage; wastedAttempts is 1", async () => {
  const { api } = fakeApi({
    1: failed("HTTP 429", { input: 10, output: 1 }),
    2: [
      { id: "a", type: "assistant", content: [{ type: "text", text: "done" }], tokens: { input: 5, output: 2 } },
      { id: "i", type: "idle", outcome: "succeeded" },
    ],
  });
  const runner = mk(api, cfg({ implementerFallbackModel: FB }));
  const sid = await runner.createSession("Impl");
  const res = await runner.prompt(sid, "implementer", "x");
  assert.equal(res.usage?.input, 15);
  assert.equal(res.usage?.output, 3);
  assert.equal(res.wastedAttempts, 1);
});

test("createLazyRunner passes the config from onWorktree(dir, config) to build(dir, config)", async () => {
  const config = cfg();
  let got: { dir?: string; config?: RepoConfig } = {};
  const inner: PipelineRunner = { createSession: async () => "s", prompt: async () => ({ text: "", usageSummary: "" }), close() {} } as any;
  const { runner, onWorktree } = createLazyRunner((dir, c) => {
    got = { dir, config: c };
    return inner;
  });
  onWorktree("/wt", config);
  await runner.createSession("x");
  assert.equal(got.dir, "/wt");
  assert.equal(got.config, config);
});

import { isSubscriptionBilled } from "../src/pipeline.ts";
test("isSubscriptionBilled: claude-code without metered credentials only", () => {
  assert.equal(isSubscriptionBilled("claude-code", {}), true);
  assert.equal(isSubscriptionBilled("opencode", {}), false);
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) {
    assert.equal(isSubscriptionBilled("claude-code", { [k]: "1" }), false, k);
  }
});
