import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  IMPLEMENTER_STATIC_INSTRUCTIONS,
  TEST_FIX_PROMPT,
  buildTestDisputePrompt,
  findDisputedTestFiles,
  parseTestDispute,
  runPipeline,
  splitDiffBlocks,
  truncateDiff,
} from "../src/pipeline.ts";
import type { OpencodeClient } from "../src/runner.ts";

// Hermetic pricing: never read the developer's real ~/.config/ai-ship/models.json.
const prevModelsFile = process.env.AI_SHIP_MODELS_FILE;
process.env.AI_SHIP_MODELS_FILE = path.join(os.tmpdir(), `ai-ship-no-models-flow-${process.pid}.json`);
process.on("exit", () => {
  if (prevModelsFile === undefined) delete process.env.AI_SHIP_MODELS_FILE;
  else process.env.AI_SHIP_MODELS_FILE = prevModelsFile;
});

function fileBlock(file: string, bodyLines: number, lineText = "+const x = 1;"): string {
  return [
    `diff --git a/${file} b/${file}`,
    "index 111..222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,1 +1,1 @@",
    ...Array.from({ length: bodyLines }, () => lineText),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 1. truncateDiff
// ---------------------------------------------------------------------------

test("truncateDiff returns the diff unchanged when it fits", () => {
  const diff = `${fileBlock("src/a.ts", 3)}\n${fileBlock("src/b.ts", 3)}`;
  assert.equal(truncateDiff(diff, diff.length), diff);
  assert.equal(truncateDiff(diff, diff.length + 1000), diff);
});

test("splitDiffBlocks splits per file", () => {
  const diff = `${fileBlock("src/a.ts", 2)}\n${fileBlock("tests/a.test.ts", 2)}`;
  const blocks = splitDiffBlocks(diff);
  assert.deepEqual(blocks.map((b) => b.file), ["src/a.ts", "tests/a.test.ts"]);
  assert.ok(blocks[0].text.startsWith("diff --git a/src/a.ts"));
});

test("truncateDiff keeps whole files, drops a large test file before small src files, and lists omitted", () => {
  const bigTest = fileBlock("tests/big.test.ts", 150); // ~2.1k chars, listed first in the original diff
  const srcA = fileBlock("src/a.ts", 5);
  const srcB = fileBlock("src/b.ts", 20);
  const diff = [bigTest, srcA, srcB].join("\n");
  const out = truncateDiff(diff, 1500);

  assert.ok(srcA.length + srcB.length < 1350, "fixture: both src files must fit the budget");
  assert.ok(out.includes(srcA), "small src file kept whole");
  assert.ok(out.includes(srcB), "second src file kept whole");
  assert.ok(!out.includes("diff --git a/tests/big.test.ts"), "large test file dropped");
  assert.match(out, /omitted file diffs/);
  assert.match(out, /- tests\/big\.test\.ts/);
  assert.ok(out.indexOf("src/a.ts") < out.indexOf("src/b.ts"), "original order kept");
  assert.ok(!out.includes("- src/a.ts") && !out.includes("- src/b.ts"), "kept files are not listed as omitted");
});

test("truncateDiff prefers production files over tests even when the test is smaller", () => {
  const srcBig = fileBlock("src/big.ts", 40);
  const smallTest = fileBlock("tests/x.test.ts", 2);
  const diff = [smallTest, srcBig].join("\n");
  const out = truncateDiff(diff, srcBig.length + 150);
  assert.ok(out.includes(srcBig));
  assert.match(out, /- tests\/x\.test\.ts/);
});

test("truncateDiff cuts a single oversize block at a line boundary with a note", () => {
  const block = fileBlock("src/huge.ts", 400, "+const value = 1234567890;");
  const out = truncateDiff(block, 1000);
  assert.ok(out.length < block.length);
  assert.match(out, /truncated/);
  const original = new Set(block.split("\n"));
  const kept = out.split("\n").filter((l) => !l.startsWith("(ai-ship:"));
  for (const l of kept) assert.ok(original.has(l), `partial line leaked: ${JSON.stringify(l)}`);
  assert.ok(kept.length > 5, "kept a useful prefix");
});

// ---------------------------------------------------------------------------
// 2. parseTestDispute / findDisputedTestFiles
// ---------------------------------------------------------------------------

test("parseTestDispute takes the last TEST_BUG/IMPL_BUG line", () => {
  const cases: Array<[string, string]> = [
    ["reason\nTEST_BUG", "TEST_BUG"],
    ["reason\nIMPL_BUG\n", "IMPL_BUG"],
    ["IMPL_BUG first\nthen thought again\nTEST_BUG", "TEST_BUG"],
    ["TEST_BUG\nactually\nIMPL_BUG", "IMPL_BUG"],
    ["**IMPL_BUG**", "IMPL_BUG"],
    ["> TEST_BUG", "TEST_BUG"],
    ["- `TEST_BUG`", "TEST_BUG"],
    ["test_bug", "TEST_BUG"],
    ["", "MISSING"],
    ["I think the verdict is probably TEST_BUG mid-sentence", "MISSING"],
    ["TEST_BUGS everywhere", "MISSING"],
    ["no verdict here", "MISSING"],
  ];
  for (const [input, expected] of cases) assert.equal(parseTestDispute(input), expected, JSON.stringify(input));
});

test("findDisputedTestFiles needs the full path on a failure-looking line", () => {
  const files = ["tests/a.test.ts", "tests/sub/b.test.ts", "tests/c.test.ts"];
  assert.deepEqual(findDisputedTestFiles("FAIL tests/a.test.ts\n  expected 1", files), ["tests/a.test.ts"]);
  assert.deepEqual(findDisputedTestFiles("not ok tests/sub/b.test.ts", files), ["tests/sub/b.test.ts"]);
  assert.deepEqual(findDisputedTestFiles("src/a.ts: error TS2322", files), []);
  assert.deepEqual(findDisputedTestFiles("anything", []), []);
  // basename alone no longer matches
  assert.deepEqual(findDisputedTestFiles("not ok b.test.ts", files), []);
  // passing-file listing is not a failure
  assert.deepEqual(findDisputedTestFiles("\u2714 tests/a.test.ts passed", files), []);
  // same-named file in another directory is not the tester's file
  assert.deepEqual(findDisputedTestFiles("FAIL x/a.test.ts", files), []);
  assert.deepEqual(findDisputedTestFiles("FAIL x/tests/a.test.ts", files), []);
  // absolute path on a FAIL line (needs worktreeDir)
  const wt = "/tmp/wt";
  assert.deepEqual(findDisputedTestFiles(`FAIL ${wt}/tests/a.test.ts:3`, files, wt), ["tests/a.test.ts"]);
  assert.deepEqual(findDisputedTestFiles("not ok tests/a.test.ts", files, wt), ["tests/a.test.ts"]);
});

test("splitDiffBlocks splits untracked sections after a tracked block; /dev/null header of a new tracked file stays", () => {
  const tracked = fileBlock("src/a.ts", 2);
  const untracked = ["--- /dev/null", "+++ b/src/new-untracked.ts", "@@ -0,0 +1,1 @@", "+export const z = 1;"].join("\n");
  const newTracked = [
    "diff --git a/src/n.ts b/src/n.ts",
    "new file mode 100644",
    "index 000..111",
    "--- /dev/null",
    "+++ b/src/n.ts",
    "@@ -0,0 +1,1 @@",
    "+x",
  ].join("\n");
  const blocks = splitDiffBlocks([tracked, newTracked, untracked].join("\n"));
  assert.deepEqual(blocks.map((b) => b.file), ["src/a.ts", "src/n.ts", "src/new-untracked.ts"]);
  assert.ok(blocks[1].text.includes("--- /dev/null"));
  assert.ok(!blocks[0].text.includes("new-untracked"));
});

test("truncateDiff caps the omitted list at 40 names", () => {
  const blocks = Array.from({ length: 80 }, (_, i) => fileBlock(`tests/t${i}.test.ts`, 8));
  const out = truncateDiff(blocks.join("\n"), 2500);
  const listed = out.split("\n").filter((l) => /^- tests\/t\d+\.test\.ts$/.test(l));
  assert.ok(listed.length <= 40 && listed.length > 0, `listed ${listed.length}`);
  assert.match(out, /\u2026and \d+ more/);
});

test("buildTestDisputePrompt carries task, files, command and output; TEST_FIX_PROMPT restricts edits to tests", () => {
  const p = buildTestDisputePrompt({ task: "Do X", files: ["tests/a.test.ts"], failedCommand: "npm test", output: "boom" });
  assert.match(p, /Do X/);
  assert.match(p, /tests\/a\.test\.ts/);
  assert.match(p, /npm test/);
  assert.match(p, /boom/);
  assert.match(p, /TEST_BUG/);
  assert.match(p, /IMPL_BUG/);
  assert.match(TEST_FIX_PROMPT, /test/i);
});

// ---------------------------------------------------------------------------
// Pipeline harness (fake OpenCode client)
// ---------------------------------------------------------------------------

interface Ev {
  kind: "create" | "prompt" | "summarize";
  sessionId: string;
  title: string;
  role?: string;
  text?: string;
}
interface Ctx {
  ev: Ev;
  dir: string;
  /** 1-based count of prompts so far for the same (role, title) pair, including this one. */
  nth: number;
  events: Ev[];
}
type Handler = (ctx: Ctx) => string | { text: string; input?: number } | void | Promise<string | { text: string; input?: number } | void>;

const VERIFY_SCRIPT = [
  "const fs=require('fs');",
  "const a=fs.existsSync('src/a.ts')?fs.readFileSync('src/a.ts','utf8'):'';",
  "const t=fs.existsSync('tests/feat.test.ts')?fs.readFileSync('tests/feat.test.ts','utf8'):'';",
  "if(!a.includes('good')||t.includes('wrong')){console.error('FAIL '+(t?'tests/feat.test.ts':'src/a.ts'));process.exit(1)}",
].join("");

function initRepo(extra: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-flow-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "T"', { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# t\n");
  fs.writeFileSync(
    path.join(dir, ".ai-ship.json"),
    JSON.stringify({
      baseBranch: "main",
      verify: [`node -e "${VERIFY_SCRIPT.replace(/"/g, '\\"')}"`],
      maxFixRetries: 3,
      maxReviewRounds: 3,
      reviewStaggerMs: 0,
      securityScan: false,
      safetyCheck: false,
      maxTaskTokens: 1_000_000_000,
      maxTaskCostUsd: 100,
      ...extra,
    })
  );
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

function write(dir: string, rel: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

function makeClient(handler: Handler, opts: { summarize?: boolean } = {}) {
  const events: Ev[] = [];
  const titles = new Map<string, string>();
  const counts = new Map<string, number>();
  let n = 0;
  const client = {
    session: {
      async create(req: { body: { title: string } }) {
        const id = `s-${++n}`;
        titles.set(id, req.body.title);
        events.push({ kind: "create", sessionId: id, title: req.body.title });
        return { data: { id } };
      },
      async prompt(req: { path: { id: string }; query: { directory: string }; body: { agent: string; parts: Array<{ text: string }> } }) {
        const title = titles.get(req.path.id) ?? "";
        const role = req.body.agent;
        const key = `${role}|${title}`;
        const nth = (counts.get(key) ?? 0) + 1;
        counts.set(key, nth);
        const ev: Ev = { kind: "prompt", sessionId: req.path.id, title, role, text: req.body.parts[0].text };
        events.push(ev);
        const r = await handler({ ev, dir: req.query.directory, nth, events });
        const text = typeof r === "string" ? r : r?.text ?? "ok";
        const input = typeof r === "object" && r?.input ? r.input : 10;
        return {
          data: {
            parts: [{ type: "text", text }],
            info: { cost: 0.001, tokens: { input, output: 5, cache: { read: 0 } } },
          },
        };
      },
      ...(opts.summarize
        ? {
            async summarize(req: { path: { id: string } }) {
              events.push({ kind: "summarize", sessionId: req.path.id, title: titles.get(req.path.id) ?? "" });
              return { data: true };
            },
          }
        : {}),
    },
  } as unknown as OpencodeClient;
  return { client, events };
}

/** Default behaviour: implementer writes src/a.ts; lenses CLEAN; bughunter finds nothing. */
function defaultReply(ctx: Ctx, implContent = "good"): string {
  const { ev, dir } = ctx;
  if (ev.role === "implementer") {
    write(dir, "src/a.ts", `export const v = "${implContent}";\n`);
    return "Implemented.";
  }
  if (ev.role === "reviewer") return "Fine.\nVERDICT: CLEAN";
  if (ev.role === "bughunter") {
    if (ev.title.includes("Hunter")) return "NO_HYPOTHESES\nVERDICT: CLEAN";
    return "VERDICT: CLEAN";
  }
  return "ok";
}

async function run(
  dir: string,
  client: OpencodeClient,
  extra: { skipTests?: boolean; skipReview?: boolean; skipBughunter?: boolean } = {}
) {
  const origLog = console.log;
  console.log = () => {};
  try {
    return await runPipeline({ repoDir: dir, task: "Add feature", openPr: false, client, ...extra });
  } finally {
    console.log = origLog;
  }
}

const implPrompts = (events: Ev[]) => events.filter((e) => e.kind === "prompt" && e.role === "implementer").map((e) => e.text ?? "");

// ---------------------------------------------------------------------------
// 3. verify failure after a review fix loops back to the implementer
// ---------------------------------------------------------------------------

test("pipeline: verify failure after a review fix loops back to the implementer instead of throwing", async () => {
  const dir = initRepo({ bughunter: false });
  try {
    const { client, events } = makeClient((ctx) => {
      const { ev, dir: d, nth } = ctx;
      if (ev.role === "reviewer" && ev.title.includes("Security") && nth === 1) return "Missing check.\nVERDICT: OPEN";
      if (ev.role === "implementer" && ev.text?.startsWith("Address these review findings")) {
        write(d, "src/a.ts", 'export const v = "bad";\n'); // breaks the verify gate
        return "Applied review fix.";
      }
      return defaultReply(ctx);
    });
    const result = await run(dir, client, { skipTests: true, skipBughunter: true });
    const prompts = implPrompts(events);
    const reviewFixIdx = prompts.findIndex((p) => p.startsWith("Address these review findings"));
    assert.ok(reviewFixIdx >= 0, "review fix prompt sent");
    assert.match(prompts[reviewFixIdx + 1] ?? "", /Verification command failed/, "verify failure is looped back to the implementer");
    assert.match(prompts[reviewFixIdx + 1] ?? "", /FAIL src\/a\.ts/);
    assert.equal(result.committed, true);
    assert.ok(result.reviewVerdicts.every((v) => v.verdict === "CLEAN"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. bughunter-only OPEN: round 2 re-runs Correctness + bughunter only
// ---------------------------------------------------------------------------

test("pipeline: round 2 re-reviews bughunter fixes with Correctness + bughunter only", async () => {
  const dir = initRepo();
  try {
    const { client, events } = makeClient((ctx) => {
      const { ev, nth } = ctx;
      if (ev.role === "bughunter") {
        if (ev.title.includes("Hunter")) return nth === 1 ? "BUG-1: cross-boundary issue in src/a.ts" : "NO_HYPOTHESES\nVERDICT: CLEAN";
        if (ev.title.includes("Skeptic")) return "Challenge: none.";
        return "VERDICT: OPEN";
      }
      return defaultReply(ctx);
    });
    await run(dir, client, { skipTests: true });

    const fixIdx = events.findIndex((e) => e.kind === "prompt" && e.role === "implementer" && e.text?.startsWith("Address these review findings"));
    assert.ok(fixIdx > 0, "implementer received the bughunter findings");
    const before = events.slice(0, fixIdx).filter((e) => e.kind === "create").map((e) => e.title);
    const after = events.slice(fixIdx).filter((e) => e.kind === "create").map((e) => e.title);

    for (const t of ["Review (Security)", "Review (Performance)", "Review (Correctness)", "Bughunter: Hunter"]) {
      assert.ok(before.includes(t), `round 1 ran ${t}`);
    }
    assert.ok(after.includes("Review (Correctness)"), "round 2 runs Correctness");
    assert.ok(after.includes("Bughunter: Hunter"), "round 2 re-runs the bughunter");
    assert.ok(!after.includes("Review (Security)"), "round 2 skips Security");
    assert.ok(!after.includes("Review (Performance)"), "round 2 skips Performance");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: lenses and bughunter run concurrently within a round", async () => {
  const dir = initRepo({ maxReviewRounds: 1 });
  try {
    let inFlight = 0;
    let maxInFlight = 0;
    const events: Ev[] = [];
    const titles = new Map<string, string>();
    let n = 0;
    const client = {
      session: {
        async create(req: { body: { title: string } }) {
          const id = `s-${++n}`;
          titles.set(id, req.body.title);
          return { data: { id } };
        },
        async prompt(req: { path: { id: string }; query: { directory: string }; body: { agent: string; parts: Array<{ text: string }> } }) {
          const title = titles.get(req.path.id) ?? "";
          const role = req.body.agent;
          events.push({ kind: "prompt", sessionId: req.path.id, title, role });
          let text = "ok";
          if (role === "implementer") write(req.query.directory, "src/a.ts", 'export const v = "good";\n');
          const slow = role === "reviewer" || (role === "bughunter" && title.includes("Hunter"));
          if (slow) {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 40));
            inFlight--;
            text = role === "reviewer" ? "Fine.\nVERDICT: CLEAN" : "NO_HYPOTHESES\nVERDICT: CLEAN";
          }
          return { data: { parts: [{ type: "text", text }], info: { cost: 0.001, tokens: { input: 1, output: 1, cache: { read: 0 } } } } };
        },
      },
    } as unknown as OpencodeClient;
    await run(dir, client, { skipTests: true });
    assert.ok(maxInFlight >= 4, `expected 3 lenses + hunter concurrently, saw ${maxInFlight}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. tester dispute
// ---------------------------------------------------------------------------

function disputeHandler(ruling: string, implContent: string) {
  return (ctx: Ctx) => {
    const { ev, dir } = ctx;
    if (ev.role === "implementer" && ev.text?.startsWith("Fix the root cause")) {
      write(dir, "src/a.ts", 'export const v = "good";\n');
      return "Fixed implementation.";
    }
    if (ev.role === "implementer") {
      write(dir, "src/a.ts", `export const v = "${implContent}";\n`);
      return "Implemented.";
    }
    if (ev.role === "tester" && ev.title.startsWith("Adversarial Tests") && ev.text?.startsWith(TEST_FIX_PROMPT)) {
      write(dir, "tests/feat.test.ts", "// fixed test\n");
      return "Test fixed.";
    }
    if (ev.role === "tester" && ev.title.startsWith("Adversarial Tests")) {
      write(dir, "tests/feat.test.ts", implContent === "good" && ruling === "TEST_BUG" ? "// wrong expectation\n" : "// ok test\n");
      return "Wrote tests.";
    }
    if (ev.role === "tester" && ev.title.startsWith("Test dispute")) return `Reasoning...\n${ruling}`;
    return defaultReply(ctx);
  };
}

test("pipeline: TEST_BUG ruling sends a fix prompt to the tester session, not the implementer", async () => {
  const dir = initRepo();
  try {
    const { client, events } = makeClient(disputeHandler("TEST_BUG", "good"));
    await run(dir, client, { skipReview: true });
    const dispute = events.find((e) => e.kind === "prompt" && e.title.startsWith("Test dispute"));
    assert.ok(dispute, "tester-role dispute prompt sent");
    assert.equal(dispute.role, "tester");
    assert.match(dispute.text ?? "", /tests\/feat\.test\.ts/);
    const testerSession = events.find((e) => e.kind === "create" && e.title.startsWith("Adversarial Tests"))!.sessionId;
    assert.notEqual(dispute.sessionId, testerSession, "dispute uses a fresh session");
    const fix = events.find((e) => e.kind === "prompt" && e.role === "tester" && e.text?.startsWith(TEST_FIX_PROMPT));
    assert.ok(fix, "tester fix prompt sent");
    assert.equal(fix.sessionId, testerSession, "fix goes to the original tester session");
    assert.equal(implPrompts(events).length, 1, "implementer was not asked to change anything");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: IMPL_BUG ruling sends the failure to the implementer and does not touch the tests", async () => {
  const dir = initRepo();
  try {
    // implementation initially lacks "good"; the failing output names the tester-owned file.
    const { client, events } = makeClient(disputeHandler("IMPL_BUG", "bad"));
    const result = await run(dir, client, { skipReview: true });
    const prompts = events.filter((e) => e.kind === "prompt");
    const dispute = prompts.find((e) => e.title.startsWith("Test dispute"));
    assert.ok(dispute, "dispute prompt sent");
    assert.equal(dispute.role, "tester");
    assert.ok(!prompts.some((e) => e.role === "tester" && e.text?.startsWith(TEST_FIX_PROMPT)), "no tester fix on IMPL_BUG");
    assert.ok(implPrompts(events).some((p) => p.startsWith("Fix the root cause")), "implementer gets a fix prompt");
    assert.equal(prompts.filter((e) => e.title.startsWith("Test dispute")).length, 1);
    assert.equal(result.committed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. compaction
// ---------------------------------------------------------------------------

test("pipeline: implementer session is compacted before the next prompt once input tokens pass the threshold", async () => {
  const dir = initRepo({ compactAfterTokens: 50, maxReviewRounds: 2, bughunter: false });
  try {
    const { client, events } = makeClient(
      (ctx) => {
        const { ev, nth } = ctx;
        if (ev.role === "reviewer" && ev.title.includes("Security") && nth === 1) return "Issue.\nVERDICT: OPEN";
        if (ev.role === "implementer") {
          write(ctx.dir, "src/a.ts", 'export const v = "good";\n');
          return { text: "Done.", input: 100 };
        }
        return defaultReply(ctx);
      },
      { summarize: true }
    );
    await run(dir, client, { skipTests: true, skipBughunter: true });
    const sumIdx = events.findIndex((e) => e.kind === "summarize");
    assert.ok(sumIdx >= 0, "summarize/compact called");
    const implSession = events.find((e) => e.kind === "create" && e.title.startsWith("Implement:"))!.sessionId;
    assert.equal(events[sumIdx].sessionId, implSession);
    const next = events.slice(sumIdx + 1).find((e) => e.kind === "prompt" && e.role === "implementer");
    assert.ok(next, "an implementer prompt follows the compaction");
    assert.ok(next.text?.startsWith("Context (session was compacted)"), next.text?.slice(0, 80));
    assert.match(next.text ?? "", /Add feature/, "task is re-stated");
    assert.match(next.text ?? "", /Address these review findings/);
    // nothing implementer-related between compaction and that prompt
    assert.ok(!events.slice(sumIdx + 1, events.indexOf(next)).some((e) => e.role === "implementer"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: compactAfterTokens 0 disables compaction", async () => {
  const dir = initRepo({ compactAfterTokens: 0, maxReviewRounds: 2, bughunter: false });
  try {
    const { client, events } = makeClient(
      (ctx) => {
        const { ev, nth } = ctx;
        if (ev.role === "reviewer" && ev.title.includes("Security") && nth === 1) return "Issue.\nVERDICT: OPEN";
        if (ev.role === "implementer") {
          write(ctx.dir, "src/a.ts", 'export const v = "good";\n');
          return { text: "Done.", input: 1_000_000 };
        }
        return defaultReply(ctx);
      },
      { summarize: true }
    );
    await run(dir, client, { skipTests: true, skipBughunter: true });
    assert.equal(events.filter((e) => e.kind === "summarize").length, 0);
    assert.ok(implPrompts(events).every((p) => !p.startsWith("Context (session was compacted)")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review-fix coverage
// ---------------------------------------------------------------------------

test("pipeline: files written by the dispute session are reverted, ruling still applied", async () => {
  const dir = initRepo();
  try {
    const base = disputeHandler("TEST_BUG", "good");
    const { client, events } = makeClient((ctx) => {
      if (ctx.ev.role === "tester" && ctx.ev.title.startsWith("Test dispute")) {
        write(ctx.dir, "src/dispute-note.ts", "export const sneaky = 1;\n");
        write(ctx.dir, "src/a.ts", 'export const v = "tampered";\n');
      }
      return base(ctx);
    });
    const result = await run(dir, client, { skipReview: true });
    assert.ok(!fs.existsSync(path.join(result.worktreeDir, "src/dispute-note.ts")), "new file removed");
    assert.match(fs.readFileSync(path.join(result.worktreeDir, "src/a.ts"), "utf8"), /good/, "edit restored");
    assert.ok(events.some((e) => e.kind === "prompt" && e.role === "tester" && e.text?.startsWith(TEST_FIX_PROMPT)), "ruling applied");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: tester fix may only change the disputed test files", async () => {
  const dir = initRepo();
  try {
    const base = disputeHandler("TEST_BUG", "good");
    const { client } = makeClient((ctx) => {
      if (ctx.ev.role === "tester" && ctx.ev.text?.startsWith(TEST_FIX_PROMPT)) {
        write(ctx.dir, "tests/other.test.ts", "// extra\n");
        write(ctx.dir, "src/extra.ts", "export const e = 1;\n");
      }
      return base(ctx);
    });
    const result = await run(dir, client, { skipReview: true });
    const wt = result.worktreeDir;
    assert.ok(!fs.existsSync(path.join(wt, "tests/other.test.ts")), "other test reverted");
    assert.ok(!fs.existsSync(path.join(wt, "src/extra.ts")), "prod edit reverted");
    assert.equal(fs.readFileSync(path.join(wt, "tests/feat.test.ts"), "utf8"), "// fixed test\n", "disputed file fix kept");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: a test dispute does not consume implementer attempts", async () => {
  const dir = initRepo({ maxFixRetries: 1 });
  try {
    const base = disputeHandler("TEST_BUG", "good");
    const { client, events } = makeClient((ctx) => {
      // the "fixed" test is still wrong, and the implementer cannot help
      if (ctx.ev.role === "tester" && ctx.ev.text?.startsWith(TEST_FIX_PROMPT)) {
        write(ctx.dir, "tests/feat.test.ts", "// still wrong\n");
        return "Tried.";
      }
      return base(ctx);
    });
    await assert.rejects(() => run(dir, client, { skipReview: true }), /Deterministic verify failed after 1 fix attempts/);
    const fixes = implPrompts(events).filter((p) => p.startsWith("Fix the root cause"));
    assert.equal(fixes.length, 1, "exactly one implementer fix prompt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: compaction uses the last implementer turn's input and restates instructions and task", async () => {
  const dir = initRepo({ compactAfterTokens: 50, maxReviewRounds: 2, bughunter: false });
  try {
    const { client, events } = makeClient(
      (ctx) => {
        const { ev, nth } = ctx;
        if (ev.role === "reviewer" && ev.title.includes("Security") && nth === 1) return "Issue.\nVERDICT: OPEN";
        if (ev.role === "implementer") {
          if (ev.text?.startsWith("Address these review findings") || ev.text?.includes("Address these review findings")) {
            write(ctx.dir, "src/a.ts", 'export const v = "bad";\n');
            return { text: "Applied.", input: 10 }; // small turn: cumulative input would still exceed the threshold
          }
          write(ctx.dir, "src/a.ts", 'export const v = "good";\n');
          return { text: "Done.", input: 100 };
        }
        return defaultReply(ctx);
      },
      { summarize: true }
    );
    await run(dir, client, { skipTests: true, skipBughunter: true });
    assert.equal(events.filter((e) => e.kind === "summarize").length, 1, "compacted once, not again after the small turn");
    const prompts = implPrompts(events);
    const restated = prompts.find((p) => p.startsWith("Context (session was compacted)"))!;
    assert.ok(restated.includes(IMPLEMENTER_STATIC_INSTRUCTIONS));
    assert.match(restated, /Instructions:/);
    assert.match(restated, /Task: Add feature/);
    const failFix = prompts.find((p) => p.startsWith("Fix the root cause"))!;
    assert.ok(failFix, "verify failure looped back");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: a rejecting lens does not leave the bughunter running in the background", async () => {
  const dir = initRepo({ maxReviewRounds: 1 });
  try {
    let hunterDone = false;
    const { client } = makeClient(async (ctx) => {
      const { ev } = ctx;
      if (ev.role === "reviewer" && ev.title.includes("Security")) throw new Error("lens exploded");
      if (ev.role === "bughunter" && ev.title.includes("Hunter")) {
        await new Promise((r) => setTimeout(r, 300));
        hunterDone = true;
        return "NO_HYPOTHESES\nVERDICT: CLEAN";
      }
      return defaultReply(ctx);
    });
    await assert.rejects(() => run(dir, client, { skipTests: true }), /lens exploded/);
    assert.equal(hunterDone, true, "bughunter settled before the error propagated");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
