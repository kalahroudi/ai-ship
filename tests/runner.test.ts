import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeArgs,
  DEFAULT_CLAUDE_MODEL,
  normalizeProvider,
  parseClaudeJsonOutput,
  parseOpencodeModel,
} from "../src/runner.ts";

test("normalizeProvider defaults to opencode and accepts aliases", () => {
  assert.equal(normalizeProvider(undefined), "opencode");
  assert.equal(normalizeProvider("opencode"), "opencode");
  assert.equal(normalizeProvider("openrouter"), "opencode");
  assert.equal(normalizeProvider("cloudflare"), "opencode");
  assert.equal(normalizeProvider("claude-code"), "claude-code");
  assert.throws(() => normalizeProvider("unknown-provider"), /Unknown provider/);
});

test("parseOpencodeModel splits provider/model or defaults to openrouter", () => {
  assert.equal(parseOpencodeModel(undefined), undefined);
  assert.deepEqual(parseOpencodeModel("anthropic/claude-sonnet-4.5"), {
    providerID: "anthropic",
    modelID: "claude-sonnet-4.5",
  });
  assert.deepEqual(parseOpencodeModel("sonnet-5-5"), {
    providerID: "openrouter",
    modelID: "sonnet-5-5",
  });
});

test("buildClaudeArgs configures read-only tools for reviewer and resume for follow-ups", () => {
  assert.deepEqual(
    buildClaudeArgs({ model: DEFAULT_CLAUDE_MODEL, role: "implementer" }),
    ["-p", "--output-format", "json", "--model", "sonnet-5-5", "--dangerously-skip-permissions"]
  );

  assert.deepEqual(
    buildClaudeArgs({ model: "sonnet-5-5", role: "reviewer", resumeSessionId: "sess-123" }),
    [
      "-p",
      "--output-format",
      "json",
      "--model",
      "sonnet-5-5",
      "--dangerously-skip-permissions",
      "--tools",
      "Read,Glob,Grep",
      "--resume",
      "sess-123",
    ]
  );
});

test("parseClaudeJsonOutput extracts result, session_id, and usage", () => {
  const sample = JSON.stringify({
    type: "result",
    is_error: false,
    result: "VERDICT: CLEAN",
    session_id: "abc-123",
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 100,
      output_tokens: 25,
      cache_read_input_tokens: 40,
    },
  });

  const parsed = parseClaudeJsonOutput(sample);
  assert.equal(parsed.text, "VERDICT: CLEAN");
  assert.equal(parsed.sessionId, "abc-123");
  assert.equal(parsed.usageSummary, "in=100 out=25 cache_read=40 | $0.0123");
});

test("parseClaudeJsonOutput throws on error payload", () => {
  const errPayload = JSON.stringify({
    type: "result",
    is_error: true,
    result: "Invalid model",
  });
  assert.throws(() => parseClaudeJsonOutput(errPayload), /Invalid model/);
});
