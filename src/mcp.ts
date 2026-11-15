import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { resolveShipTaskInput } from "../plugin/index.ts";
import { listCleanupTargets, openPrFromWorktree, removeCleanupTargets } from "./git.ts";
import { appendMemory, forgetMemory } from "./memory.ts";
import { formatPipelineResult, runDreamConsolidation, runPipeline } from "./pipeline.ts";
import { normalizeProvider, type ProviderName } from "./runner.ts";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  // MCP results are tool-specific JSON payloads.
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDeps {
  runPipeline: typeof runPipeline;
  runDreamConsolidation: typeof runDreamConsolidation;
  resolveShipTaskInput: typeof resolveShipTaskInput;
  appendMemory: typeof appendMemory;
  forgetMemory: typeof forgetMemory;
  listCleanupTargets: typeof listCleanupTargets;
  removeCleanupTargets: typeof removeCleanupTargets;
  openPrFromWorktree: typeof openPrFromWorktree;
  notify?: (notification: { jsonrpc: "2.0"; method: string; params: Record<string, unknown> }) => void;
}

const DEFAULT_DEPS: McpToolDeps = {
  runPipeline,
  runDreamConsolidation,
  resolveShipTaskInput,
  appendMemory,
  forgetMemory,
  listCleanupTargets,
  removeCleanupTargets,
  openPrFromWorktree,
};

export const MCP_TOOLS = [
  {
    name: "ship_task",
    description:
      "Run the 4-stage ai-ship pipeline (isolated worktree -> implement -> adversarial tests -> local verify -> 3-lens review -> rebase & optional PR). Supports noty://item/<id> URIs and inline flags (--pr, --draft, --worktree, --skip-tests, --skip-review).",
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
        draft: {
          type: "boolean",
          description: "Open the PR as a GitHub Draft PR (implies openPr)",
        },
        worktreeDir: {
          type: "string",
          description: "Existing ai-ship worktree path to iterate on instead of creating a new one",
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
          description:
            "Runner provider (defaults to opencode when any OpenCode provider is configured, otherwise claude-code if available)",
        },
        model: { type: "string", description: "Optional implementer model override (provider/model)" },
        testerModel: { type: "string", description: "Optional tester model override (must differ from the implementer)" },
        reviewerModel: { type: "string", description: "Optional reviewer model override (must differ from the implementer)" },
        bughunterModel: { type: "string", description: "Optional bughunter model override (must differ from the implementer)" },
        allowConfigChange: {
          type: "boolean",
          description:
            "Allow agents to change protected verify/config files (.ai-ship.json, package.json scripts, CI, test config)",
        },
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
        force: {
          type: "boolean",
          description: "Also remove dirty worktrees, orphan dirs and unmerged branches (default: keep them)",
        },
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
  {
    name: "open_pr",
    description:
      "Rebase an existing ai-ship worktree/branch onto its base branch, push it, and open a GitHub PR with the provided title and comment body.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "PR title (supports inline --draft flag)" },
        body: {
          type: "string",
          description: "PR description/comment (e.g. summary from the previous response)",
        },
        worktreeDir: {
          type: "string",
          description: "Path to the ai-ship worktree directory",
        },
        branch: {
          type: "string",
          description: "Feature branch name (e.g. ai/...) if worktreeDir is not specified",
        },
        baseBranch: {
          type: "string",
          description: "Base branch (defaults to repository default branch)",
        },
        draft: {
          type: "boolean",
          description: "Open the PR as a GitHub Draft PR",
        },
        repoDir: {
          type: "string",
          description: "Target git repository directory (defaults to current working directory)",
        },
      },
      required: ["title"],
    },
  },
];

const OPENCODE_PROVIDER_ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "PARASAIL_API_KEY",
  "TELNYX_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
];

export interface McpProviderDetectionOpts {
  repoDir?: string;
  authPath?: string;
  opencodeConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  hasClaude?: () => boolean;
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function hasOpencodeProviderAuth(opts: McpProviderDetectionOpts = {}): boolean {
  const env = opts.env ?? process.env;
  if (OPENCODE_PROVIDER_ENV_KEYS.some((key) => Boolean(env[key]?.trim()))) {
    return true;
  }

  const authPath = opts.authPath ?? path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
  const auth = readJsonRecord(authPath);
  if (auth && Object.values(auth).some(Boolean)) {
    return true;
  }

  const opencodeConfigPath =
    opts.opencodeConfigPath ?? path.join(os.homedir(), ".config", "opencode", "opencode.json");
  const opencodeCfg = readJsonRecord(opencodeConfigPath);
  const configuredProviders = opencodeCfg?.provider;
  if (
    configuredProviders &&
    typeof configuredProviders === "object" &&
    !Array.isArray(configuredProviders) &&
    Object.keys(configuredProviders).length > 0
  ) {
    return true;
  }

  if (opts.repoDir) {
    const repoCfg = readJsonRecord(path.join(opts.repoDir, ".ai-ship.json"));
    if (repoCfg) {
      const repoProviders = repoCfg.providers;
      if (
        repoProviders &&
        typeof repoProviders === "object" &&
        !Array.isArray(repoProviders) &&
        Object.keys(repoProviders).length > 0
      ) {
        return true;
      }
      if (repoCfg.implementerModel || repoCfg.testerModel || repoCfg.reviewerModel) {
        return true;
      }
    }
  }

  return false;
}

function hasClaudeCli(): boolean {
  if (spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0) return true;
  return fs.existsSync("/opt/homebrew/bin/claude") || fs.existsSync("/usr/local/bin/claude");
}

export function resolveMcpProvider(
  rawProvider: unknown,
  opts: McpProviderDetectionOpts = {}
): ProviderName {
  if (typeof rawProvider === "string" && rawProvider.trim()) {
    return normalizeProvider(rawProvider);
  }
  const claudeAvailable = opts.hasClaude ?? hasClaudeCli;
  if (!hasOpencodeProviderAuth(opts) && claudeAvailable()) {
    return "claude-code";
  }
  return "opencode";
}

const skippedNote = (r: { skippedWorktrees?: string[]; skippedBranches: string[]; forceRemovableBranches?: string[] }) =>
  [
    r.skippedWorktrees?.length ? `Kept ${r.skippedWorktrees.length} worktree(s) with uncommitted changes or orphan dirs: ${r.skippedWorktrees.join(", ")}.` : "",
    r.skippedBranches.length ? `Kept branch(es) (unmerged — including squash-merged — checked out, or attached to a kept worktree): ${r.skippedBranches.join(", ")}.` : "",
    r.skippedWorktrees?.length || r.forceRemovableBranches?.length ? "Pass force=true to remove the kept worktrees and unmerged branches too." : "",
  ]
    .filter(Boolean)
    .join("\n");

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  deps: McpToolDeps,
  onProgress?: (stage: string) => void
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
        draft: Boolean(args.draft),
        worktreeDir: typeof args.worktreeDir === "string" ? args.worktreeDir : undefined,
        skipTests: Boolean(args.skipTests),
        skipReview: Boolean(args.skipReview),
        provider: typeof args.provider === "string" ? args.provider : undefined,
      });
      if (resolved.title) {
        onProgress?.(`Resolved Noty: ${resolved.title}`);
      }
      const provider = resolveMcpProvider(resolved.provider ?? args.provider, { repoDir: targetRepo });
      const result = await deps.runPipeline({
        repoDir: targetRepo,
        task: resolved.task,
        openPr: resolved.openPr,
        ...(resolved.draft ? { draft: true } : {}),
        ...(resolved.worktreeDir ? { worktreeDir: resolved.worktreeDir } : {}),
        skipTests: resolved.skipTests,
        skipReview: resolved.skipReview,
        provider,
        model: typeof args.model === "string" ? args.model : undefined,
        ...(typeof args.testerModel === "string" ? { testerModel: args.testerModel } : {}),
        ...(typeof args.reviewerModel === "string" ? { reviewerModel: args.reviewerModel } : {}),
        ...(typeof args.bughunterModel === "string" ? { bughunterModel: args.bughunterModel } : {}),
        ...(args.allowConfigChange === true ? { allowConfigChange: true } : {}),
        onProgress,
      });
      if (!result) {
        return `ai-ship pipeline completed for "${resolved.title || resolved.task}" in ${targetRepo}.`;
      }
      return formatPipelineResult(result, resolved.title || resolved.task, resolved.openPr);
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
      const removed = deps.removeCleanupTargets(targets, { force: args.force === true });
      return [
        `Removed ${removed.removedWorktrees.length} worktree(s) and ${removed.removedBranches.length} branch(es).`,
        skippedNote(removed),
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "open_pr": {
      if (typeof args.title !== "string" || !args.title.trim()) {
        throw new Error("`title` must be a non-empty string.");
      }
      const res = deps.openPrFromWorktree({
        repoDir: targetRepo,
        title: args.title,
        body: typeof args.body === "string" ? args.body : undefined,
        worktreeDir: typeof args.worktreeDir === "string" ? args.worktreeDir : undefined,
        branch: typeof args.branch === "string" ? args.branch : undefined,
        baseBranch: typeof args.baseBranch === "string" ? args.baseBranch : undefined,
        draft: Boolean(args.draft),
      });
      return [
        `Opened ${res.draft ? "draft PR" : "PR"} for branch \`${res.branch}\` (base: \`${res.baseBranch}\`)`,
        `- Worktree: ${res.worktreeDir}`,
        ...(res.rebasedOnto ? [`- Rebased onto: ${res.rebasedOnto}`] : []),
        `- PR: ${res.prUrl ?? "(created)"}`,
      ].join("\n");
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
        capabilities: { tools: {}, logging: {} },
        serverInfo: { name: "ai-ship", version: "0.1.0" },
      },
    };
  }

  if (req.method === "ping" || req.method === "logging/setLevel") {
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
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    const meta = req.params?._meta as { progressToken?: string | number } | undefined;
    const progressToken = meta?.progressToken;
    let step = 0;
    const onProgress = (stage: string) => {
      step += 1;
      deps.notify?.({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info", logger: "ai-ship", data: stage },
      });
      if (progressToken !== undefined) {
        deps.notify?.({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken, progress: step, message: stage },
        });
      }
    };
    try {
      const text = await executeTool(String(name ?? ""), args, deps, onProgress);
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

    const stdioDeps: McpToolDeps = {
      ...DEFAULT_DEPS,
      notify: (notification) => {
        process.stdout.write(JSON.stringify(notification) + "\n");
      },
    };

    void handleMcpRequest(parsed, stdioDeps).then((resp) => {
      if (resp) {
        process.stdout.write(JSON.stringify(resp) + "\n");
      }
    });
  });
}
