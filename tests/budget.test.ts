import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  appendLedger,
  BudgetStopError,
  computeBudgetStatus,
  DEFAULT_BUDGET,
  formatBudgetReport,
  loadBudgetConfig,
  normalizeBudget,
  readLedger,
  type LedgerEntry,
} from "../src/budget.ts";
import { parseCliArgs } from "../src/config.ts";
import { getLedgerPath } from "../src/budget.ts";
import { getModelsFilePath } from "../src/pricing.ts";
import { runPipeline } from "../src/pipeline.ts";
import type { OpencodeClient } from "../src/runner.ts";

// Hermetic: never touch the developer's real ledger or models.json.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-budget-"));
const prevLedger = process.env.AI_SHIP_LEDGER_FILE;
const prevModels = process.env.AI_SHIP_MODELS_FILE;
process.env.AI_SHIP_LEDGER_FILE = path.join(TMP, "default-ledger.jsonl");
process.env.AI_SHIP_MODELS_FILE = path.join(TMP, "no-models.json");
process.on("exit", () => {
  if (prevLedger === undefined) delete process.env.AI_SHIP_LEDGER_FILE;
  else process.env.AI_SHIP_LEDGER_FILE = prevLedger;
  if (prevModels === undefined) delete process.env.AI_SHIP_MODELS_FILE;
  else process.env.AI_SHIP_MODELS_FILE = prevModels;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const NOW = new Date("2026-11-15T12:00:00Z");
const entry = (gbp: number, ts = "2026-11-10T12:00:00Z", extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  ts,
  taskId: "t",
  repo: "/r/proj",
  stage: "implement",
  model: "p/m",
  input: 1,
  output: 1,
  cacheRead: 0,
  costUsd: gbp, // with gbpPerUsd = 1, USD == GBP
  ...extra,
});
const status = (entries: LedgerEntry[], budget = DEFAULT_BUDGET, now = NOW) =>
  computeBudgetStatus({ entries, budget, gbpPerUsd: 1, now });

test("ledger roundtrip skips corrupt lines and honours since", () => {
  const f = path.join(TMP, "l1.jsonl");
  appendLedger(entry(1, "2026-10-01T00:00:00Z"), f);
  fs.appendFileSync(f, "{not json\n\n");
  appendLedger(entry(2, "2026-11-02T00:00:00Z"), f);
  assert.equal(readLedger(f).length, 2);
  const since = readLedger(f, new Date("2026-11-01T00:00:00Z"));
  assert.deepEqual(since.map((e) => e.costUsd), [2]);
  assert.deepEqual(readLedger(path.join(TMP, "missing.jsonl")), []);
});

test("normalizeBudget defaults and clamps reserve to monthly", () => {
  assert.deepEqual(normalizeBudget(undefined), { monthlyGBP: 90, reserveGBP: 8, perTaskMaxGBP: 3, softPct: 75, countSubscription: false });
  assert.equal(normalizeBudget({ perTaskMaxGBP: 0 }).perTaskMaxGBP, 3);
  assert.equal(normalizeBudget({ monthlyGBP: 5, reserveGBP: 20 }).reserveGBP, 5);
});

test("month boundary: previous-month and future entries do not count", () => {
  const s = status([entry(50, "2026-10-31T23:59:59Z"), entry(5, "2026-11-01T00:00:00Z"), entry(40, "2026-11-16T00:00:00Z")]);
  assert.equal(s.monthSpendGBP, 5);
});

test("states GREEN / AMBER / RED / STOP", () => {
  assert.equal(status([entry(10)]).state, "GREEN");
  assert.equal(status([]).state, "GREEN");
  const ahead = status([entry(45)]); // pro-rata ~£39.6 + slack max(3, 1.5*82/30=4.1)
  assert.equal(ahead.state, "AMBER");
  assert.match(ahead.reasons.join(" "), /pro-rata/);
  assert.equal(status([entry(62)]).state, "AMBER"); // >= 75% of £82
  assert.equal(status([entry(80)]).state, "RED"); // 97.6%
  assert.equal(status([entry(82)]).state, "STOP");
  assert.equal(status([entry(200)]).state, "STOP");
  // tiny overspend vs pro-rata (<= £0.50) stays GREEN
  assert.equal(status([entry(0.4)], DEFAULT_BUDGET, new Date("2026-11-01T01:00:00Z")).state, "GREEN");
});

test("AMBER when today's spend reaches the daily cap", () => {
  const s = status([entry(8, "2026-11-15T09:00:00Z")]);
  assert.equal(s.todaySpendGBP, 8);
  assert.equal(s.state, "AMBER");
  assert.match(s.reasons.join(" "), /daily cap/);
});

test("fx conversion applies to spend", () => {
  const s = computeBudgetStatus({ entries: [entry(127)], budget: DEFAULT_BUDGET, gbpPerUsd: 1 / 1.27, now: NOW });
  assert.ok(Math.abs(s.monthSpendGBP - 100) < 1e-9);
  assert.equal(s.state, "STOP");
});

test("daily cap and task cap math", () => {
  const s = status([]);
  assert.ok(Math.abs(s.dailyCapGBP - (82 / 16) * 1.5) < 1e-9);
  assert.equal(s.taskCapGBP, 3);
  const last = status([], DEFAULT_BUDGET, new Date("2026-11-30T12:00:00Z"));
  assert.ok(Math.abs(last.dailyCapGBP - 82) < 1e-9); // min(remaining, remaining*1.5)
  const low = status([entry(81)]);
  assert.ok(Math.abs(low.taskCapGBP - 1) < 1e-9);
  assert.ok(low.dailyCapGBP <= low.remainingGBP + 1e-9);
  assert.equal(status([entry(100)]).taskCapGBP, 0);
});

test("forecast extrapolates month-to-date spend", () => {
  const s = status([entry(10)]);
  assert.ok(Math.abs(s.forecastGBP - 10 / (14.5 / 30)) < 1e-6);
});

test("formatBudgetReport includes state, breakdowns and unknown-cost warning", () => {
  const entries = [
    entry(3, "2026-11-10T00:00:00Z", { model: "a/big", stage: "implement", repo: "/x/alpha" }),
    entry(1, "2026-11-11T00:00:00Z", { model: "b/small", stage: "review", repo: "/x/beta", costSource: "unknown" }),
  ];
  const text = formatBudgetReport(status(entries), entries, 1).join("\n");
  assert.match(text, /GREEN/);
  assert.match(text, /By model/);
  assert.match(text, /a\/big/);
  assert.match(text, /By stage/);
  assert.match(text, /review/);
  assert.match(text, /By repo/);
  assert.match(text, /alpha/);
  assert.match(text, /unknown cost/i);
  const clean = formatBudgetReport(status([entries[0]]), [entries[0]], 1).join("\n");
  assert.doesNotMatch(clean, /unknown cost/i);
});

test("loadBudgetConfig: repo overrides models file, file overrides defaults", () => {
  const f = path.join(TMP, "models-budget.json");
  fs.writeFileSync(f, JSON.stringify({ budget: { monthlyGBP: 50, perTaskMaxGBP: 1 } }));
  const merged = loadBudgetConfig({ perTaskMaxGBP: 2 }, f);
  assert.equal(merged.monthlyGBP, 50);
  assert.equal(merged.perTaskMaxGBP, 2);
  assert.equal(merged.softPct, 75);
  assert.deepEqual(loadBudgetConfig(undefined, path.join(TMP, "nope.json")), DEFAULT_BUDGET);
});

test("parseCliArgs --budget and --override-budget", () => {
  const a = parseCliArgs(["--budget"]);
  assert.equal(a.doBudget, true);
  assert.equal(a.overrideBudget, false);
  const b = parseCliArgs(["--override-budget", "do a thing"]);
  assert.equal(b.overrideBudget, true);
  assert.equal(b.doBudget, false);
});

test("BudgetStopError carries the status", () => {
  const s = status([entry(100)]);
  const err = new BudgetStopError(s);
  assert.equal(err.name, "BudgetStopError");
  assert.equal(err.status.state, "STOP");
  assert.ok(err instanceof Error);
});

test("one £3 task on day 1 stays GREEN", () => {
  assert.equal(status([entry(3, "2026-11-01T01:00:00Z")], DEFAULT_BUDGET, new Date("2026-11-01T02:00:00Z")).state, "GREEN");
});

test("readLedger skips unparseable ts and negative/NaN costs", () => {
  const f = path.join(TMP, "bad.jsonl");
  fs.writeFileSync(
    f,
    [
      JSON.stringify(entry(1)),
      JSON.stringify({ ...entry(1), ts: "garbage" }),
      JSON.stringify({ ...entry(1), costUsd: -5 }),
      '{"ts":"2026-11-10T00:00:00Z","costUsd":null}',
      JSON.stringify({ ...entry(1), costUsd: "x" }),
    ].join("\n") + "\n"
  );
  assert.equal(readLedger(f).length, 1);
});

test("subscription entries excluded unless countSubscription; unknownCostCalls counted", () => {
  const es = [entry(10), entry(20, undefined, { billing: "subscription" }), entry(0, undefined, { costSource: "unknown" })];
  assert.equal(status(es).monthSpendGBP, 10);
  assert.equal(status(es).unknownCostCalls, 1);
  assert.equal(status(es, { ...DEFAULT_BUDGET, countSubscription: true }).monthSpendGBP, 30);
});

test("perTaskMaxGBP 0 still yields a positive task cap", () => {
  assert.equal(status([], normalizeBudget({ perTaskMaxGBP: 0 })).taskCapGBP, 3);
});

test("default ledger/models paths fall under tmpdir during tests without env vars", () => {
  const a = process.env.AI_SHIP_LEDGER_FILE;
  const b = process.env.AI_SHIP_MODELS_FILE;
  delete process.env.AI_SHIP_LEDGER_FILE;
  delete process.env.AI_SHIP_MODELS_FILE;
  try {
    assert.ok(getLedgerPath().startsWith(os.tmpdir()));
    assert.ok(getModelsFilePath().startsWith(os.tmpdir()));
  } finally {
    process.env.AI_SHIP_LEDGER_FILE = a;
    process.env.AI_SHIP_MODELS_FILE = b;
  }
});

// ---------------------------------------------------------------------------
// Pipeline integration (fake OpenCode client)
// ---------------------------------------------------------------------------

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-budget-repo-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "T"', { cwd: dir, stdio: "ignore" });
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
      maxTaskTokens: 1_000_000_000,
      maxTaskCostUsd: 100,
    })
  );
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeClient() {
  const roles: string[] = [];
  const titles = new Map<string, string>();
  let n = 0;
  const client = {
    session: {
      async create(req: { body: { title: string } }) {
        const id = `s-${++n}`;
        titles.set(id, req.body.title);
        return { data: { id } };
      },
      async prompt(req: { path: { id: string }; query: { directory: string }; body: { agent: string } }) {
        roles.push(req.body.agent);
        if (req.body.agent === "implementer") {
          fs.mkdirSync(path.join(req.query.directory, "src"), { recursive: true });
          fs.writeFileSync(path.join(req.query.directory, "src", "a.ts"), "export const v = 1;\n");
        }
        const title = titles.get(req.path.id) ?? "";
        const text = req.body.agent === "bughunter" && title.includes("Hunter") ? "NO_HYPOTHESES\nVERDICT: CLEAN" : "Done.\nVERDICT: CLEAN";
        return {
          data: {
            parts: [{ type: "text", text }],
            info: { providerID: "fp", modelID: "fm", cost: 0.001, tokens: { input: 10, output: 5, cache: { read: 0 } } },
          },
        };
      },
    },
  } as unknown as OpencodeClient;
  return { client, roles };
}

async function quietRun(dir: string, client: OpencodeClient, extra: { overrideBudget?: boolean; model?: string } = {}) {
  const orig = console.log;
  console.log = () => {};
  try {
    return await runPipeline({ repoDir: dir, task: "Add feature", openPr: false, skipTests: true, client, ...extra });
  } finally {
    console.log = orig;
  }
}

function seedLedger(file: string, gbp: number): void {
  fs.rmSync(file, { force: true });
  appendLedger(entry(gbp * 1.27, new Date().toISOString()), file); // fx 1.27 USD per GBP (default)
}

test("pipeline: STOP ledger throws BudgetStopError before creating a worktree; overrideBudget proceeds", async () => {
  const ledger = path.join(TMP, "stop.jsonl");
  process.env.AI_SHIP_LEDGER_FILE = ledger;
  seedLedger(ledger, 100);
  const dir = initRepo();
  try {
    const { client, roles } = makeClient();
    await assert.rejects(quietRun(dir, client), (e: unknown) => e instanceof BudgetStopError);
    assert.equal(roles.length, 0);
    assert.equal(fs.existsSync(path.join(dir, ".ai-ship-worktrees")) && fs.readdirSync(path.join(dir, ".ai-ship-worktrees")).length > 0, false);

    const res = await quietRun(dir, client, { overrideBudget: true });
    assert.equal(res.committed, true);
    assert.equal(res.budgetState, "STOP");
  } finally {
    process.env.AI_SHIP_LEDGER_FILE = path.join(TMP, "default-ledger.jsonl");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: a GREEN run appends ledger entries with stage and model; bughunter runs", async () => {
  const ledger = path.join(TMP, "green.jsonl");
  process.env.AI_SHIP_LEDGER_FILE = ledger;
  fs.rmSync(ledger, { force: true });
  const dir = initRepo();
  try {
    const { client, roles } = makeClient();
    const res = await quietRun(dir, client, { model: "fp/fm" });
    assert.equal(res.budgetState, "GREEN");
    const entries = readLedger(ledger);
    assert.ok(entries.length > 0);
    assert.ok(entries.every((e) => typeof e.stage === "string" && e.stage.length > 0 && e.costUsd > 0));
    assert.ok(entries.some((e) => typeof e.model === "string" && e.model.length > 0), "some entry records its model");
    assert.ok(entries.every((e) => e.repo === dir && e.taskId));
    assert.ok(roles.includes("bughunter"), "bughunter runs when GREEN");
  } finally {
    process.env.AI_SHIP_LEDGER_FILE = path.join(TMP, "default-ledger.jsonl");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: RED state skips the bughunter", async () => {
  const ledger = path.join(TMP, "red.jsonl");
  process.env.AI_SHIP_LEDGER_FILE = ledger;
  seedLedger(ledger, 80);
  const dir = initRepo();
  try {
    const { client, roles } = makeClient();
    const res = await quietRun(dir, client);
    assert.equal(res.budgetState, "RED");
    assert.equal(roles.includes("bughunter"), false);
    assert.ok(roles.includes("implementer"));
  } finally {
    process.env.AI_SHIP_LEDGER_FILE = path.join(TMP, "default-ledger.jsonl");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
