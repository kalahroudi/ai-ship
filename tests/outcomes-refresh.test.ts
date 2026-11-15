import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ciVerdict, computeModelScores, isSuccess, refreshOutcomes, type Exec, type TaskOutcome } from "../src/outcomes.ts";

// Hermetic: temp dir for the repo and the outcomes file; exec is faked so no git/gh runs.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-refresh-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const NOW = new Date("2026-06-10T00:00:00Z");
const SHA = "abcdef1234567890abcdef1234567890abcdef12";

function outcome(over: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    ts: "2026-06-01T00:00:00Z", taskId: "task-1", repo: tmp, result: "committed",
    models: { implementer: "m/a" }, fixRounds: 0, reviewRounds: 1, openFindings: 0, costUsd: 0.1, commitSha: SHA, ...over,
  };
}

let n = 0;
function writeLog(lines: string[]): string {
  const f = path.join(tmp, `o${n++}.jsonl`);
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

interface Call { cmd: string; args: string[] }
function fakeExec(opts: { revert?: boolean; pr?: string } = {}): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "git") return { ok: true, stdout: opts.revert ? "deadbeef\n" : "" };
    if (cmd === "gh") return opts.pr === undefined ? { ok: false, stdout: "" } : { ok: true, stdout: opts.pr };
    return { ok: false, stdout: "" };
  };
  return { exec, calls };
}

const pr = (state: string, checks: object[]) => JSON.stringify({ state, statusCheckRollup: checks });
const read = (f: string) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean);

test("ciVerdict: failure/error/timed_out conclusions are ci-failed", () => {
  for (const c of ["FAILURE", "ERROR", "TIMED_OUT"]) {
    assert.equal(ciVerdict(pr("OPEN", [{ conclusion: "SUCCESS" }, { conclusion: c }])), "ci-failed", c);
  }
});

test("ciVerdict: in-progress or null conclusion is pending", () => {
  assert.equal(ciVerdict(pr("MERGED", [{ conclusion: "SUCCESS" }, { conclusion: null, status: "IN_PROGRESS" }])), "pending");
  assert.equal(ciVerdict(pr("MERGED", [{ conclusion: "" }])), "pending");
});

test("ciVerdict: all success + MERGED is ok; success but OPEN is pending", () => {
  assert.equal(ciVerdict(pr("MERGED", [{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }])), "ok");
  assert.equal(ciVerdict(pr("OPEN", [{ conclusion: "SUCCESS" }])), "pending");
});

test("ciVerdict: bad JSON is undefined; StatusContext state entries are honored", () => {
  assert.equal(ciVerdict("not json"), undefined);
  assert.equal(ciVerdict(pr("MERGED", [{ state: "FAILURE" }])), "ci-failed");
  assert.equal(ciVerdict(pr("MERGED", [{ state: "PENDING" }])), "pending");
  assert.equal(ciVerdict(pr("MERGED", [{ state: "SUCCESS" }])), "ok");
});

test("refresh: revert detected via git log --grep, gh not consulted", () => {
  const f = writeLog([JSON.stringify(outcome())]);
  const { exec, calls } = fakeExec({ revert: true, pr: pr("MERGED", [{ conclusion: "SUCCESS" }]) });
  const r = refreshOutcomes({ file: f, exec, now: NOW });
  assert.deepEqual(r, { checked: 1, changed: 1 });
  const o = JSON.parse(read(f)[0]!);
  assert.equal(o.postMerge, "reverted");
  assert.equal(o.refreshedAt, NOW.toISOString());
  const git = calls.find((c) => c.cmd === "git")!;
  assert.ok(git.args.includes(`--grep=This reverts commit ${SHA}`));
  assert.ok(!calls.some((c) => c.cmd === "gh"));
});

test("refresh: failing CI marks ci-failed using the taskId as the PR ref", () => {
  const f = writeLog([JSON.stringify(outcome())]);
  const { exec, calls } = fakeExec({ pr: pr("OPEN", [{ conclusion: "FAILURE" }]) });
  assert.deepEqual(refreshOutcomes({ file: f, exec, now: NOW }), { checked: 1, changed: 1 });
  assert.equal(JSON.parse(read(f)[0]!).postMerge, "ci-failed");
  const gh = calls.find((c) => c.cmd === "gh")!;
  assert.deepEqual(gh.args.slice(0, 3), ["pr", "view", "task-1"]);
});

test("refresh: ok is final (gh not called again) but a revert is still detected", () => {
  const f = writeLog([JSON.stringify(outcome({ postMerge: "ok" }))]);
  const a = fakeExec({ pr: pr("MERGED", [{ conclusion: "FAILURE" }]) });
  assert.deepEqual(refreshOutcomes({ file: f, exec: a.exec, now: NOW }), { checked: 1, changed: 0 });
  assert.ok(a.calls.some((c) => c.cmd === "git"), "revert still checked");
  assert.ok(!a.calls.some((c) => c.cmd === "gh"), "gh not called for final verdict");
  const b = fakeExec({ revert: true });
  assert.deepEqual(refreshOutcomes({ file: f, exec: b.exec, now: NOW }), { checked: 1, changed: 1 });
  assert.equal(JSON.parse(read(f)[0]!).postMerge, "reverted");
  // already reverted: skipped entirely
  const c = fakeExec({ revert: true });
  assert.deepEqual(refreshOutcomes({ file: f, exec: c.exec, now: NOW }), { checked: 0, changed: 0 });
  assert.equal(c.calls.length, 0);
});

test("refresh: corrupt lines are preserved byte-for-byte alongside updated ones", () => {
  const corrupt = '{"ts": "2026-06-01", broken  ';
  const f = writeLog([corrupt, JSON.stringify(outcome())]);
  const { exec } = fakeExec({ revert: true });
  refreshOutcomes({ file: f, exec, now: NOW });
  const lines = fs.readFileSync(f, "utf8").split("\n");
  assert.equal(lines[0], corrupt);
  assert.equal(JSON.parse(lines[1]!).postMerge, "reverted");
});

test("refresh: no write when nothing changed (content and mtime stable)", () => {
  const f = writeLog([JSON.stringify(outcome({ postMerge: "pending" })), JSON.stringify(outcome({ taskId: "t2", result: "failed" }))]);
  const old = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(f, old, old);
  const before = fs.readFileSync(f, "utf8");
  const { exec } = fakeExec({ pr: pr("OPEN", [{ conclusion: "SUCCESS" }]) }); // pending -> pending
  const r = refreshOutcomes({ file: f, exec, now: NOW });
  assert.equal(r.changed, 0);
  assert.equal(fs.readFileSync(f, "utf8"), before);
  assert.equal(fs.statSync(f).mtimeMs, old.getTime());
  assert.deepEqual(fs.readdirSync(tmp).filter((x) => x.endsWith(".tmp")), []);
});

test("refresh: skips too-old, non-committed and missing-repo outcomes", () => {
  const f = writeLog([
    JSON.stringify(outcome({ ts: "2026-01-01T00:00:00Z" })),
    JSON.stringify(outcome({ result: "failed" })),
    JSON.stringify(outcome({ repo: path.join(tmp, "does-not-exist") })),
  ]);
  const { exec, calls } = fakeExec({ revert: true });
  assert.deepEqual(refreshOutcomes({ file: f, exec, now: NOW, maxAgeDays: 30 }), { checked: 0, changed: 0 });
  assert.equal(calls.length, 0);
  assert.deepEqual(refreshOutcomes({ file: path.join(tmp, "missing.jsonl"), exec, now: NOW }), { checked: 0, changed: 0 });
});

test("refresh: invalid commitSha is never passed to git (gh still runs)", () => {
  const f = writeLog([JSON.stringify(outcome({ commitSha: "--output=/etc/x; rm" })), JSON.stringify(outcome({ taskId: "t2", commitSha: undefined }))]);
  const { exec, calls } = fakeExec({ pr: pr("MERGED", [{ conclusion: "SUCCESS" }]) });
  const r = refreshOutcomes({ file: f, exec, now: NOW });
  assert.equal(r.changed, 2);
  assert.ok(!calls.some((c) => c.cmd === "git"));
  assert.equal(calls.filter((c) => c.cmd === "gh").length, 2);
});

test("isSuccess/computeModelScores: reverted or ci-failed committed outcome counts as failure", () => {
  assert.equal(isSuccess(outcome()), true);
  assert.equal(isSuccess(outcome({ postMerge: "ok" })), true);
  assert.equal(isSuccess(outcome({ postMerge: "pending" })), true);
  assert.equal(isSuccess(outcome({ postMerge: "reverted" })), false);
  assert.equal(isSuccess(outcome({ postMerge: "ci-failed" })), false);
  const ts = NOW.toISOString();
  const s = computeModelScores([outcome({ ts }), outcome({ ts, postMerge: "reverted" })], NOW).get("implementer:m/a")!;
  assert.equal(s.n, 2);
  assert.equal(s.successRate, 0.5);
});
