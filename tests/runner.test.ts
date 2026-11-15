import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeArgs,
  buildOpencodeAgentConfig,
  buildOpencodeProviderConfig,
  classifyProviderError,
  computeBackoffMs,
  createOpencodeClientRunner,
  DEFAULT_CLAUDE_MODEL,
  isReadOnlyRole,
  normalizeProvider,
  parseClaudeJsonOutput,
  parseOpencodeModel,
  parseOpencodePromptResponse,
  READ_ONLY_OPENCODE_TOOLS,
  type OpencodeClient,
} from "../src/runner.ts";
import { DEFAULT_PROVIDERS, type RepoConfig } from "../src/config.ts";
import { resolveCloudflareGatewayUrl } from "../src/pipeline.ts";

// Hermetic pricing: never read the developer's real ~/.config/ai-ship/models.json.
const prevModelsFile = process.env.AI_SHIP_MODELS_FILE;
process.env.AI_SHIP_MODELS_FILE = path.join(os.tmpdir(), `ai-ship-no-models-${process.pid}.json`);
process.on("exit", () => {
  if (prevModelsFile === undefined) delete process.env.AI_SHIP_MODELS_FILE;
  else process.env.AI_SHIP_MODELS_FILE = prevModelsFile;
});


test("normalizeProvider defaults to opencode and accepts provider aliases", () => {
  assert.equal(normalizeProvider(undefined), "opencode");
  assert.equal(normalizeProvider("opencode"), "opencode");
  assert.equal(normalizeProvider("deepseek"), "opencode");
  assert.equal(normalizeProvider("parasail"), "opencode");
  assert.equal(normalizeProvider("telnyx"), "opencode");
  assert.equal(normalizeProvider("openrouter"), "opencode");
  assert.equal(normalizeProvider("cloudflare"), "opencode");
  assert.equal(normalizeProvider("claude-code"), "claude-code");
  assert.throws(() => normalizeProvider("unknown-provider"), /Unknown provider/);
});

test("parseOpencodeModel splits provider/model and uses configurable default provider", () => {
  assert.equal(parseOpencodeModel(undefined), undefined);
  assert.deepEqual(parseOpencodeModel("anthropic/claude-sonnet-4.5"), {
    providerID: "anthropic",
    modelID: "claude-sonnet-4.5",
  });
  assert.deepEqual(parseOpencodeModel("parasail/Qwen/Qwen2.5-Coder-32B-Instruct"), {
    providerID: "parasail",
    modelID: "Qwen/Qwen2.5-Coder-32B-Instruct",
  });
  assert.deepEqual(parseOpencodeModel("deepseek-chat"), {
    providerID: "deepseek",
    modelID: "deepseek-chat",
  });
  assert.deepEqual(parseOpencodeModel("my-model", "parasail"), {
    providerID: "parasail",
    modelID: "my-model",
  });
});

test("buildClaudeArgs configures read-only tools for reviewer and bughunter and resume for follow-ups", () => {
  assert.deepEqual(
    buildClaudeArgs({ model: DEFAULT_CLAUDE_MODEL, role: "implementer" }),
    ["-p", "--output-format", "json", "--model", "sonnet", "--dangerously-skip-permissions"]
  );

  assert.deepEqual(
    buildClaudeArgs({ model: DEFAULT_CLAUDE_MODEL, role: "tester" }),
    ["-p", "--output-format", "json", "--model", "sonnet", "--dangerously-skip-permissions"]
  );

  assert.deepEqual(
    buildClaudeArgs({ model: "sonnet", role: "reviewer", resumeSessionId: "sess-123" }),
    [
      "-p",
      "--output-format",
      "json",
      "--model",
      "sonnet",
      "--dangerously-skip-permissions",
      "--tools",
      "Read,Glob,Grep",
      "--resume",
      "sess-123",
    ]
  );

  assert.deepEqual(
    buildClaudeArgs({ model: "sonnet", role: "bughunter" }),
    [
      "-p",
      "--output-format",
      "json",
      "--model",
      "sonnet",
      "--dangerously-skip-permissions",
      "--tools",
      "Read,Glob,Grep",
    ]
  );
});

test("OpenCode runner enforces read-only tool permissions for reviewer and bughunter", async () => {
  assert.equal(isReadOnlyRole("implementer"), false);
  assert.equal(isReadOnlyRole("tester"), false);
  assert.equal(isReadOnlyRole("reviewer"), true);
  assert.equal(isReadOnlyRole("bughunter"), true);

  const agentCfg = buildOpencodeAgentConfig();
  assert.deepEqual(agentCfg.reviewer.tools, READ_ONLY_OPENCODE_TOOLS);
  assert.deepEqual(agentCfg.bughunter.tools, READ_ONLY_OPENCODE_TOOLS);
  assert.equal(agentCfg.reviewer.permission.edit, "deny");
  assert.equal(agentCfg.bughunter.permission.bash, "deny");

  const capturedBodies: Array<{ agent?: string; tools?: Record<string, boolean> }> = [];
  const fakeClient = {
    session: {
      async create() {
        return { data: { id: "sess-ro" } };
      },
      async prompt(input: { body: { agent?: string; tools?: Record<string, boolean> } }) {
        capturedBodies.push(input.body);
        return {
          data: {
            parts: [{ type: "text", text: "ok" }],
            info: { cost: 0.001, tokens: { input: 10, output: 5 } },
          },
        };
      },
    },
  } as unknown as OpencodeClient;

  const runner = createOpencodeClientRunner({
    client: fakeClient,
    worktreeDir: "/tmp/repo",
    config: {
      baseBranch: "main",
      verify: [],
      testCommand: null,
      maxFixRetries: 1,
      maxReviewRounds: 1,
      securityScan: false,
      safetyCheck: false,
      bughunterModel: { providerID: "deepseek", id: "deepseek-reasoner" },
    },
  });

  await runner.prompt("sess-ro", "implementer", "write code");
  await runner.prompt("sess-ro", "tester", "write tests");
  await runner.prompt("sess-ro", "reviewer", "review code");
  await runner.prompt("sess-ro", "bughunter", "hunt bugs");

  assert.equal(capturedBodies[0].tools, undefined);
  assert.equal(capturedBodies[1].tools, undefined);
  assert.deepEqual(capturedBodies[2].tools, READ_ONLY_OPENCODE_TOOLS);
  assert.deepEqual(capturedBodies[3].tools, READ_ONLY_OPENCODE_TOOLS);
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

test("resolveCloudflareGatewayUrl supports bare gateway URLs and per-provider suffixes", () => {
  const prevUrl = process.env.CF_AI_GATEWAY_URL;
  const prevAcct = process.env.CF_ACCOUNT_ID;
  const prevGw = process.env.CF_GATEWAY_ID;
  const prevProv = process.env.CF_GATEWAY_PROVIDER;
  try {
    delete process.env.CF_AI_GATEWAY_URL;
    delete process.env.CF_GATEWAY_PROVIDER;
    process.env.CF_ACCOUNT_ID = "acct123";
    process.env.CF_GATEWAY_ID = "gw456";
    assert.equal(
      resolveCloudflareGatewayUrl(),
      "https://gateway.ai.cloudflare.com/v1/acct123/gw456"
    );
    assert.equal(
      resolveCloudflareGatewayUrl("deepseek"),
      "https://gateway.ai.cloudflare.com/v1/acct123/gw456/deepseek"
    );

    process.env.CF_GATEWAY_PROVIDER = "compat";
    assert.equal(
      resolveCloudflareGatewayUrl(),
      "https://gateway.ai.cloudflare.com/v1/acct123/gw456/compat"
    );

    process.env.CF_AI_GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1/acct123/gw456/";
    assert.equal(
      resolveCloudflareGatewayUrl(),
      "https://gateway.ai.cloudflare.com/v1/acct123/gw456"
    );
    assert.equal(
      resolveCloudflareGatewayUrl("deepseek"),
      "https://gateway.ai.cloudflare.com/v1/acct123/gw456/deepseek"
    );
  } finally {
    if (prevUrl === undefined) delete process.env.CF_AI_GATEWAY_URL;
    else process.env.CF_AI_GATEWAY_URL = prevUrl;
    if (prevAcct === undefined) delete process.env.CF_ACCOUNT_ID;
    else process.env.CF_ACCOUNT_ID = prevAcct;
    if (prevGw === undefined) delete process.env.CF_GATEWAY_ID;
    else process.env.CF_GATEWAY_ID = prevGw;
    if (prevProv === undefined) delete process.env.CF_GATEWAY_PROVIDER;
    else process.env.CF_GATEWAY_PROVIDER = prevProv;
  }
});

test("buildOpencodeProviderConfig configures DeepSeek Direct, Parasail.io, and Cloudflare gateway routing", () => {
  const baseCfg: RepoConfig = {
    baseBranch: "main",
    verify: [],
    testCommand: null,
    providers: DEFAULT_PROVIDERS,
    defaultProvider: "deepseek",
    maxFixRetries: 3,
    maxReviewRounds: 2,
    securityScan: true,
    safetyCheck: true,
  };

  const direct = buildOpencodeProviderConfig(baseCfg);
  assert.equal((direct?.deepseek?.options as Record<string, unknown>)?.baseURL, "https://api.deepseek.com/v1");
  assert.equal((direct?.parasail?.options as Record<string, unknown>)?.baseURL, "https://api.parasail.io/v1");

  const viaBareCf = buildOpencodeProviderConfig(
    baseCfg,
    "https://gateway.ai.cloudflare.com/v1/acct123/gw456"
  );
  assert.equal(
    (viaBareCf?.deepseek?.options as Record<string, unknown>)?.baseURL,
    "https://gateway.ai.cloudflare.com/v1/acct123/gw456/deepseek"
  );
  assert.equal(
    (viaBareCf?.parasail?.options as Record<string, unknown>)?.baseURL,
    "https://api.parasail.io/v1"
  );

  const viaContextLens = buildOpencodeProviderConfig(
    baseCfg,
    undefined,
    "http://localhost:4040/"
  );
  // Context Lens routes only the default provider; others keep their own URLs.
  assert.equal(
    (viaContextLens?.deepseek?.options as Record<string, unknown>)?.baseURL,
    "http://localhost:4040"
  );
  assert.equal(
    (viaContextLens?.parasail?.options as Record<string, unknown>)?.baseURL,
    "https://api.parasail.io/v1"
  );
});


test("classifyProviderError identifies transient 429 and 5xx errors vs non-transient 4xx", () => {
  assert.equal(classifyProviderError({ statusCode: 429 }).transient, true);
  assert.equal(classifyProviderError({ data: { statusCode: 503 } }).transient, true);
  assert.equal(classifyProviderError(new Error("OpenCode implementer failed: APIError HTTP 429: Too Many Requests")).transient, true);
  assert.equal(classifyProviderError(new Error("OpenCode reviewer failed: APIError HTTP 502: Bad Gateway")).transient, true);
  assert.equal(classifyProviderError(new Error("Rate limit exceeded")).transient, true);

  assert.equal(classifyProviderError({ statusCode: 400 }).transient, false);
  assert.equal(classifyProviderError(new Error("OpenCode implementer failed: APIError HTTP 404: Not Found")).transient, false);
});

test("computeBackoffMs applies bounded exponential backoff with jitter", () => {
  const low0 = computeBackoffMs(0, { baseDelayMs: 1000, maxDelayMs: 5000, random: () => 0 });
  const high0 = computeBackoffMs(0, { baseDelayMs: 1000, maxDelayMs: 5000, random: () => 1 });
  assert.equal(low0, 500);
  assert.equal(high0, 1000);

  const high2 = computeBackoffMs(2, { baseDelayMs: 1000, maxDelayMs: 5000, random: () => 1 });
  assert.equal(high2, 4000);

  const capped = computeBackoffMs(5, { baseDelayMs: 1000, maxDelayMs: 5000, random: () => 1 });
  assert.equal(capped, 5000);
});

function makeMockClient(
  handler: (model?: { providerID: string; modelID: string }) => Promise<unknown>
): OpencodeClient {
  return {
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      prompt: async (args: { body?: { model?: { providerID: string; modelID: string } } }) =>
        handler(args.body?.model),
    },
  } as unknown as OpencodeClient;
}

test("createOpencodeClientRunner performs 0ms immediate failover to per-role fallbackModel on 429/5xx", async () => {
  const calls: Array<{ providerID: string; modelID: string } | undefined> = [];
  const sleeps: number[] = [];

  const client = makeMockClient(async (model) => {
    calls.push(model);
    if (model?.providerID === "deepseek") {
      return {
        data: {
          parts: [],
          info: { error: { name: "APIError", data: { statusCode: 429, message: "Rate limit" } } },
        },
      };
    }
    return {
      data: {
        parts: [{ type: "text", text: "ok from parasail" }],
        info: { cost: 0.001, tokens: { input: 10, output: 5 } },
      },
    };
  });

  const config: RepoConfig = {
    baseBranch: "main",
    verify: [],
    testCommand: null,
    implementerModel: { providerID: "deepseek", id: "deepseek-chat" },
    implementerFallbackModel: { providerID: "parasail", id: "Qwen/Qwen2.5-Coder-32B-Instruct" },
    testerModel: { providerID: "parasail", id: "Qwen/Qwen2.5-Coder-32B-Instruct" },
    testerFallbackModel: { providerID: "deepseek", id: "deepseek-chat" },
    reviewerModel: { providerID: "deepseek", id: "deepseek-reasoner" },
    reviewerFallbackModel: { providerID: "parasail", id: "Qwen/Qwen2.5-Coder-32B-Instruct" },
    bughunterModel: { providerID: "deepseek", id: "deepseek-chat" },
    bughunterFallbackModel: { providerID: "parasail", id: "Qwen/Qwen2.5-Coder-32B-Instruct" },
    maxFixRetries: 3,
    maxReviewRounds: 2,
    securityScan: true,
    safetyCheck: true,
  };

  const runner = createOpencodeClientRunner({
    client,
    worktreeDir: "/tmp/wt",
    config,
    retry: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    },
  });

  const implRes = await runner.prompt("sess-1", "implementer", "build feature");
  assert.equal(implRes.text, "ok from parasail");
  assert.equal(sleeps.length, 0);
  assert.deepEqual(calls, [
    { providerID: "deepseek", modelID: "deepseek-chat" },
    { providerID: "parasail", modelID: "Qwen/Qwen2.5-Coder-32B-Instruct" },
  ]);
  assert.deepEqual(implRes.fallback, {
    role: "implementer",
    from: "deepseek/deepseek-chat",
    to: "parasail/Qwen/Qwen2.5-Coder-32B-Instruct",
    reason: "HTTP 429",
  });

  calls.length = 0;
  const bhRes = await runner.prompt("sess-1", "bughunter", "hunt bugs");
  assert.equal(bhRes.text, "ok from parasail");
  assert.equal(sleeps.length, 0);
  assert.equal(bhRes.fallback?.role, "bughunter");
});

test("createOpencodeClientRunner retries with bounded backoff when no fallback or both fail, and aborts on non-transient errors", async () => {
  const sleeps: number[] = [];
  let attempts = 0;

  const recoveringClient = makeMockClient(async () => {
    attempts++;
    if (attempts < 3) {
      return {
        data: {
          parts: [],
          info: { error: { name: "APIError", data: { statusCode: 503, message: "Service Unavailable" } } },
        },
      };
    }
    return {
      data: {
        parts: [{ type: "text", text: "recovered" }],
        info: { tokens: { input: 5, output: 5 } },
      },
    };
  });

  const baseConfig: RepoConfig = {
    baseBranch: "main",
    verify: [],
    testCommand: null,
    implementerModel: { providerID: "deepseek", id: "deepseek-chat" },
    maxFixRetries: 3,
    maxReviewRounds: 2,
    securityScan: true,
    safetyCheck: true,
  };

  const runner1 = createOpencodeClientRunner({
    client: recoveringClient,
    worktreeDir: "/tmp/wt",
    config: baseConfig,
    retry: {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 300,
      random: () => 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  });

  const res = await runner1.prompt("sess-1", "implementer", "hi");
  assert.equal(res.text, "recovered");
  assert.deepEqual(sleeps, [100, 200]);

  // Both primary and fallback failing transiently exhausts maxRetries and throws
  const bothFailSleeps: number[] = [];
  let bothFailCalls = 0;
  const bothFailClient = makeMockClient(async () => {
    bothFailCalls++;
    return {
      data: {
        parts: [],
        info: { error: { name: "APIError", data: { statusCode: 429, message: "Too Many Requests" } } },
      },
    };
  });

  const runner2 = createOpencodeClientRunner({
    client: bothFailClient,
    worktreeDir: "/tmp/wt",
    config: {
      ...baseConfig,
      implementerFallbackModel: { providerID: "parasail", id: "Qwen/Qwen2.5-Coder-32B-Instruct" },
    },
    retry: {
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 250,
      random: () => 1,
      sleep: async (ms) => {
        bothFailSleeps.push(ms);
      },
    },
  });

  await assert.rejects(() => runner2.prompt("sess-1", "implementer", "hi"), /HTTP 429/);
  assert.equal(bothFailCalls, 6); // 3 rounds x (primary + 0ms fallback)
  assert.deepEqual(bothFailSleeps, [100, 200]);

  // Non-transient 400 fails immediately with 0 retries and 0 fallback
  let nonTransientCalls = 0;
  const nonTransientClient = makeMockClient(async () => {
    nonTransientCalls++;
    return {
      data: {
        parts: [],
        info: { error: { name: "APIError", data: { statusCode: 400, message: "Bad Request" } } },
      },
    };
  });

  const runner3 = createOpencodeClientRunner({
    client: nonTransientClient,
    worktreeDir: "/tmp/wt",
    config: {
      ...baseConfig,
      implementerFallbackModel: { providerID: "parasail", id: "Qwen/Qwen2.5-Coder-32B-Instruct" },
    },
  });

  await assert.rejects(() => runner3.prompt("sess-1", "implementer", "hi"), /HTTP 400/);
  assert.equal(nonTransientCalls, 1);
});
