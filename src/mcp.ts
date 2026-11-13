import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { resolveShipTaskInput } from "../plugin/index.ts";
import { listCleanupTargets, removeCleanupTargets } from "./git.ts";
import { appendMemory, forgetMemory } from "./memory.ts";
import { runDreamConsolidation, runPipeline } from "./pipeline.ts";
import { normalizeProvider, type ProviderName } from "./runner.ts";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export interface McpToolDeps {
  runPipeline: typeof runPipeline;
  runDreamConsolidation: typeof runDreamConsolidation;
  resolveShipTaskInput: typeof resolveShipTaskInput;
  appendMemory: typeof appendMemory;
  forgetMemory: typeof forgetMemory;
  listCleanupTargets: typeof listCleanupTargets;
  removeCleanupTargets: typeof removeCleanupTargets;
}

const DEFAULT_DEPS: McpToolDeps = {
  runPipeline,
  runDreamConsolidation,
  resolveShipTaskInput,
  appendMemory,
  forgetMemory,
  listCleanupTargets,
  removeCleanupTargets,
};

export const MCP_TOOLS = [
  {
    name: "ship_task",
    description:
      "Run the 4-stage ai-ship pipeline (isolated worktree -> implement -> adversarial tests -> local verify -> 3-lens review -> rebase & optional PR). Supports noty://item/<id> URIs and inline flags (--pr, --skip-tests, --skip-review).",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description or noty://item/<id> URI" },
        repoDir: {
          type: "string",
          description: "Target git repository directory (defaults to current working directory)",
        },
        openPr: {
          type: "boolean",
          description: "Rebase, push branch, and open a PR after all stages pass",
        },
        skipTests: {
          type: "boolean",
          description: "Skip Stage 2 independent adversarial test generation",
        },
        skipReview: {
          type: "boolean",
          description: "Skip Stage 4 parallel multi-lens review",
        },
        provider: {
          type: "string",
          enum: ["opencode", "claude-code"],
          description: "Runner provider (defaults to claude-code when OpenRouter is not configured)",
        },
        model: { type: "string", description: "Optional model override (provider/model)" },
      },
      required: ["task"],
    },
  },
  {
    name: "memory_save",
    description:
      "Save a durable, repo-specific fact, invariant, or pitfall to persistent repository memory.",
    inputSchema: {
      type: "object",
      properties: {
        entry: { type: "string", description: "Concise, reusable rule or fact to remember" },
        category: {
          type: "string",
          description: "Short category tag such as architecture, security, testing, or build",
        },
        repoDir: {
          type: "string",
          description: "Target git repository directory (defaults to current working directory)",
        },
      },
      required: ["entry"],
    },
  },
  {
    name: "memory_forget",
    description: "Remove outdated or incorrect entries matching a query from repository memory.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Case-insensitive substring matching the memory entry to remove",
        },
        repoDir: {
          type: "string",
          description: "Target git repository directory (defaults to current working directory)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "dream_consolidate",
    description:
      "Run offline dream consolidation: merge duplicates and prune stale repo memory against recent session transcripts.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Optional model override for consolidation" },
        repoDir: {
          type: "string",
          description: "Target git repository directory (defaults to current working directory)",
        },
      },
    },
  },
  {
    name: "cleanup_worktrees",
    description:
      "List or remove leftover ai-ship worktrees and ai/* branches. Defaults to dry-run unless confirm is true.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          description: "Set true to delete listed worktrees and branches",
        },
        repoDir: {
          type: "string",
          description: "Target git repository directory (defaults to current working directory)",
        },
      },
    },
  },
];

function hasOpenRouterAuth(): boolean {
  if (process.env.OPENROUTER_API_KEY?.trim()) return true;
  try {
    const authPath = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
    const raw = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
    return Boolean(raw && typeof raw === "object" && raw.openrouter);
  } catch {
    return false;
  }
}

function hasClaudeCli(): boolean {
  if (spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0) return true;
  return fs.existsSync("/opt/homebrew/bin/claude") || fs.existsSync("/usr/local/bin/claude");
}

function resolveMcpProvider(rawProvider: unknown): ProviderName {
  if (typeof rawProvider === "string" && rawProvider.trim()) {
    return normalizeProvider(rawProvider);
  }
  if (!hasOpenRouterAuth() && hasClaudeCli()) {
    return "claude-code";
  }
  return "opencode";
}

async function executeTool(
  name: string,
  args: Record<string, any>,
  deps: McpToolDeps
): Promise<string> {
  const targetRepo = typeof args.repoDir === "string" && args.repoDir.trim()
    ? args.repoDir.trim()
    : process.cwd();

  switch (name) {
    case "ship_task": {
      if (typeof args.task !== "string" || !args.task.trim()) {
        throw new Error("`task` must be a non-empty string.");
      }
      const resolved = deps.resolveShipTaskInput(args.task, {
        openPr: Boolean(args.openPr),
        skipTests: Boolean(args.skipTests),
        skipReview: Boolean(args.skipReview),
        provider: typeof args.provider === "string" ? args.provider : undefined,
      });
      const provider = resolveMcpProvider(resolved.provider ?? args.provider);
      const result = await deps.runPipeline({
        repoDir: targetRepo,
        task: resolved.task,
        openPr: resolved.openPr,
        skipTests: resolved.skipTests,
        skipReview: resolved.skipReview,
        provider,
        model: typeof args.model === "string" ? args.model : undefined,
      });
      if (!result) {
        return `ai-ship pipeline completed for "${resolved.title || resolved.task}" in ${targetRepo}.`;
      }
      const reviewSummary = result.reviewVerdicts.length
        ? result.reviewVerdicts.map((r) => `${r.lens}: ${r.verdict}`).join(", ")
        : "(skipped)";
      const verifySummary = result.verifyCommands.length
        ? `${result.verifyCommands.join(" && ")} (passed)`
        : "(none)";
      const lines = [
        `ai-ship pipeline completed for "${resolved.title || resolved.task}"`,
        `- Repo: ${result.repoDir}`,
        `- Branch: ${result.branch} (base: ${result.baseBranch}, ${result.committed ? "committed" : "no changes"})`,
        `- Worktree: ${result.worktreeDir}`,
        `- Provider: ${result.provider}`,
        `- Verify: ${verifySummary}`,
        `- Review: ${reviewSummary}`,
        `- PR: ${result.prUrl ?? (resolved.openPr ? "(not created — no changes or gh failed)" : "(not requested)")}`,
      ];
      if (result.usageLog.length) {
        lines.push("- Usage:", ...result.usageLog);
      }
      return lines.join("\n");
    }
    case "memory_save": {
      if (typeof args.entry !== "string" || !args.entry.trim()) {
        throw new Error("`entry` must be a non-empty string.");
      }
      const res = deps.appendMemory(
        targetRepo,
        args.entry,
        typeof args.category === "string" && args.category.trim() ? args.category : "note"
      );
      return res.added
        ? `Saved to repo memory (${res.path}).`
        : `Already present or empty; skipped (${res.path}).`;
    }
    case "memory_forget": {
      if (typeof args.query !== "string" || !args.query.trim()) {
        throw new Error("`query` must be a non-empty string.");
      }
      const res = deps.forgetMemory(targetRepo, args.query);
      return `Removed ${res.removedCount} matching entry(s) from ${res.path}.`;
    }
    case "dream_consolidate": {
      const res = await deps.runDreamConsolidation({
        repoDir: targetRepo,
        model: typeof args.model === "string" ? args.model : undefined,
      });
      return `Consolidated memory at ${res.memoryPath} (${res.usageSummary}).`;
    }
    case "cleanup_worktrees": {
      const targets = deps.listCleanupTargets(targetRepo);
      const deletableBranches = targets.branches.filter((b) => !b.checkedOutInMain);
      if (targets.worktrees.length === 0 && deletableBranches.length === 0) {
        return "Nothing to clean up.";
      }
      const summary = [
        `Worktrees (${targets.worktrees.length}): ${targets.worktrees.map((w) => w.path).join(", ") || "(none)"}`,
        `Branches (${deletableBranches.length}): ${deletableBranches.map((b) => `${b.name}${b.merged ? " [merged]" : ""}`).join(", ") || "(none)"}`,
      ].join("\n");
      if (!args.confirm) {
        return `Dry run — pass confirm=true to remove:\n${summary}`;
      }
      const removed = deps.removeCleanupTargets(targets);
      return `Removed ${removed.removedWorktrees.length} worktree(s) and ${removed.removedBranches.length} branch(es).`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Handles a single JSON-RPC 2.0 MCP request; returns null for notifications. */
export async function handleMcpRequest(
  req: JsonRpcRequest,
  deps: McpToolDeps = DEFAULT_DEPS
): Promise<JsonRpcResponse | null> {
  if (req.id === undefined) {
    return null;
  }

  const id = req.id;

  if (req.method === "initialize") {
    const protocolVersion =
      typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2024-11-05";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "ai-ship", version: "0.1.0" },
      },
    };
  }

  if (req.method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (req.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: MCP_TOOLS },
    };
  }

  if (req.method === "tools/call") {
    const name = req.params?.name;
    const args = (req.params?.arguments ?? {}) as Record<string, any>;
    try {
      const text = await executeTool(String(name ?? ""), args, deps);
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }] },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `ai-ship (${String(name ?? "unknown")}) failed: ${message}` }],
          isError: true,
        },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${req.method}` },
  };
}

/** Starts the stdio MCP server, redirecting console output to stderr so stdout stays pure JSON-RPC. */
export function startMcpServer(): void {
  process.env.AI_SHIP_MCP = "1";
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  console.warn = (...args: unknown[]) => console.error(...args);

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const errResp: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
      process.stdout.write(JSON.stringify(errResp) + "\n");
      return;
    }

    void handleMcpRequest(parsed).then((resp) => {
      if (resp) {
        process.stdout.write(JSON.stringify(resp) + "\n");
      }
    });
  });
}
