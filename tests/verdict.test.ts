import test from "node:test";
import assert from "node:assert/strict";
import {
  BudgetExceededError,
  BudgetTracker,
  HUNTER_REASK_PROMPT,
  VERDICT_REASK_PROMPT,
  classifyHunterOutput,
  parseBughunterVerdict,
  parseVerdict,
  resolveVerdictWithReask,
  runBughunterPass,
  runReviewLenses,
} from "../src/pipeline.ts";
import {
  EmptyModelResponseError,
  assertNonEmptyReadOnlyReply,
  classifyProviderError,
  executeWithFailoverAndRetry,
} from "../src/runner.ts";
import type { RepoConfig } from "../src/config.ts";
import type { AgentRole, PipelineRunner } from "../src/runner.ts";

const INSTRUCTION = "End with `VERDICT: CLEAN` or `VERDICT: OPEN`.";

const parseCases: Array<[string, string, "CLEAN" | "OPEN" | "MISSING"]> = [
  ["empty", "", "MISSING"],
  ["whitespace only", "  \n\t ", "MISSING"],
  ["no critical issues prose", "No critical issues found.", "MISSING"],
  ["critical keyword no verdict", "There is a critical vulnerability.", "MISSING"],
  ["instruction text alone", INSTRUCTION, "MISSING"],
  ["quoted instruction then real verdict", `${INSTRUCTION}\nFound a bug.\nVERDICT: OPEN`, "OPEN"],
  ["bold clean", "**VERDICT: CLEAN**", "CLEAN"],
  ["two verdicts, last wins", "VERDICT: CLEAN\nmore\nVERDICT: OPEN", "OPEN"],
  ["two verdicts, last wins (reverse)", "VERDICT: OPEN\nmore\nVERDICT: CLEAN", "CLEAN"],
  ["lowercase", "verdict: open", "OPEN"],
  ["both options on one line", "VERDICT: CLEAN or VERDICT: OPEN", "MISSING"],
  ["both options in backticks", "`VERDICT: CLEAN` or `VERDICT: OPEN`", "MISSING"],
  ["conditional verdict", "VERDICT: CLEAN if the null check is added", "MISSING"],
  ["VERDICT: CLEANUP", "VERDICT: CLEANUP", "MISSING"],
  ["VERDICT: CLEAN-ish", "VERDICT: CLEAN-ish", "MISSING"],
  ["trailing period", "VERDICT: OPEN.", "OPEN"],
  ["blockquote prefix", "> VERDICT: CLEAN", "CLEAN"],
];
for (const [name, text, expected] of parseCases) {
  test(`parseVerdict: ${name} -> ${expected}`, () => {
    assert.equal(parseVerdict(text), expected);
  });
}

const config: RepoConfig = {
  baseBranch: "main",
  verify: [],
  testCommand: null,
  reviewConcurrency: 1,
  reviewStaggerMs: 0,
  maxFixRetries: 3,
  maxReviewRounds: 2,
  securityScan: false,
  safetyCheck: false,
};

interface Call {
  sessionId: string;
  title: string;
  role: AgentRole;
  text: string;
}

/** Scripted runner: replies are consumed per session title; the last reply repeats once exhausted. */
function scriptedRunner(script: Record<string, string[]>) {
  const calls: Call[] = [];
  const titles = new Map<string, string>();
  const used = new Map<string, number>();
  let n = 0;
  const runner: PipelineRunner = {
    async createSession(title) {
      const id = `s${++n}`;
      titles.set(id, title);
      return id;
    },
    async prompt(sessionId, role, text) {
      const title = titles.get(sessionId) ?? "?";
      calls.push({ sessionId, title, role, text });
      const key = Object.keys(script).find((k) => title.includes(k));
      const replies = key ? script[key] : [""];
      const i = used.get(sessionId) ?? 0;
      used.set(sessionId, i + 1);
      return { text: replies[Math.min(i, replies.length - 1)], usageSummary: "" };
    },
    close() {},
  };
  return { runner, calls };
}

test("runReviewLenses: missing verdict is re-asked in the same session and then accepted", async () => {
  const { runner, calls } = scriptedRunner({ "(Security)": ["No critical issues found.", "VERDICT: CLEAN"] });
  const usageLog: string[] = [];
  const out = await runReviewLenses({
    lenses: [{ name: "Security", focus: "auth" }],
    config,
    runner,
    usageLog,
  });
  assert.equal(out[0].verdict, "CLEAN");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].text, VERDICT_REASK_PROMPT);
  assert.equal(calls[1].sessionId, calls[0].sessionId);
  assert.ok(usageLog.some((l) => /re-ask/i.test(l)));
});

test("runReviewLenses: lens that never gives a verdict fails closed to OPEN", async () => {
  const { runner, calls } = scriptedRunner({
    "(Security)": ["VERDICT: CLEAN"],
    "(Perf)": ["No critical issues found.", ""],
  });
  const usageLog: string[] = [];
  const out = await runReviewLenses({
    lenses: [
      { name: "Security", focus: "auth" },
      { name: "Perf", focus: "perf" },
    ],
    config,
    runner,
    usageLog,
  });
  assert.equal(out.find((r) => r.lens === "Security")?.verdict, "CLEAN");
  assert.equal(out.find((r) => r.lens === "Perf")?.verdict, "OPEN");
  assert.equal(calls.filter((c) => c.text === VERDICT_REASK_PROMPT).length, 1, "re-ask exactly once");
  assert.ok(usageLog.some((l) => /fail(ing)? closed/i.test(l)));
});

test("classifyHunterOutput", () => {
  assert.equal(classifyHunterOutput("BUG-1: x"), "HYPOTHESES");
  assert.equal(classifyHunterOutput("NO_HYPOTHESES\nVERDICT: CLEAN"), "NONE");
  assert.equal(classifyHunterOutput("looks fine"), "MISSING");
  assert.equal(classifyHunterOutput(""), "MISSING");
});

test("runBughunterPass: Hunter garbage twice -> OPEN, Skeptic and Referee never called", async () => {
  const { runner, calls } = scriptedRunner({ Hunter: ["looks fine to me", "still nothing"] });
  const usageLog: string[] = [];
  const res = await runBughunterPass({ task: "t", diff: "d", runner, usageLog });
  assert.equal(res.verdict, "OPEN");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].text, HUNTER_REASK_PROMPT);
  assert.equal(calls[1].sessionId, calls[0].sessionId);
  assert.ok(calls.every((c) => c.title.includes("Hunter")));
});

test("runBughunterPass: Hunter garbage then NO_HYPOTHESES -> CLEAN without Skeptic/Referee", async () => {
  const { runner, calls } = scriptedRunner({ Hunter: ["garbage", "NO_HYPOTHESES\nVERDICT: CLEAN"] });
  const res = await runBughunterPass({ task: "t", diff: "d", runner, usageLog: [] });
  assert.equal(res.verdict, "CLEAN");
  assert.equal(calls.length, 2);
});

const REJECTED = "FINDING F1 | REJECTED | LOW | a.ts:1 | A -> B | not reachable";
const CONFIRMED = "FINDING F1 | CONFIRMED | HIGH | a.ts:1 | A -> B | reachable";

test("runBughunterPass: Referee with only REJECTED findings and no verdict after re-ask -> OPEN", async () => {
  const { runner, calls } = scriptedRunner({
    Hunter: ["BUG-1: x\n- Location: a.ts:1"],
    Skeptic: ["Challenge: unreachable"],
    Referee: [REJECTED, REJECTED],
  });
  const res = await runBughunterPass({ task: "t", diff: "d", runner, usageLog: [] });
  assert.equal(res.verdict, "OPEN");
  const referee = calls.filter((c) => c.title.includes("Referee"));
  assert.equal(referee.length, 2);
  assert.equal(referee[1].text, VERDICT_REASK_PROMPT);
});

test("runBughunterPass: Referee REJECTED-only then re-ask yields VERDICT: CLEAN -> CLEAN", async () => {
  const { runner } = scriptedRunner({
    Hunter: ["BUG-1: x"],
    Skeptic: ["Challenge"],
    Referee: [REJECTED, "VERDICT: CLEAN"],
  });
  const res = await runBughunterPass({ task: "t", diff: "d", runner, usageLog: [] });
  assert.equal(res.verdict, "CLEAN");
});

test("parseBughunterVerdict fails closed", () => {
  assert.equal(parseBughunterVerdict(`${CONFIRMED}\nVERDICT: CLEAN`).verdict, "OPEN");
  assert.equal(parseBughunterVerdict(`${REJECTED}\nVERDICT: CLEAN`).verdict, "CLEAN");
  assert.equal(parseBughunterVerdict(REJECTED).verdict, "OPEN");
  assert.equal(parseBughunterVerdict("").verdict, "OPEN");
  assert.equal(parseBughunterVerdict("No critical issues found.").verdict, "OPEN");
});

test("EmptyModelResponseError is classified as transient", () => {
  assert.equal(classifyProviderError(new EmptyModelResponseError("reviewer")).transient, true);
});

test("assertNonEmptyReadOnlyReply throws for read-only roles only", () => {
  for (const role of ["reviewer", "bughunter"] as const) {
    for (const text of ["", "   \n\t"]) {
      assert.throws(
        () => assertNonEmptyReadOnlyReply(role, { text, usageSummary: "" }),
        EmptyModelResponseError
      );
    }
    const ok = { text: "hi", usageSummary: "" };
    assert.equal(assertNonEmptyReadOnlyReply(role, ok), ok);
  }
  for (const role of ["implementer", "tester"] as const) {
    assert.doesNotThrow(() => assertNonEmptyReadOnlyReply(role, { text: "", usageSummary: "" }));
    assert.doesNotThrow(() => assertNonEmptyReadOnlyReply(role, { text: "  ", usageSummary: "" }));
  }
});

test("classifyHunterOutput: NO_HYPOTHESES must stand on its own line", () => {
  assert.equal(classifyHunterOutput("I won't output NO_HYPOTHESES because the diff is risky."), "MISSING");
  assert.equal(classifyHunterOutput("NO_HYPOTHESES"), "NONE");
  assert.equal(classifyHunterOutput("analysis\n**NO_HYPOTHESES**\nVERDICT: CLEAN"), "NONE");
});

const emptyThenOk = () => {
  const models: Array<unknown> = [];
  let n = 0;
  return {
    models,
    invoke: async (model?: { providerID: string; modelID: string }) => {
      models.push(model);
      return assertNonEmptyReadOnlyReply("reviewer", { text: n++ === 0 ? "" : "VERDICT: CLEAN", usageSummary: "" });
    },
  };
};

test("executeWithFailoverAndRetry: empty reviewer reply is retried", async () => {
  const { invoke, models } = emptyThenOk();
  const res = await executeWithFailoverAndRetry({
    role: "reviewer",
    invoke,
    retry: { sleep: async () => {}, maxRetries: 2 },
  });
  assert.equal(res.text, "VERDICT: CLEAN");
  assert.equal(models.length, 2);
});

test("executeWithFailoverAndRetry: empty primary reply triggers the distinct fallback", async () => {
  const { invoke, models } = emptyThenOk();
  const primary = { providerID: "a", modelID: "m1" };
  const fallback = { providerID: "b", modelID: "m2" };
  const res = await executeWithFailoverAndRetry({
    role: "reviewer",
    primaryModel: primary,
    fallbackModel: fallback,
    invoke,
    retry: { sleep: async () => {}, maxRetries: 2 },
  });
  assert.deepEqual(models, [primary, fallback]);
  assert.equal(res.text, "VERDICT: CLEAN");
  assert.equal(res.fallback?.role, "reviewer");
});

test("resolveVerdictWithReask forwards modelOverride to the re-ask", async () => {
  const seen: unknown[] = [];
  const runner: PipelineRunner = {
    async createSession() {
      return "x";
    },
    async prompt(_sid, _role, _text, options) {
      seen.push(options);
      return { text: "VERDICT: CLEAN", usageSummary: "" };
    },
    close() {},
  };
  const override = { providerID: "p", modelID: "m" };
  const out = await resolveVerdictWithReask({
    runner,
    sessionId: "s1",
    role: "reviewer",
    label: "L",
    text: "nothing",
    usageLog: [],
    stageKey: "Stage 4: Review",
    promptOptions: { modelOverride: override },
  });
  assert.equal(out.verdict, "CLEAN");
  assert.deepEqual(seen, [{ modelOverride: override }]);
});

test("resolveVerdictWithReask checks the budget before re-asking", async () => {
  let prompted = false;
  const runner: PipelineRunner = {
    async createSession() {
      return "x";
    },
    async prompt() {
      prompted = true;
      return { text: "VERDICT: CLEAN", usageSummary: "" };
    },
    close() {},
  };
  const budget = new BudgetTracker({ maxTaskTokens: 10 });
  budget.record("Stage 4: Review", {
    text: "",
    usageSummary: "",
    usage: { input: 100, output: 100, cacheRead: 0, costUsd: 0 },
  });
  await assert.rejects(
    () =>
      resolveVerdictWithReask({
        runner,
        sessionId: "s1",
        role: "reviewer",
        label: "L",
        text: "nothing",
        usageLog: [],
        budget,
        stageKey: "Stage 4: Review",
      }),
    BudgetExceededError
  );
  assert.equal(prompted, false);
});
