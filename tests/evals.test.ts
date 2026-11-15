import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  defaultSuiteDir,
  formatEvalReport,
  latestEvalReports,
  loadSuite,
  runEval,
  runHiddenTests,
  saveEvalReport,
  type EvalReport,
} from "../src/evals.ts";
import { parseCliArgs } from "../src/config.ts";
import type { AgentRole, PipelineRunner, PromptResult } from "../src/runner.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `evals-test-${p}-`));
process.env.AI_SHIP_EVALS_DIR = tmp("reports");
process.env.AI_SHIP_LEDGER_FILE = path.join(tmp("ledger"), "ledger.jsonl");
// This process runs with NODE_TEST_CONTEXT set; runHiddenTests must strip it for child `node --test` runs,
// otherwise they always exit 0. The tests below rely on that (no workaround here).

const IMPL_NAMES = ["memo-async-rejection", "paginate-off-by-one", "parse-duration-feature", "safejoin-traversal", "slugify-feature"];
const REV_NAMES = ["clean-parameterized-query", "clean-rename-and-guard", "idor-missing-owner-check", "missing-await-in-loop", "sql-injection-concat"];

const PAGINATE_FIX = `export function paginate(items, page, size) {
  if (!Number.isInteger(page) || !Number.isInteger(size) || page < 1 || size < 1) return [];
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}
`;

interface FakeOpts {
  onPrompt?: (ws: string, text: string, session: string) => void | Promise<void>;
  reply?: (session: string, text: string) => string;
  cost?: number;
  throwOnPrompt?: boolean;
}

function fake(opts: FakeOpts = {}) {
  const state = { dirs: [] as string[], closed: 0, prompts: 0, roles: [] as string[] };
  const makeRunner = async (dir: string, role: AgentRole, _model: string): Promise<PipelineRunner> => {
    state.dirs.push(dir);
    state.roles.push(role);
    return {
      createSession: async (title: string) => title.replace(/^eval: /, ""),
      prompt: async (sid: string, _r: AgentRole, text: string): Promise<PromptResult> => {
        state.prompts++;
        await opts.onPrompt?.(dir, text, sid);
        if (opts.throwOnPrompt) throw new Error("boom: model exploded");
        return {
          text: opts.reply?.(sid, text) ?? "done",
          usageSummary: "",
          usage: { input: 1, output: 1, cacheRead: 0, costUsd: opts.cost ?? 0 },
        };
      },
      close: () => {
        state.closed++;
      },
    };
  };
  return { state, makeRunner };
}

test("loadSuite finds all 5 implementer and 5 reviewer cases from the real evals dir", () => {
  const imp = loadSuite("implementer");
  assert.deepEqual(imp.map((c) => c.name), IMPL_NAMES);
  const rev = loadSuite("reviewer");
  assert.deepEqual(rev.map((c) => c.name), REV_NAMES);
  assert.deepEqual(rev.map((c) => (c as { expected: string }).expected), ["CLEAN", "CLEAN", "OPEN", "OPEN", "OPEN"]);
  assert.ok(imp.every((c) => c.kind === "implementer" && (c as { task: string }).task.length > 0));
});

test("loadSuite `only` filter and missing/empty suite", () => {
  assert.deepEqual(loadSuite("implementer", undefined, ["slugify-feature"]).map((c) => c.name), ["slugify-feature"]);
  assert.deepEqual(loadSuite("reviewer", undefined, ["sql-injection-concat", "nope"]).map((c) => c.name), ["sql-injection-concat"]);
  const empty = tmp("suite");
  assert.throws(() => loadSuite("implementer", empty), /No implementer eval cases/);
  fs.mkdirSync(path.join(empty, "reviewer"));
  assert.throws(() => loadSuite("reviewer", empty), /No reviewer eval cases/);
  assert.throws(() => loadSuite("reviewer", defaultSuiteDir(), ["does-not-exist"]), /No reviewer eval cases/);
});

test("every fixture's hidden tests FAIL on the untouched fixture repo", () => {
  for (const c of loadSuite("implementer") as Array<{ name: string; dir: string; test: string }>) {
    const ws = tmp(`untouched-${c.name}`);
    fs.cpSync(path.join(c.dir, "repo"), ws, { recursive: true });
    // runHiddenTests strips NODE_TEST_CONTEXT, which this test process has set.
    const r = runHiddenTests(c as never, ws);
    assert.equal(r.pass, false, `${c.name}: hidden tests unexpectedly pass on untouched repo\n${r.output}`);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("implementer: workspace has no hidden/, is a git repo with fixture committed; correct fix passes", async () => {
  let seen: { hidden: boolean; log: string; clean: string; promptHasTask: boolean } | undefined;
  const f = fake({
    onPrompt: (ws, text) => {
      const log = spawnSync("git", ["log", "--oneline"], { cwd: ws, encoding: "utf8" }).stdout;
      const clean = spawnSync("git", ["status", "--porcelain"], { cwd: ws, encoding: "utf8" }).stdout;
      seen = { hidden: fs.existsSync(path.join(ws, "hidden")), log, clean, promptHasTask: /paginate/i.test(text) };
      assert.ok(fs.existsSync(path.join(ws, "src", "paginate.mjs")));
      fs.writeFileSync(path.join(ws, "src", "paginate.mjs"), PAGINATE_FIX);
    },
  });
  const rep = await runEval({ role: "implementer", model: "a/b", only: ["paginate-off-by-one"], makeRunner: f.makeRunner, ledger: false });
  assert.equal(seen?.hidden, false);
  assert.match(seen!.log, /fixture/);
  assert.equal(seen!.clean.trim(), "");
  assert.equal(seen!.promptHasTask, true);
  assert.equal(rep.cases.length, 1);
  assert.equal(rep.cases[0].pass, true, rep.cases[0].error);
  assert.equal(rep.passRate, 1);
  assert.equal(rep.recall, undefined);
  assert.deepEqual(f.state.roles, ["implementer"]);
});

test("implementer: no-op fails; workspace deleted; runner closed", async () => {
  const f = fake();
  const rep = await runEval({ role: "implementer", model: "a/b", only: ["paginate-off-by-one"], makeRunner: f.makeRunner, ledger: false });
  assert.equal(rep.cases[0].pass, false);
  assert.ok(rep.cases[0].error);
  assert.equal(rep.passRate, 0);
  assert.equal(f.state.closed, 1);
  assert.ok(f.state.dirs.every((d) => !fs.existsSync(d)));
});

test("implementer: agent-written hidden/ dummy test is replaced by the real one", async () => {
  const f = fake({
    onPrompt: (ws) => {
      fs.mkdirSync(path.join(ws, "hidden"));
      fs.writeFileSync(path.join(ws, "hidden", "dummy.test.mjs"), `import test from "node:test"; test("ok", () => {});\n`);
      // also overwrite the real test's filename with a passing stub
      fs.writeFileSync(path.join(ws, "hidden", "paginate.test.mjs"), `import test from "node:test"; test("ok", () => {});\n`);
    },
  });
  const rep = await runEval({ role: "implementer", model: "a/b", only: ["paginate-off-by-one"], makeRunner: f.makeRunner, ledger: false });
  assert.equal(rep.cases[0].pass, false);
});

test("runner.close() called and workspace removed even when prompt throws", async () => {
  const f = fake({ throwOnPrompt: true });
  const rep = await runEval({ role: "implementer", model: "a/b", only: ["paginate-off-by-one"], makeRunner: f.makeRunner, ledger: false });
  assert.equal(rep.cases[0].pass, false);
  assert.match(rep.cases[0].error ?? "", /boom/);
  assert.equal(f.state.closed, 1);
  assert.ok(f.state.dirs.every((d) => !fs.existsSync(d)));

  const f2 = fake({ throwOnPrompt: true });
  const rev = await runEval({ role: "reviewer", model: "a/b", only: ["sql-injection-concat"], makeRunner: f2.makeRunner, ledger: false });
  assert.equal(rev.cases[0].pass, false);
  assert.match(rev.cases[0].error ?? "", /boom/);
  assert.equal(f2.state.closed, 1);
  assert.ok(f2.state.dirs.every((d) => !fs.existsSync(d)));
});

test("reviewer: per-case pass, recall/precision with always-OPEN", async () => {
  const f = fake({ reply: () => "Looks risky.\nVERDICT: OPEN" });
  const rep = await runEval({ role: "reviewer", model: "a/b", makeRunner: f.makeRunner, ledger: false });
  assert.equal(rep.cases.length, 5);
  assert.deepEqual(rep.cases.map((c) => c.pass), [false, false, true, true, true]);
  assert.equal(rep.recall, 1);
  assert.equal(rep.precision, 3 / 5);
  assert.equal(rep.passRate, 3 / 5);
  assert.ok(f.state.dirs.every((d) => !fs.existsSync(d)));
});

test("reviewer: perfect and always-CLEAN replies", async () => {
  const perfect = fake({ reply: (sid) => `x\nVERDICT: ${sid.startsWith("clean-") ? "CLEAN" : "OPEN"}` });
  const p = await runEval({ role: "reviewer", model: "a/b", makeRunner: perfect.makeRunner, ledger: false });
  assert.equal(p.passRate, 1);
  assert.equal(p.recall, 1);
  assert.equal(p.precision, 1);
  const clean = fake({ reply: () => "No findings\nVERDICT: CLEAN" });
  const c = await runEval({ role: "reviewer", model: "a/b", makeRunner: clean.makeRunner, ledger: false });
  assert.equal(c.recall, 0);
  assert.equal(c.precision, 0);
  assert.equal(c.passRate, 2 / 5);
});

test("reviewer: missing verdict counts as fail", async () => {
  const f = fake({ reply: () => "I have no idea" });
  const rep = await runEval({ role: "reviewer", model: "a/b", makeRunner: f.makeRunner, ledger: false });
  assert.ok(rep.cases.every((c) => c.pass === false), "MISSING must not pass even for CLEAN cases");
  assert.equal(rep.cases[0].verdict, "MISSING");
  assert.equal(rep.recall, 0);
});

test("n repeats give attempt numbers; maxCostUsd stops new cases; aggregates with injected now", async () => {
  let t = 0;
  const now = () => (t += 1000);
  const f = fake({ reply: () => "VERDICT: OPEN", cost: 0.25 });
  const rep = await runEval({ role: "reviewer", model: "a/b", n: 2, only: ["sql-injection-concat", "idor-missing-owner-check"], makeRunner: f.makeRunner, ledger: false, now });
  assert.deepEqual(rep.cases.map((c) => `${c.name}#${c.attempt}`), [
    "idor-missing-owner-check#1",
    "sql-injection-concat#1",
    "idor-missing-owner-check#2",
    "sql-injection-concat#2",
  ]);
  assert.equal(rep.n, 2);
  assert.equal(rep.costUsd, 1);
  assert.equal(rep.avgLatencyMs, 1000);
  assert.ok(rep.cases.every((c) => c.latencyMs === 1000 && c.costUsd === 0.25));

  const g = fake({ reply: () => "VERDICT: OPEN", cost: 0.25 });
  const capped = await runEval({ role: "reviewer", model: "a/b", n: 3, maxCostUsd: 0.5, makeRunner: g.makeRunner, ledger: false });
  assert.equal(capped.cases.length, 2);
  assert.equal(g.state.prompts, 2);
  assert.equal(capped.costUsd, 0.5);
});

test("n is clamped to 1..10", async () => {
  const f = fake({ reply: () => "VERDICT: OPEN" });
  const rep = await runEval({ role: "reviewer", model: "a/b", n: 99, only: ["sql-injection-concat"], makeRunner: f.makeRunner, ledger: false });
  assert.equal(rep.n, 10);
  assert.equal(rep.cases.length, 10);
});

test("ledger records spend under the eval task id when enabled", async () => {
  const ledger = process.env.AI_SHIP_LEDGER_FILE!;
  fs.rmSync(ledger, { force: true });
  const f = fake({ reply: () => "VERDICT: OPEN", cost: 0.1 });
  await runEval({ role: "reviewer", model: "a/b", only: ["sql-injection-concat"], makeRunner: f.makeRunner });
  const lines = fs.readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].taskId, "eval:reviewer:a/b");
  assert.equal(lines[0].costUsd, 0.1);
});

const mkReport = (over: Partial<EvalReport>): EvalReport => ({
  ts: "2026-01-01T00:00:00.000Z", model: "a/b", role: "reviewer", n: 1,
  cases: [{ name: "x", attempt: 1, pass: true, costUsd: 0.01, latencyMs: 1500 }],
  passRate: 1, costUsd: 0.01, avgLatencyMs: 1500, ...over,
});

test("saveEvalReport + latestEvalReports keep latest per role:model, skip corrupt", () => {
  const dir = tmp("save");
  assert.deepEqual(latestEvalReports(path.join(dir, "missing")), []);
  const f1 = saveEvalReport(mkReport({ ts: "2026-01-01T00:00:00.000Z", passRate: 0.2 }), dir);
  saveEvalReport(mkReport({ ts: "2026-02-01T00:00:00.000Z", passRate: 0.9 }), dir);
  saveEvalReport(mkReport({ ts: "2026-03-01T00:00:00.000Z", model: "p/q:weird name", passRate: 0.5 }), dir);
  saveEvalReport(mkReport({ ts: "2026-03-01T00:00:00.000Z", role: "implementer", passRate: 0.4 }), dir);
  fs.writeFileSync(path.join(dir, "9999-corrupt.json"), "{not json");
  fs.writeFileSync(path.join(dir, "9999-shape.json"), JSON.stringify({ foo: 1 }));
  assert.match(path.basename(f1), /^2026-01-01T00-00-00-000Z-reviewer-a_b\.json$/);
  const all = latestEvalReports(dir);
  assert.equal(all.length, 3);
  const ab = all.find((r) => r.role === "reviewer" && r.model === "a/b");
  assert.equal(ab?.passRate, 0.9);
});

test("formatEvalReport first line format", () => {
  const lines = formatEvalReport(mkReport({ passRate: 0.6, costUsd: 0.12345, avgLatencyMs: 2500, recall: 1, precision: 0.6,
    cases: [
      { name: "a", attempt: 1, pass: true, costUsd: 0, latencyMs: 1, verdict: "OPEN", expected: "OPEN" },
      { name: "b", attempt: 1, pass: false, costUsd: 0, latencyMs: 1, error: "line1\nline2" },
    ] }));
  assert.equal(lines[0], "Eval reviewer a/b: 60% pass (1/2), $0.1235, avg 2.5s");
  assert.equal(lines[1], "  OPEN recall 100%, precision 60%");
  assert.equal(lines[2], "  PASS a#1 (OPEN, expected OPEN)");
  assert.equal(lines[3], "  FAIL b#1 — line1");
});

test("parseCliArgs eval flags", () => {
  const p = parseCliArgs(["--eval", "implementer", "--model", "a/b", "--eval-n", "3", "--eval-only", "x, y,,z", "--eval-max-cost", "0.5"]);
  assert.equal(p.unknownOption, undefined);
  assert.equal(p.evalRole, "implementer");
  assert.equal(p.model, "a/b");
  assert.equal(p.evalN, 3);
  assert.deepEqual(p.evalOnly, ["x", "y", "z"]);
  assert.equal(p.evalMaxCostUsd, 0.5);
  assert.equal(parseCliArgs(["--eval", "reviewer"]).evalRole, "reviewer");
  assert.equal(parseCliArgs(["--eval-results"]).doEvalResults, true);
  assert.equal(parseCliArgs([]).evalRole, undefined);
});

test("parseCliArgs eval flag validation", () => {
  assert.match(parseCliArgs(["--eval", "tester"]).unknownOption ?? "", /--eval tester/);
  for (const bad of ["0", "11", "1.5", "abc", "-2"]) assert.match(parseCliArgs(["--eval-n", bad]).unknownOption ?? "", /--eval-n/, bad);
  for (const bad of ["0", "-1", "abc"]) assert.match(parseCliArgs(["--eval-max-cost", bad]).unknownOption ?? "", /--eval-max-cost/, bad);
  assert.equal(parseCliArgs(["--eval-n", "10"]).evalN, 10);
});
