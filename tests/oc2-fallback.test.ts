import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Oc2Api, Oc2Message } from "../src/oc2/api.ts";
import { createOc2Runner } from "../src/oc2/runner.ts";
import { loadRepoConfig, type RepoConfig } from "../src/config.ts";

// Hermetic pricing.
process.env.AI_SHIP_MODELS_FILE = path.join(os.tmpdir(), `ai-ship-no-models-oc2fb-${process.pid}.json`);

const PRIMARY = "p/primary";
const FB = { providerID: "f", id: "fallback" };

function cfg(extra: Partial<RepoConfig> = {}): RepoConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-oc2fb-"));
  const c = loadRepoConfig(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...c, ...extra };
}

/** Fake api: sessions listed in `failing` end with outcome "error" + the given error; others succeed. */
function fakeApi(failing: Record<string, unknown> = {}) {
  const created: Array<Record<string, any> & { id: string }> = [];
  const prompts: Array<{ sid: string; text: string }> = [];
  const interrupts: string[] = [];
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
    async wait() {},
    async interrupt(sid) {
      interrupts.push(sid);
    },
    async messages(sid) {
      const i = prompts.map((p) => p.sid).lastIndexOf(sid);
      const base: Oc2Message[] = [{ id: `u_${i + 1}`, type: "user" }];
      // `failing` is keyed by creation index (0 = ship parent, 1 = primary session, 2 = fallback session).
      const err = failing[created.findIndex((c) => c.id === sid)];
      if (err !== undefined) return [...base, { id: "e", type: "assistant", error: err }, { id: "i", type: "idle", outcome: "error" }];
      return [...base, { id: "a", type: "assistant", content: [{ type: "text", text: `ok from ${sid}` }] }, { id: "i", type: "idle", outcome: "succeeded" }];
    },
  };
  return { api, created, prompts, interrupts };
}

function mk(api: Oc2Api, config: RepoConfig, extra: Record<string, unknown> = {}) {
  return createOc2Runner({
    api,
    worktreeDir: "/wt",
    config,
    task: "t",
    pollMs: 1,
    roleModels: { implementer: PRIMARY, tester: PRIMARY, reviewer: PRIMARY, bughunter: PRIMARY },
    ...extra,
  });
}

test("fallback: transient 429 creates a sibling '(fallback)' session on the fallback model and reports it", async () => {
  const { api, created, prompts } = fakeApi({ 1: { statusCode: 429, message: "rate limit" } });
  const runner = mk(api, cfg({ implementerFallbackModel: FB }));
  const sid = await runner.createSession("Implement");
  const res = await runner.prompt(sid, "implementer", "do it");
  assert.match(res.text, /ok from ses_3/);
  assert.equal(created.length, 3); // ship parent, primary, fallback
  const [ship, primary, fb] = created;
  assert.equal(fb.parentID, ship.id);
  assert.equal(fb.parentID, primary.parentID);
  assert.equal(fb.title, "Implement (fallback)");
  assert.deepEqual(fb.model, FB);
  assert.deepEqual(primary.model, { providerID: "p", id: "primary" });
  assert.equal(prompts.at(-1)?.sid, fb.id);
  assert.equal(prompts.at(-1)?.text, "do it"); // first turn: no handover note
  assert.deepEqual(res.fallback, { role: "implementer", from: PRIMARY, to: "f/fallback", reason: "HTTP 429 (rate limit)" });
});

test("fallback: 5xx / overloaded text in an assistant error field is also transient", async () => {
  const { api, created } = fakeApi({ 1: "Provider returned HTTP 503 overloaded" });
  const runner = mk(api, cfg({ testerFallbackModel: FB }));
  const sid = await runner.createSession("Test");
  const res = await runner.prompt(sid, "tester", "go");
  assert.equal(res.fallback?.role, "tester");
  assert.equal(res.fallback?.reason, "HTTP 503");
  assert.equal(created.length, 3);
});

test("fallback: later prompts for the same local session go to the fallback session; non-first turn gets git diff handover", async () => {
  const { api, created, prompts } = fakeApi({ 1: "429 too many requests" });
  const runner = mk(api, cfg({ implementerFallbackModel: FB }));
  const sid = await runner.createSession("Implement");
  const first = await runner.prompt(sid, "implementer", "turn one"); // primary (created[1]) fails -> failover
  assert.ok(first.fallback);
  const fbId = created[2].id;
  const second = await runner.prompt(sid, "implementer", "turn two");
  assert.equal(second.fallback, undefined);
  assert.equal(prompts.at(-1)?.sid, fbId);
  assert.equal(created.length, 3); // no further sessions
  assert.equal(prompts.filter((p) => p.sid === created[1].id).length, 1);
});

test("fallback: handover note mentions git diff on a non-first turn", async () => {
  // Fail only on the second turn: primary session (index 1) succeeds first, then flips to failing.
  let failPrimary = false;
  const base = fakeApi();
  const origMessages = base.api.messages.bind(base.api);
  base.api.messages = async (sid, dir) => {
    if (failPrimary && sid === "ses_2") {
      const i = base.prompts.map((p) => p.sid).lastIndexOf(sid);
      return [{ id: `u_${i + 1}`, type: "user" }, { id: "e", type: "assistant", error: "HTTP 500" }, { id: "i", type: "idle", outcome: "error" }];
    }
    return origMessages(sid, dir);
  };
  const runner = mk(base.api, cfg({ reviewerFallbackModel: FB }));
  const sid = await runner.createSession("Review");
  await runner.prompt(sid, "reviewer", "round one");
  failPrimary = true;
  const res = await runner.prompt(sid, "reviewer", "round two");
  assert.ok(res.fallback);
  const last = base.prompts.at(-1)!;
  assert.equal(last.sid, "ses_3");
  assert.match(last.text, /git diff/);
  assert.ok(last.text.endsWith("round two"));
});

test("no failover: non-transient 400 rethrows the original error", async () => {
  const { api, created } = fakeApi({ 1: { statusCode: 400, message: "bad request" } });
  const runner = mk(api, cfg({ implementerFallbackModel: FB }));
  const sid = await runner.createSession("Implement");
  await assert.rejects(runner.prompt(sid, "implementer", "x"), /ended with outcome "error".*400/s);
  assert.equal(created.length, 2);
});

test("no failover: no fallback configured", async () => {
  const { api, created } = fakeApi({ 1: "HTTP 429" });
  const runner = mk(api, cfg());
  const sid = await runner.createSession("Implement");
  await assert.rejects(runner.prompt(sid, "implementer", "x"), /429/);
  assert.equal(created.length, 2);
});

test("no failover: fallback equals the primary model", async () => {
  const { api, created } = fakeApi({ 1: "HTTP 429" });
  const runner = mk(api, cfg({ implementerFallbackModel: { providerID: "p", id: "primary" } }));
  const sid = await runner.createSession("Implement");
  await assert.rejects(runner.prompt(sid, "implementer", "x"), /429/);
  assert.equal(created.length, 2);
});

test("no failover: modelOverride set", async () => {
  const { api, created } = fakeApi({ 1: "HTTP 429" });
  const runner = mk(api, cfg({ implementerFallbackModel: FB }));
  const sid = await runner.createSession("Implement");
  await assert.rejects(runner.prompt(sid, "implementer", "x", { modelOverride: { providerID: "o", modelID: "other" } }), /429/);
  assert.equal(created.length, 2);
  assert.deepEqual(created[1].model, { providerID: "o", id: "other" });
});

test("no failover: run cancelled during the failing turn", async () => {
  const { api, created } = fakeApi({ 1: "HTTP 429" });
  const runner = mk(api, cfg({ implementerFallbackModel: FB }));
  const origWait = api.wait.bind(api);
  api.wait = async (...a) => {
    await runner.cancel();
    return origWait(...a);
  };
  const sid = await runner.createSession("Implement");
  await assert.rejects(runner.prompt(sid, "implementer", "x"), /429/);
  assert.equal(created.length, 2);
});
