import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { handleMcpRequest, loadPersistedMcpJobs, persistMcpJobs, resetMcpJobs, type McpToolDeps } from "../src/mcp.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-persist-"));
process.env.AI_SHIP_MODELS_FILE = path.join(tmp, "no-models.json");
process.env.AI_SHIP_MCP_JOBS_FILE = path.join(tmp, "jobs-live.json");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => resetMcpJobs());

let rid = 1;
async function call(name: string, args: Record<string, unknown>, deps?: McpToolDeps): Promise<string> {
  const resp = await handleMcpRequest({ jsonrpc: "2.0", id: rid++, method: "tools/call", params: { name, arguments: args } }, deps);
  return resp?.result.content[0].text as string;
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const base = { repoDir: "/tmp/my-repo", provider: "claude-code" };
const resolveInput = (task: string, o: any = {}) => ({ task, openPr: false, skipTests: false, skipReview: false, worktreeDir: o.worktreeDir });

test("persist/load round-trip: running -> interrupted, ids continue after max", async () => {
  const mk = (): McpToolDeps => ({ resolveShipTaskInput: resolveInput, runPipeline: () => new Promise(() => {}), notify: () => {} } as unknown as McpToolDeps);
  await call("ship_start", { ...base, task: "one" }, mk());
  await call("ship_start", { ...base, task: "two" }, mk());
  const copy = path.join(tmp, "copy.json");
  persistMcpJobs(copy);
  resetMcpJobs();
  assert.equal(loadPersistedMcpJobs(copy), 2);
  const st = await call("ship_status", { jobId: "job-2" });
  assert.match(st, /job-2 — interrupted — two/);
  const st1 = await call("ship_status", { jobId: "job-1" });
  assert.match(st1, /interrupted/);
  assert.match(st1, /MCP server restarted/);
  // next job id continues after the max loaded id
  const started = await call("ship_start", { ...base, task: "three" }, mk());
  assert.match(started, /job-3/);
});

test("load: finished jobs keep status/result; duplicate ids are not reloaded; corrupt/missing file -> 0", async () => {
  const f = path.join(tmp, "fin.json");
  fs.writeFileSync(f, JSON.stringify([
    { id: "job-7", label: "L", status: "succeeded", startedAt: 1, events: ["a", 5], result: "R" },
    { id: "job-7", label: "dup", status: "failed" },
    { nope: true },
    null,
  ]));
  assert.equal(loadPersistedMcpJobs(f), 1);
  assert.match(await call("ship_status", { jobId: "job-7" }), /job-7 — succeeded — L[^]*R/);
  resetMcpJobs();
  const bad = path.join(tmp, "bad.json");
  fs.writeFileSync(bad, "{not json");
  assert.equal(loadPersistedMcpJobs(bad), 0);
  fs.writeFileSync(bad, '{"a":1}');
  assert.equal(loadPersistedMcpJobs(bad), 0);
  assert.equal(loadPersistedMcpJobs(path.join(tmp, "missing.json")), 0);
});

// ---- ship_start with noty://category ----
const notes = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `n${i + 1}`, title: `Task ${i + 1}`, body: "b", filePath: `/x/n${i + 1}.md`, task: `Task ${i + 1}\n\nb`,
}));

function catDeps(opts: { fail?: Set<string>; list?: any[] } = {}) {
  const ran: string[] = [];
  const written: Array<{ id: string; ok: boolean; summary: string }> = [];
  const listArgs: any[] = [];
  const deps = {
    resolveShipTaskInput: resolveInput,
    runPipeline: async (o: any) => {
      ran.push(o.task);
      if (opts.fail?.has(o.task)) throw new Error(`fail ${o.task.split("\n")[0]}`);
    },
    listNotyCategoryTasks: (cat: string, o: any) => { listArgs.push([cat, o]); return opts.list ?? notes(3); },
    writeNotyResult: (note: any, r: any) => { written.push({ id: note.id, ...r }); },
    notify: () => {},
  } as unknown as McpToolDeps;
  return { deps, ran, written, listArgs };
}
const firstLine = (s: string) => s.split("\n")[0];

test("ship_start category: runs tasks sequentially, succeeds, no write-back by default", async () => {
  const d = catDeps();
  const text = await call("ship_start", { ...base, task: "noty://category/Projects/X", onlyTag: "t" }, d.deps);
  assert.match(text, /job-1/);
  await settle();
  assert.deepEqual(d.ran.map(firstLine), ["Task 1", "Task 2", "Task 3"]);
  assert.deepEqual(d.listArgs, [["Projects/X", { onlyTag: "t" }]]);
  const st = await call("ship_status", { jobId: "job-1" });
  assert.match(st, /succeeded — noty:\/\/category\/Projects\/X \(3 tasks\)/);
  assert.equal(d.written.length, 0);
});

test("ship_start category: stops on first failure by default", async () => {
  const d = catDeps({ fail: new Set(["Task 2\n\nb"]) });
  await call("ship_start", { ...base, task: "noty://category/X" }, d.deps);
  await settle();
  assert.deepEqual(d.ran.map(firstLine), ["Task 1", "Task 2"]);
  const st = await call("ship_status", { jobId: "job-1" });
  assert.match(st, /failed/);
  assert.match(st, /- succeeded: Task 1/);
  assert.match(st, /- failed: Task 2 — fail Task 2/);
  assert.match(st, /- skipped: Task 3/);
});

test("ship_start category: continueOnFailure runs the rest; notyWriteBack writes each result", async () => {
  const d = catDeps({ fail: new Set(["Task 2\n\nb"]) });
  await call("ship_start", { ...base, task: "noty://category/X", continueOnFailure: true, notyWriteBack: true }, d.deps);
  await settle();
  assert.equal(d.ran.length, 3);
  assert.deepEqual(d.written.map((w) => [w.id, w.ok]), [["n1", true], ["n2", false], ["n3", true]]);
  assert.match(d.written[1].summary, /^failed: fail Task 2/);
  assert.match(await call("ship_status", { jobId: "job-1" }), /failed/); // overall job failed because one task failed
});

test("ship_start category: empty category returns message and starts no job", async () => {
  const d = catDeps({ list: [] });
  const text = await call("ship_start", { ...base, task: "noty://category/Empty" }, d.deps);
  assert.match(text, /No open tasks in Noty category Empty/);
  assert.equal(d.ran.length, 0);
  assert.match(await call("ship_status", {}), /No ai-ship jobs yet/);
});

test("ship_start category: worktreeDir is rejected", async () => {
  const d = catDeps();
  const resp = await handleMcpRequest({ jsonrpc: "2.0", id: 9999, method: "tools/call", params: { name: "ship_start", arguments: { ...base, task: "noty://category/X", worktreeDir: "/tmp/wt" } } }, d.deps);
  assert.match(JSON.stringify(resp), /worktreeDir cannot be combined/);
});
