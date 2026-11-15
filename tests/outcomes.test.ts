import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  appendOutcome, computeModelScores, formatReport, isSuccess, learnedBonus, readOutcomes, type ModelScore, type TaskOutcome,
} from "../src/outcomes.ts";
import { parseCatalog } from "../src/catalog.ts";
import { routeModels } from "../src/router.ts";
import { planRouting, runPipeline } from "../src/pipeline.ts";
import { parseCliArgs, type RepoConfig } from "../src/config.ts";
import type { Classification } from "../src/classify.ts";
import type { OpencodeClient } from "../src/runner.ts";

// Hermetic: temp outcomes/ledger/models files, never ~/.local/share/ai-ship.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-outcomes-"));
const outcomesFile = path.join(tmp, "outcomes.jsonl");
const modelsFile = path.join(tmp, "models.json");
const prev = { o: process.env.AI_SHIP_OUTCOMES_FILE, l: process.env.AI_SHIP_LEDGER_FILE, m: process.env.AI_SHIP_MODELS_FILE };
process.env.AI_SHIP_OUTCOMES_FILE = outcomesFile;
process.env.AI_SHIP_LEDGER_FILE = path.join(tmp, "ledger.jsonl");
process.env.AI_SHIP_MODELS_FILE = modelsFile;
process.on("exit", () => {
  for (const [k, v] of [["AI_SHIP_OUTCOMES_FILE", prev.o], ["AI_SHIP_LEDGER_FILE", prev.l], ["AI_SHIP_MODELS_FILE", prev.m]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const DAY = 86_400_000;
const NOW = new Date("2026-06-01T00:00:00Z");
const oc = (o: Partial<TaskOutcome> = {}): TaskOutcome => ({
  ts: NOW.toISOString(), taskId: "t", repo: "/r", result: "committed", models: { implementer: "pa/small" },
  fixRounds: 0, reviewRounds: 1, openFindings: 0, costUsd: 0.1, ...o,
});
const reset = () => fs.rmSync(outcomesFile, { force: true });

test("appendOutcome/readOutcomes: roundtrip, corrupt lines skipped, since filter, missing file", () => {
  const f = path.join(tmp, "rt.jsonl");
  assert.deepEqual(readOutcomes(f), []);
  appendOutcome(oc({ taskId: "old", ts: new Date(NOW.getTime() - 10 * DAY).toISOString() }), f);
  fs.appendFileSync(f, "not json\n{\"ts\":\"bad\",\"result\":\"committed\"}\n\n{\"ts\":\"2026-01-01T00:00:00Z\"}\n");
  appendOutcome(oc({ taskId: "new" }), f);
  const all = readOutcomes(f);
  assert.deepEqual(all.map((o) => o.taskId), ["old", "new"]);
  assert.deepEqual(readOutcomes(f, new Date(NOW.getTime() - DAY)).map((o) => o.taskId), ["new"]);
  appendOutcome(oc({ taskId: "env" })); // default path = AI_SHIP_OUTCOMES_FILE
  assert.equal(readOutcomes().length, 1);
  reset();
});

test("isSuccess: committed, fixRounds <= 1, no open findings", () => {
  assert.equal(isSuccess(oc()), true);
  assert.equal(isSuccess(oc({ fixRounds: 1 })), true);
  assert.equal(isSuccess(oc({ fixRounds: 2 })), false);
  assert.equal(isSuccess(oc({ openFindings: 1 })), false);
  for (const result of ["failed", "cancelled", "no-changes"] as const) assert.equal(isSuccess(oc({ result })), false);
});

test("computeModelScores: role:model keys, rates, and 30-day half-life decay", () => {
  const s = computeModelScores(
    [oc({ models: { implementer: "pa/x", reviewer: "pb/y" } }), oc({ result: "failed", fixRounds: 3, models: { implementer: "pa/x" } })],
    NOW
  );
  assert.equal(s.get("implementer:pa/x")?.n, 2);
  assert.ok(Math.abs(s.get("implementer:pa/x")!.successRate - 0.5) < 1e-9);
  assert.equal(s.get("reviewer:pb/y")?.successRate, 1);
  assert.ok(Math.abs(s.get("implementer:pa/x")!.avgCostUsd - 0.1) < 1e-9);
  assert.equal(s.has("tester:pa/x"), false);
  // An old failure (30d = half weight) counts less than a fresh failure.
  const old = new Date(NOW.getTime() - 30 * DAY).toISOString();
  const decayed = computeModelScores([oc(), oc({ result: "failed", fixRounds: 3, ts: old })], NOW).get("implementer:pa/small")!;
  assert.ok(Math.abs(decayed.successRate - 1 / 1.5) < 1e-6, `got ${decayed.successRate}`);
  const fresh = computeModelScores([oc(), oc({ result: "failed", fixRounds: 3 })], NOW).get("implementer:pa/small")!;
  assert.ok(decayed.successRate > fresh.successRate);
});

test("learnedBonus: 0 until n>=3, clamped to +-0.1, security->reviewer, aig/ alias", () => {
  const sc = (n: number, rate: number): ModelScore => ({ n, successes: Math.round(n * rate), successRate: rate, avgCostUsd: 0 });
  const scores = new Map<string, ModelScore>([
    ["implementer:a", sc(2, 1)],
    ["implementer:b", sc(3, 1)],
    ["implementer:c", sc(10, 0)],
    ["implementer:d", sc(5, 0.5)],
    ["reviewer:e", sc(4, 0.75)],
    ["implementer:aig/f", sc(3, 1)],
  ]);
  const b = learnedBonus(scores);
  assert.equal(b("a", "implementer"), 0, "n<3");
  assert.equal(b("unknown", "implementer"), 0);
  assert.ok(Math.abs(b("b", "implementer") - 0.1) < 1e-9);
  assert.ok(Math.abs(b("c", "implementer") + 0.1) < 1e-9);
  assert.equal(b("d", "implementer"), 0);
  assert.ok(Math.abs(b("e", "security") - 0.05) < 1e-9, "security uses reviewer key");
  assert.ok(Math.abs(b("f", "implementer") - 0.1) < 1e-9, "aig/ alias");
  for (const r of [0, 0.2, 1]) assert.ok(Math.abs(learnedBonus(new Map([["implementer:z", sc(9, r)]]))("z", "implementer")) <= 0.1 + 1e-12);
});

test("formatReport: spend lines, task counts, success rate and per-model rows", () => {
  const outcomes = [oc({ costUsd: 0.2 }), oc({ result: "failed", fixRounds: 2, costUsd: 0.1 }), oc({ result: "cancelled", costUsd: 0 }), oc({ fixRounds: 3, costUsd: 0.2 })];
  const lines = formatReport({ outcomes, spendLines: ["SPEND LINE"], scores: computeModelScores(outcomes, NOW) });
  const text = lines.join("\n");
  assert.equal(lines[0], "SPEND LINE");
  assert.match(text, /Tasks: 4 \(committed 2, failed 1, cancelled 1\)/);
  assert.match(text, /First-pass success: 33%/);
  assert.match(text, /implementer:pa\/small/);
  assert.match(formatReport({ outcomes: [], spendLines: [], scores: new Map() }).join("\n"), /Tasks: 0[^\n]*\nFirst-pass success: n\/a; cost per committed task: n\/a/);
});

test("parseCliArgs: --report", () => {
  assert.equal(parseCliArgs(["--report"]).doReport, true);
  assert.equal(parseCliArgs(["task"]).doReport, false);
});

// ---- router integration ----
const RAW_MODELS = {
  models: [
    { id: "pa/small", family: "fa", tier: 1, pricing: { in: 1, out: 2 } },
    { id: "pb/small", family: "fb", tier: 1, pricing: { in: 1, out: 2 } },
    { id: "pc/mid", family: "fc", tier: 2, pricing: { in: 3, out: 6 } },
  ],
};
const cls = (): Classification => ({ size: "S", risk: "low", kind: "feature", domains: [], estFiles: 0, confidence: 0.5, reasons: [], });

test("router: learned bonus breaks a tie between two equal-score models (needs n>=3)", () => {
  const catalog = parseCatalog(RAW_MODELS).catalog;
  const pick = (bonus?: ReturnType<typeof learnedBonus>) =>
    routeModels({ catalog, classification: cls(), budget: "GREEN", ...(bonus ? { bonus } : {}) }).decisions.implementer!.catalogId;
  const base = pick();
  const other = base === "pa/small" ? "pb/small" : "pa/small";
  const mk = (n: number) => learnedBonus(computeModelScores(Array.from({ length: n }, () => oc({ models: { implementer: other } })), NOW));
  assert.equal(pick(mk(2)), base, "2 outcomes: no effect");
  assert.equal(pick(mk(3)), other, "3 successes: learned model wins");
});

const baseCfg: RepoConfig = { baseBranch: "main", verify: [], router: true } as unknown as RepoConfig;
test("planRouting: reads outcomes file and applies the learned bonus", () => {
  fs.writeFileSync(modelsFile, JSON.stringify(RAW_MODELS));
  reset();
  const first = planRouting({ config: baseCfg, task: "Add thing", repoDir: tmp, tags: ["size:S", "risk:low"] }).plan!.decisions.implementer!.catalogId;
  const other = first === "pa/small" ? "pb/small" : "pa/small";
  const now = Date.now();
  for (let i = 0; i < 3; i++) appendOutcome(oc({ ts: new Date(now - i * 1000).toISOString(), models: { implementer: other } }));
  const second = planRouting({ config: baseCfg, task: "Add thing", repoDir: tmp, tags: ["size:S", "risk:low"] }).plan!.decisions.implementer!.catalogId;
  assert.equal(second, other);
  reset();
});

// ---- pipeline ----
function initRepo(verify: string[], extra: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(tmp, "pipe-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync('git config user.email "t@example.com" && git config user.name T', { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# t\n");
  fs.writeFileSync(path.join(dir, ".ai-ship.json"), JSON.stringify({
    baseBranch: "main", verify, maxFixRetries: 2, maxReviewRounds: 1, reviewStaggerMs: 0, securityScan: false, safetyCheck: false,
    bughunter: false, maxTaskTokens: 1_000_000_000, maxTaskCostUsd: 100, ...extra,
  }));
  execSync("git add -A && git commit -q -m init", { cwd: dir });
  return dir;
}

function fakeClient() {
  let n = 0;
  return {
    session: {
      async create() { return { data: { id: `s-${++n}` } }; },
      async prompt(req: { query: { directory: string }; body: { agent: string } }) {
        let text = "Fine.\nVERDICT: CLEAN";
        if (req.body.agent === "implementer") {
          fs.mkdirSync(path.join(req.query.directory, "src"), { recursive: true });
          fs.writeFileSync(path.join(req.query.directory, "src/a.ts"), `export const v = ${n};\n`);
          text = "Implemented.";
        }
        return { data: { parts: [{ type: "text", text }], info: { cost: 0.002, tokens: { input: 5, output: 5, cache: { read: 0 } } } } };
      },
    },
  } as unknown as OpencodeClient;
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const o = console.log;
  const e = console.error;
  console.log = () => {};
  console.error = () => {};
  try { return await fn(); } finally { console.log = o; console.error = e; }
}

test("pipeline: successful run appends exactly one committed outcome", async () => {
  fs.writeFileSync(modelsFile, JSON.stringify(RAW_MODELS));
  reset();
  const dir = initRepo([`node -e "process.exit(0)"`], { router: true });
  try {
    await quiet(() => runPipeline({ repoDir: dir, task: "Add feature", openPr: false, client: fakeClient(), skipTests: true, skipBughunter: true }));
    const rows = readOutcomes();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, "committed");
    assert.equal(rows[0].fixRounds, 0);
    assert.equal(rows[0].openFindings, 0);
    assert.ok(rows[0].costUsd > 0);
    assert.ok(rows[0].models.implementer, "implementer model recorded");
    assert.ok(rows[0].reviewRounds >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    reset();
  }
});

test("pipeline: failing verify appends a failed outcome with fixRounds > 0", async () => {
  fs.writeFileSync(modelsFile, JSON.stringify(RAW_MODELS));
  reset();
  const dir = initRepo([`node -e "console.error('FAIL always');process.exit(1)"`]);
  try {
    await assert.rejects(() => quiet(() => runPipeline({ repoDir: dir, task: "Add feature", openPr: false, client: fakeClient(), skipTests: true, skipReview: true, skipBughunter: true })));
    const rows = readOutcomes();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, "failed");
    assert.ok(rows[0].fixRounds > 0);
    assert.ok(rows[0].error);
    assert.equal(isSuccess(rows[0]), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    reset();
  }
});

// ---- verifyParallel ----
const stamp = (name: string, ms: number, exit = 0) =>
  `node -e "const fs=require('fs');const s=Date.now();setTimeout(()=>{fs.writeFileSync(process.env.STAMP_DIR+'/${name}',s+','+Date.now());if(${exit})console.error('BOOM-${name}');process.exit(${exit})},${ms})"`;

test("verifyParallel: commands run concurrently; first failing command in configured order is reported", async () => {
  fs.writeFileSync(modelsFile, JSON.stringify(RAW_MODELS));
  reset();
  const stampDir = fs.mkdtempSync(path.join(tmp, "stamps-"));
  process.env.STAMP_DIR = stampDir;
  const dir = initRepo([stamp("a", 400), stamp("b", 400)], { verifyParallel: true });
  const dirFail = initRepo([stamp("c", 100, 0), stamp("d", 400, 1), stamp("e", 100, 1)], { verifyParallel: true, maxFixRetries: 0 });
  try {
    await quiet(() => runPipeline({ repoDir: dir, task: "Add feature", openPr: false, client: fakeClient(), skipTests: true, skipReview: true, skipBughunter: true }));
    const [as, ae] = fs.readFileSync(path.join(stampDir, "a"), "utf8").split(",").map(Number);
    const [bs, be] = fs.readFileSync(path.join(stampDir, "b"), "utf8").split(",").map(Number);
    assert.ok(as < be && bs < ae, "execution windows overlap (ran concurrently)");

    const logs: string[] = [];
    const ol = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    const oe = console.error;
    console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
    let err: Error | undefined;
    try {
      await runPipeline({ repoDir: dirFail, task: "Add feature", openPr: false, client: fakeClient(), skipTests: true, skipReview: true, skipBughunter: true });
    } catch (e) {
      err = e as Error;
    } finally {
      console.log = ol;
      console.error = oe;
    }
    assert.ok(err, "pipeline fails");
    const msg = `${err!.message}\n${logs.join("\n")}`;
    assert.match(msg, /BOOM-d/, "first failing command in configured order (d, not e)");
    assert.doesNotMatch(err!.message, /BOOM-e/);
  } finally {
    delete process.env.STAMP_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dirFail, { recursive: true, force: true });
    reset();
  }
});

test("computeModelScores ignores cancelled, no-changes, and unattributable failures (fixRounds 0, no findings)", () => {
  const s = computeModelScores(
    [oc({ result: "cancelled" }), oc({ result: "no-changes" }), oc({ result: "failed", fixRounds: 0, openFindings: 0 })],
    NOW
  );
  assert.equal(s.size, 0);
  assert.equal(computeModelScores([oc({ result: "failed", fixRounds: 0, openFindings: 2 })], NOW).get("implementer:pa/small")?.n, 1);
});

test("formatReport: n/a without '$n/a' when nothing committed; cancelled excluded from first-pass denominator", () => {
  const none = formatReport({ outcomes: [oc({ result: "failed", fixRounds: 2 })], spendLines: [], scores: new Map() }).join("\n");
  assert.match(none, /cost per committed task: n\/a/);
  assert.doesNotMatch(none, /\$n\/a/);
  const r = formatReport({ outcomes: [oc(), oc({ result: "cancelled" }), oc({ result: "cancelled" })], spendLines: [], scores: new Map() }).join("\n");
  assert.match(r, /First-pass success: 100%/);
});
