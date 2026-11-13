import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleMcpRequest, MCP_TOOLS, type McpToolDeps } from "../src/mcp.ts";

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
});

test("handleMcpRequest executes ship_task with inline flags and noty resolution", async () => {
  const calls: any[] = [];
  const fakeDeps = {
    resolveShipTaskInput: () => ({
      task: "Fix auth bug",
      openPr: true,
      skipTests: true,
      skipReview: false,
      title: "Auth bug",
    }),
    runPipeline: async (opts: any) => {
      calls.push(opts);
    },
  } as unknown as McpToolDeps;

  const resp = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "ship_task",
        arguments: { task: "noty://item/123 --pr --skip-tests", repoDir: "/tmp/my-repo", provider: "claude-code" },
      },
    },
    fakeDeps
  );

  assert.equal(resp?.result.isError, undefined);
  assert.match(resp?.result.content[0].text, /Auth bug/);
  assert.deepEqual(calls[0], {
    repoDir: "/tmp/my-repo",
    task: "Fix auth bug",
    openPr: true,
    skipTests: true,
    skipReview: false,
    provider: "claude-code",
    model: undefined,
  });
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
  assert.match(errResp?.result.content[0].text, /Unknown tool/);
});
