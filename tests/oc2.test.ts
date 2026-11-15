import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createCtxApi, createRestApi, discoverDesktopService, isSafeForPassword, Oc2HttpError, type Oc2Api, type Oc2Message } from "../src/oc2/api.ts";
import { createLazyRunner, createOc2Runner } from "../src/oc2/runner.ts";
import { describeToolPart, formatProgressEvent, throttleSink, type ProgressEvent } from "../src/progress.ts";
import { loadRepoConfig } from "../src/config.ts";
import { runShellAsync } from "../src/git.ts";
import { runPipeline } from "../src/pipeline.ts";
import { EmptyModelResponseError, type PipelineRunner } from "../src/runner.ts";
import { createAiShipV2Plugin, splitArgs } from "../plugin/v2/index.ts";

// Hermetic pricing.
const prevModelsFile = process.env.AI_SHIP_MODELS_FILE;
process.env.AI_SHIP_MODELS_FILE = path.join(os.tmpdir(), `ai-ship-no-models-oc2-${process.pid}.json`);
process.on("exit", () => {
  if (prevModelsFile === undefined) delete process.env.AI_SHIP_MODELS_FILE;
  else process.env.AI_SHIP_MODELS_FILE = prevModelsFile;
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-oc2-"));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------------------
// 1. REST api
// ---------------------------------------------------------------------------

test("createRestApi: auth header, directory query, data unwrapping, messages reversed", async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body as string | undefined });
    if (url.includes("/message")) return json(200, { data: [{ id: "m2", type: "assistant" }, { id: "m1", type: "user" }] });
    return json(200, { data: { id: "ses_1" } });
  }) as unknown as typeof fetch;
  const api = createRestApi({ baseUrl: "http://h:1/", password: "pw", fetchImpl });

  const s = await api.createSession({ title: "t", parentID: "p", model: { providerID: "a", id: "b" }, directory: "/w d" });
  assert.deepEqual(s, { id: "ses_1" });
  assert.equal(calls[0].url, `http://h:1/api/session?directory=${encodeURIComponent("/w d")}`);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from("opencode:pw").toString("base64")}`);
  assert.deepEqual(JSON.parse(calls[0].body as string), { title: "t", parentID: "p", model: { providerID: "a", id: "b" } });

  await api.prompt("ses_1", "hi", "/w");
  assert.equal(calls[1].url, "http://h:1/api/session/ses_1/prompt?directory=%2Fw");
  assert.deepEqual(JSON.parse(calls[1].body as string), { text: "hi" });

  const msgs = await api.messages("ses_1");
  assert.deepEqual(msgs.map((m) => m.id), ["m1", "m2"]);
});

test("createRestApi.wait polls until idle >= busy with an outcome", async () => {
  const states = [
    { time: { busy: 5, idle: 1 } },
    { time: { busy: 5, idle: 1 }, outcome: "succeeded" },
    { time: { busy: 5, idle: 6 }, outcome: "succeeded" },
  ];
  let n = 0;
  const fetchImpl = (async () => json(200, { data: states[Math.min(n++, states.length - 1)] })) as unknown as typeof fetch;
  const api = createRestApi({ baseUrl: "http://h", fetchImpl, pollMs: 1 });
  await api.wait("s");
  assert.equal(n, 3);
});

test("createRestApi: HTTP errors become Oc2HttpError", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  const api = createRestApi({ baseUrl: "http://h", fetchImpl });
  await assert.rejects(api.prompt("s", "x"), (e: unknown) => e instanceof Oc2HttpError && e.status === 401);
});

// ---------------------------------------------------------------------------
// 2. Oc2 runner
// ---------------------------------------------------------------------------

function fakeApi(opts: { agents?: string[]; replyFor?: (sid: string) => Oc2Message[]; outcome?: string; waitMs?: number } = {}) {
  const created: Array<Record<string, unknown> & { id: string }> = [];
  const prompts: Array<{ sid: string; text: string }> = [];
  let n = 0;
  const api: Oc2Api = {
    async createSession(input) {
      const id = `ses_${++n}`;
      created.push({ ...input, id });
      return { id };
    },
    async prompt(sid, text) {
      prompts.push({ sid, text });
      return { id: `u_${prompts.length}` };
    },
    async wait() {
      await new Promise((r) => setTimeout(r, opts.waitMs ?? 0));
    },
    async messages(sid) {
      const u = `u_${prompts.findIndex((p) => p.sid === sid) + 1}`;
      const base: Oc2Message[] = [{ id: u, type: "user" }];
      return opts.replyFor
        ? [...base, ...opts.replyFor(sid)]
        : [
            ...base,
            {
              id: "a1",
              type: "assistant",
              content: [{ type: "text", text: "first" }],
              tokens: { input: 10, output: 2, cache: { read: 1 } },
              cost: 0.5,
              model: { providerID: "deepseek", id: "deepseek-chat" },
            },
            {
              id: "a2",
              type: "assistant",
              content: [
                { type: "tool", name: "read", state: { status: "completed", input: { filePath: "src/a.ts" } } },
                { type: "text", text: "final answer" },
              ],
              tokens: { input: 5, output: 3 },
              cost: 0.25,
            },
            { id: "i1", type: "idle", outcome: opts.outcome ?? "succeeded" },
          ];
    },
    ...(opts.agents ? { async agents() { return opts.agents as string[]; } } : {}),
  };
  return { api, created, prompts };
}

function cfg() {
  const dir = tmp();
  const c = loadRepoConfig(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return c;
}

test("oc2 runner: one ship parent shared by child sessions; children carry parentID and role model", async () => {
  const { api, created } = fakeApi();
  const events: ProgressEvent[] = [];
  const config = cfg();
  const runner = createOc2Runner({ api, worktreeDir: "/wt", config, task: "Add feature\nmore", pollMs: 2, onEvent: (e) => events.push(e) });
  const s1 = await runner.createSession("Implement");
  const s2 = await runner.createSession("Review (Security)");
  assert.equal(created.length, 0, "sessions are lazy");
  await runner.prompt(s1, "implementer", "do it");
  await runner.prompt(s2, "reviewer", "review it");

  const parents = created.filter((c) => !c.parentID);
  assert.equal(parents.length, 1);
  assert.equal(parents[0].title, "ship: Add feature");
  assert.equal(parents[0].directory, "/wt");
  const kids = created.filter((c) => c.parentID);
  assert.equal(kids.length, 2);
  assert.ok(kids.every((k) => k.parentID === parents[0].id));
  const impl = config.implementerModel!;
  const rev = config.reviewerModel!;
  assert.deepEqual(kids[0].model, { providerID: impl.providerID, id: impl.id });
  assert.deepEqual(kids[1].model, { providerID: rev.providerID, id: rev.id });
  assert.equal(runner.shipSessionId(), parents[0].id);
});

test("oc2 runner: text is last assistant text, usage summed, tool parts emitted once", async () => {
  const { api } = fakeApi({ waitMs: 40 });
  const events: ProgressEvent[] = [];
  const runner = createOc2Runner({ api, worktreeDir: "/wt", config: cfg(), task: "t", pollMs: 3, onEvent: (e) => events.push(e) });
  const sid = await runner.createSession("Implement");
  const res = await runner.prompt(sid, "implementer", "go");
  assert.equal(res.text, "final answer");
  assert.equal(res.usage?.input, 15);
  assert.equal(res.usage?.output, 5);
  assert.equal(res.usage?.cacheRead, 1);
  assert.ok(Math.abs((res.usage?.costUsd ?? 0) - 0.75) < 1e-9);
  const tools = events.filter((e) => e.kind === "tool");
  assert.equal(tools.length, 1, "tool part reported exactly once across polls");
  assert.match(tools[0].text, /read src\/a\.ts/);
});

test("oc2 runner: reviewer uses the plan agent only when the server lists it", async () => {
  const withPlan = fakeApi({ agents: ["build", "plan"] });
  const r1 = createOc2Runner({ api: withPlan.api, worktreeDir: "/wt", config: cfg(), task: "t", pollMs: 1 });
  await r1.prompt(await r1.createSession("Review"), "reviewer", "x");
  await r1.prompt(await r1.createSession("Impl"), "implementer", "x");
  const kids = withPlan.created.filter((c) => c.parentID);
  assert.equal(kids[0].agent, "plan");
  assert.equal(kids[1].agent, undefined);

  const noPlan = fakeApi({ agents: ["build"] });
  const r2 = createOc2Runner({ api: noPlan.api, worktreeDir: "/wt", config: cfg(), task: "t", pollMs: 1 });
  await r2.prompt(await r2.createSession("Review"), "reviewer", "x");
  assert.equal(noPlan.created.find((c) => c.parentID)?.agent, undefined);
});

test("oc2 runner: failed outcome throws; empty reviewer reply throws EmptyModelResponseError", async () => {
  const failed = fakeApi({ outcome: "failed" });
  const r1 = createOc2Runner({ api: failed.api, worktreeDir: "/wt", config: cfg(), task: "t", pollMs: 1 });
  await assert.rejects(r1.prompt(await r1.createSession("I"), "implementer", "x"), /outcome "failed"/);

  const empty = fakeApi({ replyFor: () => [{ id: "a", type: "assistant", content: [{ type: "tool", name: "read", state: {} }] }, { id: "i", type: "idle", outcome: "succeeded" }] });
  const r2 = createOc2Runner({ api: empty.api, worktreeDir: "/wt", config: cfg(), task: "t", pollMs: 1 });
  await assert.rejects(r2.prompt(await r2.createSession("R"), "reviewer", "x"), (e: unknown) => e instanceof EmptyModelResponseError);
  // The same empty reply is fine for a writer role.
  const r3 = createOc2Runner({ api: empty.api, worktreeDir: "/wt", config: cfg(), task: "t", pollMs: 1 });
  const ok = await r3.prompt(await r3.createSession("I"), "implementer", "x");
  assert.equal(ok.text, "");
});

// ---------------------------------------------------------------------------
// 3. Lazy runner
// ---------------------------------------------------------------------------

test("createLazyRunner: throws before onWorktree, builds once afterwards", async () => {
  let builds = 0;
  const inner: PipelineRunner = {
    async createSession() { return "x"; },
    async prompt() { return { text: "t", usageSummary: "u" }; },
    close() {},
  };
  const { runner, onWorktree } = createLazyRunner((dir) => {
    builds++;
    assert.equal(dir, "/wt");
    return inner;
  });
  assert.throws(() => runner.createSession("a"), /before the worktree/);
  assert.equal(builds, 0);
  onWorktree("/wt");
  await runner.createSession("a");
  await runner.prompt("x", "implementer", "p");
  assert.equal(builds, 1);
});

// ---------------------------------------------------------------------------
// 4. Progress helpers
// ---------------------------------------------------------------------------

test("throttleSink coalesces tool events per agent but always passes stage/done", () => {
  const out: ProgressEvent[] = [];
  let t = 0;
  const sink = throttleSink((e) => out.push(e), 1000, () => t);
  const tool = (agent: string): ProgressEvent => ({ ts: 0, kind: "tool", agent, sessionId: agent, text: "x" });
  sink(tool("a"));
  sink(tool("a"));
  sink(tool("b"));
  assert.equal(out.length, 2);
  t = 1500;
  sink(tool("a"));
  assert.equal(out.length, 3);
  sink({ ts: 0, kind: "stage", text: "s" });
  sink({ ts: 0, kind: "stage", text: "s" });
  sink({ ts: 0, kind: "done", text: "d" });
  assert.equal(out.length, 6);
});

test("describeToolPart and formatProgressEvent", () => {
  assert.equal(describeToolPart({ name: "read", state: { status: "running", input: { filePath: "a.ts" } } }), "read a.ts (running)");
  assert.equal(describeToolPart({ name: "shell", state: { input: { command: "npm test" } } }), "shell npm test");
  assert.equal(describeToolPart({}), "tool");
  assert.equal(formatProgressEvent({ ts: 0, kind: "tool", agent: "Review", text: "read a" }), "[Review] → read a");
  assert.equal(formatProgressEvent({ ts: 0, kind: "stage", text: "Stage 1" }), "[ai-ship] Stage 1");
});

// ---------------------------------------------------------------------------
// 5. Native plugin
// ---------------------------------------------------------------------------

type Cmd = { name: string; execute: (i: { sessionID: string; prompt: { text: string } }) => Promise<string> };

async function loadPlugin(runPipelineFake: unknown) {
  const commands = new Map<string, Cmd>();
  const synthetic: Array<{ sessionID: string; text: string }> = [];
  const ctx = {
    location: { directory: tmp() },
    session: {
      async create() { return { id: "x" }; },
      async prompt() { return { id: "u" }; },
      async wait() {},
      async context() { return []; },
      async synthetic(i: { sessionID: string; text: string }) { synthetic.push(i); },
    },
    command: { transform(fn: (reg: { add(c: Cmd): void }) => void) { fn({ add: (c) => commands.set(c.name, c) }); } },
  };
  const plugin = createAiShipV2Plugin({ runPipeline: runPipelineFake as never, now: () => 1000 });
  assert.equal(plugin.id, "ai-ship");
  await plugin.setup(ctx as never);
  return { commands, synthetic, ctx, plugin };
}

test("plugin: registers all commands", async () => {
  const { commands } = await loadPlugin(async () => ({}));
  for (const n of ["ship", "ship-status", "remember", "forget", "cleanup", "safety-check", "pr"]) assert.ok(commands.has(n), n);
});

test("plugin: /ship returns immediately, runs pipeline in background, job succeeds", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let seen: Record<string, unknown> = {};
  const fake = async (opts: Record<string, unknown>) => {
    seen = opts;
    (opts.onWorktree as (d: string) => void)("/wt");
    (opts.onEvent as (e: ProgressEvent) => void)({ ts: 1, kind: "stage", stage: "Stage 1", text: "Stage 1" });
    await gate;
    return { repoDir: "/r", worktreeDir: "/wt", branch: "ai/x", baseBranch: "main", provider: "opencode", committed: true, verifyCommands: [], reviewVerdicts: [], usageLog: [] };
  };
  const { commands, synthetic, plugin } = await loadPlugin(fake);
  const reply = await commands.get("ship")!.execute({ sessionID: "S", prompt: { text: '"Add a thing" --skip-review' } });
  assert.match(reply, /job-1 started: Add a thing/);
  const job = plugin.jobs.get("job-1")!;
  assert.equal(job.status, "running");
  assert.equal(seen.task, "Add a thing");
  assert.equal(seen.skipReview, true);
  assert.ok(seen.runner && typeof seen.onWorktree === "function" && typeof seen.onEvent === "function");

  const running = await commands.get("ship-status")!.execute({ sessionID: "S", prompt: { text: "" } });
  assert.match(running, /job-1 — running/);
  assert.match(running, /Stage 1/);

  release();
  for (let i = 0; i < 50 && job.status === "running"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(job.status, "succeeded");
  const done = await commands.get("ship-status")!.execute({ sessionID: "S", prompt: { text: "job-1" } });
  assert.match(done, /job-1 — succeeded/);
  assert.ok(synthetic.some((s) => /finished/.test(s.text)));
});

test("plugin: pipeline failure marks the job failed", async () => {
  const { commands, plugin } = await loadPlugin(async () => { throw new Error("boom"); });
  await commands.get("ship")!.execute({ sessionID: "S", prompt: { text: "task" } });
  const job = plugin.jobs.get("job-1")!;
  for (let i = 0; i < 50 && job.status === "running"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(job.status, "failed");
  assert.match(job.error ?? "", /boom/);
});

test("splitArgs handles quotes", () => {
  assert.deepEqual(splitArgs(`a "b c" 'd e' --f=g`), ["a", "b c", "d e", "--f=g"]);
});

test("plugin: /remember writes to OPENCODE_MEMORY_DIR", async () => {
  const mem = tmp();
  const prev = process.env.OPENCODE_MEMORY_DIR;
  process.env.OPENCODE_MEMORY_DIR = mem;
  try {
    const { commands } = await loadPlugin(async () => ({}));
    const out = await commands.get("remember")!.execute({ sessionID: "S", prompt: { text: "always use tabs" } });
    assert.match(out, /Saved to repo memory/);
    const files: string[] = [];
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
    walk(mem);
    assert.ok(files.some((f) => fs.readFileSync(f, "utf8").includes("always use tabs")));
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_MEMORY_DIR;
    else process.env.OPENCODE_MEMORY_DIR = prev;
  }
});

// ---------------------------------------------------------------------------
// 6. Pipeline: reviewers stay read-only
// ---------------------------------------------------------------------------

test("pipeline: files written by a reviewer during the review round are reverted", async () => {
  const dir = tmp();
  const sh = (c: string) => execSync(c, { cwd: dir, stdio: "ignore" });
  sh("git init -b main");
  sh('git config user.email "t@example.com"');
  sh('git config user.name "T"');
  fs.writeFileSync(path.join(dir, "README.md"), "# t\n");
  fs.writeFileSync(
    path.join(dir, ".ai-ship.json"),
    JSON.stringify({
      baseBranch: "main",
      verify: ['node -e "process.exit(0)"'],
      maxFixRetries: 1,
      maxReviewRounds: 1,
      reviewStaggerMs: 0,
      securityScan: false,
      safetyCheck: false,
      bughunter: false,
      maxTaskTokens: 1_000_000_000,
      maxTaskCostUsd: 100,
    })
  );
  sh("git add -A && git commit -m init");
  let wt = "";
  const write = (rel: string, c: string) => {
    fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt, rel), c);
  };
  let n = 0;
  const titles = new Map<string, string>();
  const runner: PipelineRunner = {
    async createSession(title) {
      const id = `s${++n}`;
      titles.set(id, title);
      return id;
    },
    async prompt(_sid, role) {
      if (role === "implementer") {
        write("src/a.ts", "export const v = 1;\n");
        return { text: "Implemented.", usageSummary: "ok" };
      }
      if (role === "reviewer") {
        write("src/rogue.ts", "export const evil = true;\n");
        write("src/a.ts", "export const v = 999;\n");
        return { text: "Fine.\nVERDICT: CLEAN", usageSummary: "ok" };
      }
      return { text: "ok", usageSummary: "ok" };
    },
    close() {},
  };
  const origLog = console.log;
  console.log = () => {};
  try {
    const result = await runPipeline({
      repoDir: dir,
      task: "Add feature",
      openPr: false,
      skipTests: true,
      skipBughunter: true,
      runner,
      onWorktree: (d) => (wt = d),
    });
    assert.equal(result.worktreeDir, wt);
    assert.ok(!fs.existsSync(path.join(wt, "src/rogue.ts")), "reviewer-created file reverted");
    assert.equal(fs.readFileSync(path.join(wt, "src/a.ts"), "utf8"), "export const v = 1;\n", "reviewer edit reverted");
  } finally {
    console.log = origLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------

test("createCtxApi.wait rejects after timeoutMs when ctx wait never resolves", async () => {
  const api = createCtxApi({
    session: { create: async () => ({ id: "x" }), prompt: async () => ({ id: "u" }), wait: () => new Promise(() => {}), context: async () => [] },
  });
  await assert.rejects(api.wait("s", undefined, { timeoutMs: 20 }), /did not become idle/);
});

test("oc2 runner: wait failure interrupts the session, emits error, propagates; turnTimeoutMs passed", async () => {
  const f = fakeApi();
  const interrupted: string[] = [];
  let waitOpts: { timeoutMs?: number } | undefined;
  f.api.interrupt = async (sid) => { interrupted.push(sid); };
  f.api.wait = async (_s, _d, o) => { waitOpts = o; throw new Error("stuck"); };
  const events: ProgressEvent[] = [];
  const runner = createOc2Runner({ api: f.api, worktreeDir: "/wt", config: cfg(), task: "t", pollMs: 1, turnTimeoutMs: 1234, onEvent: (e) => events.push(e) });
  await assert.rejects(runner.prompt(await runner.createSession("I"), "implementer", "x"), /stuck/);
  assert.equal(waitOpts?.timeoutMs, 1234);
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0], f.prompts[0].sid);
  assert.ok(events.some((e) => e.kind === "error"));
});

test("oc2 runner: failed child/parent creation can be retried on the next prompt", async () => {
  const f = fakeApi();
  const real = f.api.createSession.bind(f.api);
  let failNext = 0;
  f.api.createSession = async (i) => {
    if (failNext > 0) { failNext--; throw new Error("create failed"); }
    return real(i);
  };
  const runner = createOc2Runner({ api: f.api, worktreeDir: "/wt", config: cfg(), task: "t", pollMs: 1 });
  const sid = await runner.createSession("I");
  failNext = 1; // the ship parent fails
  await assert.rejects(runner.prompt(sid, "implementer", "x"), /create failed/);
  await runner.prompt(sid, "implementer", "x");
  failNext = 1; // the child fails
  const sid2 = await runner.createSession("J");
  await assert.rejects(runner.prompt(sid2, "implementer", "x"), /create failed/);
  const res = await runner.prompt(sid2, "implementer", "x");
  assert.equal(res.text, "final answer");
  assert.equal(f.created.filter((c) => !c.parentID).length, 1, "single ship parent");
});

test("oc2 runner: unknown prompt message id throws", async () => {
  const f = fakeApi({ replyFor: () => [{ id: "old", type: "assistant", content: [{ type: "text", text: "stale" }], tokens: { input: 99, output: 9 }, cost: 9 }, { id: "i", type: "idle", outcome: "succeeded" }] });
  f.api.messages = async () => [
    { id: "other", type: "user" },
    { id: "old", type: "assistant", content: [{ type: "text", text: "stale" }], tokens: { input: 99, output: 9 }, cost: 9 },
  ];
  const runner = createOc2Runner({ api: f.api, worktreeDir: "/wt", config: cfg(), task: "t", pollMs: 1 });
  await assert.rejects(runner.prompt(await runner.createSession("I"), "implementer", "x"), /prompt message .* not found/);
});

test("isSafeForPassword and discoverDesktopService password handling", () => {
  assert.equal(isSafeForPassword("https://example.com"), true);
  for (const u of ["http://127.0.0.1:4096", "http://localhost:1", "http://[::1]:4096"]) assert.equal(isSafeForPassword(u), true, u);
  assert.equal(isSafeForPassword("http://remote.example.com"), false);
  assert.equal(isSafeForPassword("not a url"), false);

  const home = tmp();
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "opencode", "service.json"), JSON.stringify({ password: "secret" }));
  const saved = { HOME: process.env.HOME, URL: process.env.OPENCODE_SERVER_URL, PW: process.env.OPENCODE_SERVER_PASSWORD };
  try {
    process.env.HOME = home;
    delete process.env.OPENCODE_SERVER_PASSWORD;
    process.env.OPENCODE_SERVER_URL = "http://remote.example.com:4096";
    assert.equal(discoverDesktopService()?.password, undefined);
    process.env.OPENCODE_SERVER_URL = "http://127.0.0.1:4096";
    assert.equal(discoverDesktopService()?.password, "secret");
  } finally {
    for (const [k, v] of [["HOME", saved.HOME], ["OPENCODE_SERVER_URL", saved.URL], ["OPENCODE_SERVER_PASSWORD", saved.PW]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runShellAsync: exit code, output, and does not block the event loop", async () => {
  const ok = await runShellAsync("echo out; echo err 1>&2", os.tmpdir());
  assert.equal(ok.ok, true);
  assert.match(ok.output, /out/);
  assert.match(ok.output, /err/);
  const bad = await runShellAsync("echo nope; exit 3", os.tmpdir());
  assert.equal(bad.ok, false);
  assert.match(bad.output, /nope/);
  let fired = false;
  setTimeout(() => (fired = true), 50);
  const p = runShellAsync("sleep 0.3", os.tmpdir());
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fired, true, "timer fired while the command was still running");
  await p;
});

test("pipeline: reviewer edits are reverted even when a reviewer throws", async () => {
  const dir = tmp();
  const sh = (c: string) => execSync(c, { cwd: dir, stdio: "ignore" });
  sh("git init -b main");
  sh('git config user.email "t@example.com"');
  sh('git config user.name "T"');
  fs.writeFileSync(path.join(dir, "README.md"), "# t\n");
  fs.writeFileSync(
    path.join(dir, ".ai-ship.json"),
    JSON.stringify({ baseBranch: "main", verify: ['node -e "process.exit(0)"'], maxFixRetries: 1, maxReviewRounds: 1, reviewStaggerMs: 0, securityScan: false, safetyCheck: false, bughunter: false, maxTaskTokens: 1_000_000_000, maxTaskCostUsd: 100 })
  );
  sh("git add -A && git commit -m init");
  let wt = "";
  const write = (rel: string, c: string) => {
    fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt, rel), c);
  };
  const runner: PipelineRunner = {
    async createSession() { return "s"; },
    async prompt(_sid, role) {
      if (role === "implementer") { write("src/a.ts", "export const v = 1;\n"); return { text: "ok", usageSummary: "ok" }; }
      if (role === "reviewer") { write("src/rogue.ts", "x\n"); throw new Error("400 bad request: reviewer exploded"); }
      return { text: "ok", usageSummary: "ok" };
    },
    close() {},
  };
  const origLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      runPipeline({ repoDir: dir, task: "Add feature", openPr: false, skipTests: true, skipBughunter: true, runner, onWorktree: (d) => (wt = d) }),
      /reviewer exploded/
    );
    assert.ok(!fs.existsSync(path.join(wt, "src/rogue.ts")), "rogue file reverted despite the throw");
  } finally {
    console.log = origLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin: jobs map keeps only the 20 most recent", async () => {
  const { commands, plugin } = await loadPlugin(async () => ({ repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "main", provider: "opencode", committed: true, verifyCommands: [], reviewVerdicts: [], usageLog: [] }));
  for (let i = 0; i < 25; i++) await commands.get("ship")!.execute({ sessionID: "S", prompt: { text: `task ${i}` } });
  assert.equal(plugin.jobs.size, 20);
  assert.ok(!plugin.jobs.has("job-5"));
  assert.ok(plugin.jobs.has("job-6") && plugin.jobs.has("job-25"));
});

test("runShellAsync marks truncated output", async () => {
  const r = await runShellAsync("node -e \"process.stdout.write('x'.repeat(5000))\"", os.tmpdir(), 100);
  assert.equal(r.ok, true);
  assert.match(r.output, /…\(output truncated at 100 bytes\)$/);
});

test("plugin: job eviction keeps running jobs", async () => {
  const fin = { repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "main", provider: "opencode", committed: true, verifyCommands: [], reviewVerdicts: [], usageLog: [] };
  let first = true;
  const { commands, plugin } = await loadPlugin(async () => {
    if (first) { first = false; return new Promise(() => {}); }
    return fin;
  });
  for (let i = 0; i < 21; i++) {
    await commands.get("ship")!.execute({ sessionID: "S", prompt: { text: `task ${i}` } });
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(plugin.jobs.has("job-1"), "oldest running job kept");
  assert.equal(plugin.jobs.get("job-1")!.status, "running");
  assert.equal(plugin.jobs.size, 20);
  assert.ok(!plugin.jobs.has("job-2"));
});
