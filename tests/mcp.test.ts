import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  handleMcpRequest,
  hasOpencodeProviderAuth,
  MCP_TOOLS,
  resolveMcpProvider,
  type McpToolDeps,
} from "../src/mcp.ts";
import { buildPrBody } from "../src/pipeline.ts";

// Hermetic pricing: never read the developer's real ~/.config/ai-ship/models.json.
const prevModelsFile = process.env.AI_SHIP_MODELS_FILE;
process.env.AI_SHIP_MODELS_FILE = path.join(os.tmpdir(), `ai-ship-no-models-${process.pid}.json`);
process.on("exit", () => {
  if (prevModelsFile === undefined) delete process.env.AI_SHIP_MODELS_FILE;
  else process.env.AI_SHIP_MODELS_FILE = prevModelsFile;
});


test("handleMcpRequest handles initialize, notifications, ping, and tools/list", async () => {
  const initResp = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  });
  assert.equal(initResp?.id, 1);
  assert.equal(initResp?.result.protocolVersion, "2025-03-26");
  assert.equal(initResp?.result.serverInfo.name, "ai-ship");

  const notifResp = await handleMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notifResp, null);

  const pingResp = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert.deepEqual(pingResp?.result, {});

  const listResp = await handleMcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal(listResp?.result.tools.length, MCP_TOOLS.length);
  assert.ok(listResp?.result.tools.some((t: any) => t.name === "ship_task"));
  assert.ok(listResp?.result.tools.some((t: any) => t.name === "open_pr"));
});

test("handleMcpRequest executes ship_task with inline flags, noty resolution, and progress notifications", async () => {
  const calls: any[] = [];
  const notifications: any[] = [];
  const fakeDeps = {
    resolveShipTaskInput: () => ({
      task: "Fix auth bug",
      openPr: true,
      skipTests: true,
      skipReview: false,
      title: "Auth bug",
    }),
    runPipeline: async (opts: any) => {
      opts.onProgress?.("Stage 1/4: Implementing");
      calls.push(opts);
    },
    notify: (n: any) => notifications.push(n),
  } as unknown as McpToolDeps;

  const resp = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "ship_task",
        arguments: { task: "noty://item/123 --pr --skip-tests", repoDir: "/tmp/my-repo", provider: "claude-code" },
        _meta: { progressToken: "tok-1" },
      },
    },
    fakeDeps
  );

  assert.equal(resp?.result.isError, undefined);
  assert.match(resp?.result.content[0].text, /Auth bug/);
  assert.equal(typeof calls[0].onProgress, "function");
  assert.deepEqual(
    { ...calls[0], onProgress: undefined },
    {
      repoDir: "/tmp/my-repo",
      task: "Fix auth bug",
      openPr: true,
      skipTests: true,
      skipReview: false,
      provider: "claude-code",
      model: undefined,
      onProgress: undefined,
    }
  );
  assert.ok(notifications.some((n) => n.method === "notifications/message" && n.params.data === "Stage 1/4: Implementing"));
  assert.ok(notifications.some((n) => n.method === "notifications/progress" && n.params.progressToken === "tok-1"));
});

test("handleMcpRequest handles memory_save, memory_forget, and unknown tools", async () => {
  const saved: any[] = [];
  const forgotten: any[] = [];
  const fakeDeps = {
    appendMemory: (repoDir: string, entry: string, category: string) => {
      saved.push({ repoDir, entry, category });
      return { added: true, path: "/tmp/memory.md" };
    },
    forgetMemory: (repoDir: string, query: string) => {
      forgotten.push({ repoDir, query });
      return { removedCount: 1, path: "/tmp/memory.md" };
    },
  } as unknown as McpToolDeps;

  const saveResp = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "memory_save",
        arguments: { entry: "Always use strict mode", category: "ts", repoDir: "/tmp/my-repo" },
      },
    },
    fakeDeps
  );
  assert.equal(saveResp?.result.isError, undefined);
  assert.match(saveResp?.result.content[0].text, /Saved to repo memory/);
  assert.deepEqual(saved[0], { repoDir: "/tmp/my-repo", entry: "Always use strict mode", category: "ts" });

  const forgetResp = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "memory_forget",
        arguments: { query: "strict mode", repoDir: "/tmp/my-repo" },
      },
    },
    fakeDeps
  );
  assert.equal(forgetResp?.result.isError, undefined);
  assert.match(forgetResp?.result.content[0].text, /Removed 1 matching/);
  assert.deepEqual(forgotten[0], { repoDir: "/tmp/my-repo", query: "strict mode" });

  const errResp = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    },
    fakeDeps
  );
  assert.equal(errResp?.result.isError, true);
  assert.match(errResp?.result.content[0].text, /ai-ship \(nonexistent_tool\) failed: Unknown tool/);
});

test("buildPrBody includes task summary, implementation notes, diff stat, verify, and review verdicts", () => {
  const body = buildPrBody({
    task: "Move contacts import payload out of control D1 DB",
    provider: "claude-code",
    implSummary: "Moved import payload to R2 and cleared D1 column on completion.",
    diffStat: " src/import.ts | 24 ++++++++++++------------\n 1 file changed, 12 insertions(+), 12 deletions(-)",
    verifyCommands: ["pnpm verify"],
    adversarialTestsRan: true,
    reviewVerdicts: [
      { lens: "Security", verdict: "CLEAN" },
      { lens: "Performance", verdict: "CLEAN" },
      { lens: "Correctness", verdict: "CLEAN" },
    ],
  });

  assert.match(body, /## Summary/);
  assert.match(body, /### Implementation Notes/);
  assert.match(body, /## Changed Files/);
  assert.match(body, /pnpm verify/);
  assert.match(body, /Independent adversarial tests \(Stage 2\)/);
  assert.match(body, /\*\*Security:\*\* CLEAN/);
});

test("resolveMcpProvider keeps opencode when non-OpenRouter providers are configured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-mcp-auth-"));
  const missingAuth = path.join(dir, "missing-auth.json");
  const missingCfg = path.join(dir, "missing-opencode.json");

  try {
    // 1. No env, no files, claude CLI available -> falls back to claude-code
    assert.equal(
      hasOpencodeProviderAuth({ authPath: missingAuth, opencodeConfigPath: missingCfg, env: {} }),
      false
    );
    assert.equal(
      resolveMcpProvider(undefined, {
        authPath: missingAuth,
        opencodeConfigPath: missingCfg,
        env: {},
        hasClaude: () => true,
      }),
      "claude-code"
    );

    // 2. DEEPSEEK_API_KEY or PARASAIL_API_KEY in env -> stays on opencode
    assert.equal(
      resolveMcpProvider(undefined, {
        authPath: missingAuth,
        opencodeConfigPath: missingCfg,
        env: { DEEPSEEK_API_KEY: "sk-ds-test" },
        hasClaude: () => true,
      }),
      "opencode"
    );
    assert.equal(
      resolveMcpProvider(undefined, {
        authPath: missingAuth,
        opencodeConfigPath: missingCfg,
        env: { PARASAIL_API_KEY: "sk-ps-test" },
        hasClaude: () => true,
      }),
      "opencode"
    );

    // 3. Non-OpenRouter entry in auth.json -> stays on opencode
    const authPath = path.join(dir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({ deepseek: { type: "api", key: "test" } }));
    assert.equal(
      resolveMcpProvider(undefined, {
        authPath,
        opencodeConfigPath: missingCfg,
        env: {},
        hasClaude: () => true,
      }),
      "opencode"
    );

    // 4. Provider configured in opencode.json -> stays on opencode
    const opencodeConfigPath = path.join(dir, "opencode.json");
    fs.writeFileSync(
      opencodeConfigPath,
      JSON.stringify({ provider: { parasail: { options: { baseURL: "https://api.parasail.io/v1" } } } })
    );
    assert.equal(
      resolveMcpProvider(undefined, {
        authPath: missingAuth,
        opencodeConfigPath,
        env: {},
        hasClaude: () => true,
      }),
      "opencode"
    );

    // 5. Provider configured in repo .ai-ship.json -> stays on opencode
    const repoDir = path.join(dir, "repo");
    fs.mkdirSync(repoDir);
    fs.writeFileSync(
      path.join(repoDir, ".ai-ship.json"),
      JSON.stringify({ providers: { deepseek: { baseURL: "https://api.deepseek.com/v1" } } })
    );
    assert.equal(
      resolveMcpProvider(undefined, {
        repoDir,
        authPath: missingAuth,
        opencodeConfigPath: missingCfg,
        env: {},
        hasClaude: () => true,
      }),
      "opencode"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
