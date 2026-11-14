import test from "node:test";
import assert from "node:assert/strict";
import { formatOpenReviewFindings, formatPipelineResult } from "../src/pipeline.ts";
import { resolveShipTaskInput } from "../plugin/index.ts";

test("formatOpenReviewFindings formats each open lens into a markdown section", () => {
  const formatted = formatOpenReviewFindings([
    { lens: "Security", text: "Missing tenant check on line 42.\nVERDICT: OPEN" },
    { lens: "Correctness", text: "Audit event not emitted.\nVERDICT: OPEN" },
  ]);

  assert.equal(
    formatted,
    [
      "### Security Review",
      "Missing tenant check on line 42.",
      "VERDICT: OPEN",
      "",
      "### Correctness Review",
      "Audit event not emitted.",
      "VERDICT: OPEN",
    ].join("\n")
  );
});

test("formatPipelineResult includes diffStat and implSummary even when openPr is false", () => {
  const out = formatPipelineResult(
    {
      repoDir: "/tmp/repo",
      worktreeDir: "/tmp/repo/.ai-ship-worktrees/m2",
      branch: "ai/m2",
      baseBranch: "main",
      provider: "claude-code",
      committed: true,
      diffStat: " src/auth.ts | 12 +++++++++---\n 1 file changed, 9 insertions(+), 3 deletions(-)",
      implSummary: "Added break-glass audit logging.",
      verifyCommands: ["pnpm test"],
      reviewVerdicts: [{ lens: "Security", verdict: "CLEAN" }],
      usageLog: [],
    },
    "M2",
    false
  );

  assert.match(out, /PR: \(not requested\)/);
  assert.match(out, /- Changed files:\n```text\nsrc\/auth\.ts \| 12 \+\+\+\+\+\+\+\+\+---/);
  assert.match(out, /- Implementation summary:\nAdded break-glass audit logging\./);
});

test("resolveShipTaskInput parses --draft and --worktree flags", () => {
  const res = resolveShipTaskInput("Add UI --draft --worktree /tmp/wt");
  assert.equal(res.task, "Add UI");
  assert.equal(res.openPr, true);
  assert.equal(res.draft, true);
  assert.equal(res.worktreeDir, "/tmp/wt");
});
