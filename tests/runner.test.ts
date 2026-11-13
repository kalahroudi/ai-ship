import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeArgs,
  DEFAULT_CLAUDE_MODEL,
  normalizeProvider,
  parseClaudeJsonOutput,
  parseOpencodeModel,
  parseOpencodePromptResponse,
} from "../src/runner.ts";
import { resolveCloudflareGatewayUrl } from "../src/pipeline.ts";

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

test("parseOpencodePromptResponse extracts text and usage on success", () => {
  const res = parseOpencodePromptResponse(
    {
      data: {
        parts: [{ type: "text", text: "VERDICT: CLEAN" }],
        info: {
          cost: 0.025,
          tokens: { input: 200, output: 50, cache: { read: 10 } },
        },
      },
    },
    "reviewer"
  );
  assert.equal(res.text, "VERDICT: CLEAN");
  assert.equal(res.usageSummary, "in=200 out=50 cache_read=10 | $0.0250");
});

test("parseOpencodePromptResponse throws on transport error, assistant error, or empty data", () => {
  assert.throws(
    () => parseOpencodePromptResponse({ error: new Error("ECONNREFUSED") }, "implementer"),
    /OpenCode implementer request failed: ECONNREFUSED/
  );
  assert.throws(
    () =>
      parseOpencodePromptResponse(
        {
          data: {
            parts: [],
            info: {
              error: {
                name: "APIError",
                data: { statusCode: 404, message: "Not Found" },
              },
            },
          },
        },
        "implementer"
      ),
    /OpenCode implementer failed: APIError HTTP 404: Not Found/
  );
  assert.throws(
    () => parseOpencodePromptResponse({}, "tester"),
    /OpenCode tester returned an empty response/
  );
});

test("resolveCloudflareGatewayUrl uses gateway.ai.cloudflare.com", () => {
  const prevUrl = process.env.CF_AI_GATEWAY_URL;
  const prevAcct = process.env.CF_ACCOUNT_ID;
  const prevGw = process.env.CF_GATEWAY_ID;
  try {
    delete process.env.CF_AI_GATEWAY_URL;
    process.env.CF_ACCOUNT_ID = "acct123";
    process.env.CF_GATEWAY_ID = "gw456";
    assert.equal(
      resolveCloudflareGatewayUrl(),
      "https://gateway.ai.cloudflare.com/v1/acct123/gw456/openrouter"
    );
  } finally {
    if (prevUrl === undefined) delete process.env.CF_AI_GATEWAY_URL;
    else process.env.CF_AI_GATEWAY_URL = prevUrl;
    if (prevAcct === undefined) delete process.env.CF_ACCOUNT_ID;
    else process.env.CF_ACCOUNT_ID = prevAcct;
    if (prevGw === undefined) delete process.env.CF_GATEWAY_ID;
    else process.env.CF_GATEWAY_ID = prevGw;
  }
});
