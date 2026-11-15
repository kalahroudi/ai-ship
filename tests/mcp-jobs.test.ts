import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { handleMcpRequest, MCP_TOOLS, cancelAllMcpJobs, resetMcpJobs, type McpToolDeps } from "../src/mcp.ts";

const prevModelsFile = process.env.AI_SHIP_MODELS_FILE;
process.env.AI_SHIP_MODELS_FILE = path.join(os.tmpdir(), `ai-ship-no-models-jobs-${process.pid}.json`);
process.on("exit", () => {
  if (prevModelsFile === undefined) delete process.env.AI_SHIP_MODELS_FILE;
  else process.env.AI_SHIP_MODELS_FILE = prevModelsFile;
});

beforeEach(() => resetMcpJobs());

let rid = 100;
async function call(name: string, args: Record<string, unknown>, deps?: McpToolDeps): Promise<string> {
  const resp = await handleMcpRequest(
    { jsonrpc: "2.0", id: rid++, method: "tools/call", params: { name, arguments: args } },
    deps
  );
  return resp?.result.content[0].text as string;
}
const base = { task: "Fix bug", repoDir: "/tmp/my-repo", provider: "claude-code" };
const tick = () => new Promise((r) => setImmediate(r));
const jobIdOf = (text: string) => /job-\d+/.exec(text)![0];

const resolveInput = (task: string, o: any = {}) => ({ task, openPr: false, skipTests: false, skipReview: false, worktreeDir: o.worktreeDir });

function deferredDeps() {
  const calls: any[] = [];
  let resolve!: (v?: any) => void;
  let reject!: (e: Error) => void;
  const deps = {
    resolveShipTaskInput: resolveInput,
    runPipeline: (opts: any) => {
      calls.push(opts);
      return new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
    notify: () => {},
  } as unknown as McpToolDeps;
  return { deps, calls, resolve: (v?: any) => resolve(v), reject: (e: Error) => reject(e) };
}

test("tools/list exposes ship_start/ship_status/ship_cancel; ship_start accepts every ship_task argument", async () => {
  const resp = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = resp?.result.tools as any[];
  for (const n of ["ship_start", "ship_status", "ship_cancel"]) assert.ok(tools.some((t) => t.name === n), n);
  const task = MCP_TOOLS.find((t) => t.name === "ship_task")!;
  const start = MCP_TOOLS.find((t) => t.name === "ship_start")!;
  // ship_start = ship_task's arguments plus category-run options.
  const { task: _st, ...startRest } = (start.inputSchema as any).properties;
  const { task: _tt, ...taskRest } = (task.inputSchema as any).properties;
  const { onlyTag: _o, continueOnFailure: _c, notyWriteBack: _w, ...shared } = startRest;
  assert.deepEqual(shared, taskRest);
});

test("ship_start returns immediately; status shows running + events, then succeeded", async () => {
  const d = deferredDeps();
  const text = await call("ship_start", base, d.deps);
  const id = jobIdOf(text);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].isCancelled(), false);

  d.calls[0].onProgress("Stage 1/4: Implementing");
  const running = await call("ship_status", { jobId: id });
  assert.match(running, /running/);
  assert.match(running, /Stage 1\/4: Implementing/);

  d.resolve(undefined);
  await tick();
  const done = await call("ship_status", { jobId: id });
  assert.match(done, /succeeded/);
  assert.match(done, /completed for "Fix bug"/);
});

test("onEvent tool events are formatted into ship_status", async () => {
  const d = deferredDeps();
  const id = jobIdOf(await call("ship_start", base, d.deps));
  d.calls[0].onEvent({ kind: "tool", agent: "Implementer", text: "read src/a.ts" });
  const s = await call("ship_status", { jobId: id });
  assert.match(s, /\[Implementer\] → read src\/a\.ts/);
  d.resolve();
});

test("ship_cancel sets cancel flag; rejection afterwards ends cancelled", async () => {
  const d = deferredDeps();
  const id = jobIdOf(await call("ship_start", base, d.deps));
  const msg = await call("ship_cancel", {});
  assert.match(msg, new RegExp(`Cancel requested for ${id}`));
  assert.equal(d.calls[0].isCancelled(), true);
  d.reject(new Error("aborted"));
  await tick();
  assert.match(await call("ship_status", { jobId: id }), /cancelled/);
  assert.match(await call("ship_cancel", { jobId: id }), /already cancelled/);
});

test("rejecting pipeline without cancel ends failed with error", async () => {
  const d = deferredDeps();
  const id = jobIdOf(await call("ship_start", base, d.deps));
  d.reject(new Error("boom-failure"));
  await tick();
  const s = await call("ship_status", { jobId: id });
  assert.match(s, /failed/);
  assert.match(s, /boom-failure/);
});

test("ship_task forwards skipBughunter and overrideBudget; ship_start too", async () => {
  const calls: any[] = [];
  const deps = { resolveShipTaskInput: resolveInput, runPipeline: async (o: any) => void calls.push(o), notify: () => {} } as unknown as McpToolDeps;
  await call("ship_task", { ...base, skipBughunter: true, overrideBudget: true }, deps);
  assert.equal(calls[0].skipBughunter, true);
  assert.equal(calls[0].overrideBudget, true);
  await call("ship_start", { ...base, skipBughunter: true, overrideBudget: true }, deps);
  assert.equal(calls[1].skipBughunter, true);
  assert.equal(calls[1].overrideBudget, true);
});

function multiDeps() {
  const rs: Array<{ res: () => void; rej: (e: Error) => void; opts: any }> = [];
  const deps = {
    resolveShipTaskInput: resolveInput,
    runPipeline: (opts: any) => new Promise<void>((res, rej) => rs.push({ res, rej, opts })),
    notify: () => {},
  } as unknown as McpToolDeps;
  return { rs, deps };
}

test("job cap keeps running jobs and evicts finished first (store <= 20)", async () => {
  const m = multiDeps();
  const finished: string[] = [];
  for (let i = 0; i < 17; i++) {
    finished.push(jobIdOf(await call("ship_start", base, m.deps)));
    m.rs[i].res();
    await tick();
  }
  const running: string[] = [];
  for (let i = 0; i < 4; i++) running.push(jobIdOf(await call("ship_start", base, m.deps)));
  const all = await call("ship_status", {});
  assert.match(all, /No ai-ship|## job/);
  for (const id of running) assert.match(await call("ship_status", { jobId: id }), /running/);
  assert.match(await call("ship_status", { jobId: finished[0] }), /No job/);
  let present = 0;
  for (let n = 1; n <= 21; n++) if (!/^No job/.test(await call("ship_status", { jobId: `job-${n}` }))) present++;
  assert.ok(present <= 20);
  m.rs.forEach((r) => r.res());
});

test("at most 4 running jobs; fifth ship_start errors", async () => {
  const m = multiDeps();
  for (let i = 0; i < 4; i++) jobIdOf(await call("ship_start", base, m.deps));
  const t = await call("ship_start", base, m.deps);
  assert.match(t, /failed/);
  assert.match(t, /max 4/);
  assert.equal(m.rs.length, 4);
  m.rs.forEach((r) => r.res());
});

test("ship_start errors on same worktreeDir while running; allowed after finish", async () => {
  const m = multiDeps();
  const wt = path.join(os.tmpdir(), "wt-clash");
  const id = jobIdOf(await call("ship_start", { ...base, worktreeDir: wt }, m.deps));
  const t = await call("ship_start", { ...base, worktreeDir: wt }, m.deps);
  assert.match(t, /failed/);
  assert.match(t, new RegExp(`${id} is already running`));
  assert.equal(m.rs.length, 1);
  m.rs[0].res();
  await tick();
  assert.match(await call("ship_start", { ...base, worktreeDir: wt }, m.deps), /Started job-/);
  m.rs[1].res();
});

test("job error is truncated to the last 4000 chars", async () => {
  const d = deferredDeps();
  const id = jobIdOf(await call("ship_start", base, d.deps));
  d.reject(new Error("HEAD" + "x".repeat(6000) + "TAILMARK"));
  await tick();
  const s = await call("ship_status", { jobId: id });
  assert.match(s, /failed/);
  assert.match(s, /TAILMARK/);
  assert.doesNotMatch(s, /HEAD/);
  assert.ok(s.length < 4400);
});

test("cancelAllMcpJobs cancels every running job", async () => {
  const m = multiDeps();
  for (let i = 0; i < 3; i++) await call("ship_start", base, m.deps);
  m.rs[0].res();
  await tick();
  assert.equal(cancelAllMcpJobs(), 2);
  assert.equal(m.rs[0].opts.isCancelled(), false);
  assert.equal(m.rs[1].opts.isCancelled(), true);
  assert.equal(m.rs[2].opts.isCancelled(), true);
  m.rs[1].rej(new Error("x"));
  m.rs[2].rej(new Error("x"));
  await tick();
  assert.match(await call("ship_status", { jobId: "job-2" }), /cancelled/);
});

test("ship_cancel with unknown jobId", async () => {
  assert.match(await call("ship_cancel", { jobId: "job-42" }), /No running ai-ship job/);
});

test("no job gives helpful messages", async () => {
  assert.match(await call("ship_status", {}), /No ai-ship jobs yet/);
  assert.match(await call("ship_status", { jobId: "job-99" }), /No job job-99/);
  assert.match(await call("ship_cancel", {}), /No running ai-ship job/);
});
