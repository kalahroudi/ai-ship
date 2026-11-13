import { spawn } from "node:child_process";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import type { RepoConfig } from "./config.ts";

export type OpencodeClient = ReturnType<typeof createOpencodeClient>;

export type ProviderName = "opencode" | "claude-code";
export type AgentRole = "implementer" | "tester" | "reviewer";

export const DEFAULT_CLAUDE_MODEL = "sonnet-5-5";

export interface PromptResult {
  text: string;
  usageSummary: string;
}

export interface PipelineRunner {
  createSession(title: string): Promise<string>;
  prompt(sessionId: string, role: AgentRole, text: string): Promise<PromptResult>;
  close(): void;
}

interface TextPart {
  type?: string;
  text?: string;
}

interface OpencodeMessageError {
  name?: string;
  message?: string;
  data?: {
    message?: string;
    statusCode?: number;
    responseBody?: string;
  };
}

interface PromptResponseData {
  parts?: TextPart[];
  info?: {
    error?: OpencodeMessageError;
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Normalizes CLI provider aliases to a supported runner provider. */
export function normalizeProvider(raw?: string): ProviderName {
  if (!raw) return "opencode";
  const value = raw.trim().toLowerCase();
  if (value === "opencode" || value === "openrouter" || value === "cloudflare") {
    return "opencode";
  }
  if (value === "claude-code") {
    return "claude-code";
  }
  throw new Error(`Unknown provider "${raw}". Supported providers: opencode (default, openrouter/cloudflare), claude-code.`);
}

/** Parses an optional `--model` string into OpenCode's `{ providerID, modelID }` shape. */
export function parseOpencodeModel(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash > 0) {
    return {
      providerID: model.slice(0, slash),
      modelID: model.slice(slash + 1),
    };
  }
  return { providerID: "openrouter", modelID: model };
}

function extractOpencodeText(data: PromptResponseData | undefined): string {
  if (!data?.parts) return "";
  return data.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("\n")
    .trim();
}

function formatOpencodeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const e = err as OpencodeMessageError;
    const msg = e.data?.message || e.message || e.data?.responseBody;
    const status = typeof e.data?.statusCode === "number" ? ` HTTP ${e.data.statusCode}` : "";
    if (e.name && msg) return `${e.name}${status}: ${msg}`;
    if (msg) return `${msg}${status}`;
    return JSON.stringify(err);
  }
  return String(err);
}

/** Extracts text and usage from an OpenCode prompt response, throwing on transport or model errors. */
export function parseOpencodePromptResponse(
  res: { data?: PromptResponseData; error?: unknown },
  role: AgentRole
): PromptResult {
  if (res.error) {
    throw new Error(`OpenCode ${role} request failed: ${formatOpencodeError(res.error)}`);
  }
  if (!res.data) {
    throw new Error(`OpenCode ${role} returned an empty response.`);
  }
  if (res.data.info?.error) {
    throw new Error(`OpenCode ${role} failed: ${formatOpencodeError(res.data.info.error)}`);
  }
  return {
    text: extractOpencodeText(res.data),
    usageSummary: formatOpencodeUsage(res.data),
  };
}

function formatOpencodeUsage(data: PromptResponseData | undefined): string {
  const t = data?.info?.tokens;
  const cost = data?.info?.cost;
  if (!t) return "completed";
  const costStr = typeof cost === "number" ? ` | $${cost.toFixed(4)}` : "";
  const cacheRead = t.cache?.read ?? 0;
  return `in=${t.input ?? 0} out=${t.output ?? 0} cache_read=${cacheRead}${costStr}`;
}

/** Builds CLI arguments for non-interactive `claude` execution. */
export function buildClaudeArgs(opts: {
  model: string;
  role: AgentRole;
  resumeSessionId?: string;
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    opts.model,
    "--dangerously-skip-permissions",
  ];
  if (opts.role === "reviewer") {
    args.push("--tools", "Read,Glob,Grep");
  }
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  return args;
}

/** Parses `claude -p --output-format json` stdout into text, session ID, and usage summary. */
export function parseClaudeJsonOutput(stdout: string): {
  text: string;
  sessionId?: string;
  usageSummary: string;
} {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("claude CLI returned empty output.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Failed to parse claude JSON output: ${(err as Error).message}\nRaw output:\n${trimmed.slice(0, 1000)}`);
  }

  const item: ClaudeJsonResult = Array.isArray(parsed)
    ? ([...parsed].reverse().find((e) => (e as ClaudeJsonResult)?.type === "result") ??
        parsed[parsed.length - 1] ??
        {})
    : (parsed as ClaudeJsonResult);

  if (item.is_error) {
    throw new Error(`claude CLI reported an error: ${item.result ?? "unknown error"}`);
  }

  const text = (item.result ?? "").trim();
  const u = item.usage;
  const costStr = typeof item.total_cost_usd === "number" ? ` | $${item.total_cost_usd.toFixed(4)}` : "";
  const usageSummary = u
    ? `in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0}${costStr}`
    : `completed${costStr}`;

  return {
    text,
    sessionId: item.session_id,
    usageSummary,
  };
}

function runClaudeCommand(cwd: string, args: string[], promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(new Error(`Failed to launch claude CLI: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}: ${(stderr || stdout).trim().slice(-2000)}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(promptText);
    child.stdin.end();
  });
}

/** Wraps an existing OpenCode client (embedded server, `opencode serve`, or plugin context). */
export function createOpencodeClientRunner(opts: {
  client: OpencodeClient;
  worktreeDir: string;
  config: RepoConfig;
  model?: string;
  onClose?: () => void;
}): PipelineRunner {
  const cliModel = parseOpencodeModel(opts.model);

  const modelForRole = (role: AgentRole) => {
    if (cliModel) return cliModel;
    const roleCfg =
      role === "implementer"
        ? opts.config.implementerModel
        : role === "tester"
          ? opts.config.testerModel
          : opts.config.reviewerModel;
    return roleCfg ? { providerID: roleCfg.providerID, modelID: roleCfg.id } : undefined;
  };

  return {
    async createSession(title: string): Promise<string> {
      const res = await opts.client.session.create({
        query: { directory: opts.worktreeDir },
        body: { title },
      });
      const id = res.data?.id;
      if (!id) throw new Error(`Failed to create OpenCode session (${title})`);
      return id;
    },
    async prompt(sessionId: string, role: AgentRole, text: string): Promise<PromptResult> {
      const model = modelForRole(role);
      const res = await opts.client.session.prompt({
        path: { id: sessionId },
        query: { directory: opts.worktreeDir },
        body: {
          agent: role,
          ...(model ? { model } : {}),
          parts: [{ type: "text", text }],
        },
      });
      return parseOpencodePromptResponse(
        res as { data?: PromptResponseData; error?: unknown },
        role
      );
    },
    close() {
      opts.onClose?.();
    },
  };
}

/** Collects a compact text digest of recent OpenCode sessions for offline dream consolidation. */
export async function collectRecentTranscripts(
  client: OpencodeClient,
  directory: string,
  maxSessions = 8
): Promise<string> {
  const listRes = await client.session.list({ query: { directory } });
  const sessions = (listRes.data ?? []).slice(0, maxSessions);
  const sections: string[] = [];

  for (const s of sessions) {
    if (!s.id || s.title?.startsWith("Dream:")) continue;
    const msgRes = await client.session.messages({
      path: { id: s.id },
      query: { directory },
    });
    const msgs = msgRes.data ?? [];
    if (msgs.length === 0) continue;

    const lines: string[] = [`### Session: ${s.title || s.id}`];
    for (const m of msgs.slice(-12)) {
      const role = m.info?.role ?? "unknown";
      const text = (m.parts ?? [])
        .filter((p) => p.type === "text" && typeof (p as TextPart).text === "string")
        .map((p) => (p as TextPart).text!)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 600);
      if (text) lines.push(`- **${role}**: ${text}`);
    }
    if (lines.length > 1) sections.push(lines.join("\n"));
  }

  return sections.join("\n\n").slice(0, 24000);
}

async function createOpencodeRunner(opts: {
  worktreeDir: string;
  config: RepoConfig;
  cfGatewayUrl?: string;
  model?: string;
  serverUrl?: string;
}): Promise<PipelineRunner> {
  if (opts.serverUrl) {
    const client = createOpencodeClient({ baseUrl: opts.serverUrl });
    return createOpencodeClientRunner({
      client,
      worktreeDir: opts.worktreeDir,
      config: opts.config,
      model: opts.model,
    });
  }

  const { client, server } = await createOpencode({
    port: 0,
    ...(opts.cfGatewayUrl
      ? {
          config: {
            provider: {
              openrouter: {
                options: {
                  baseURL: opts.cfGatewayUrl,
                },
              },
            },
          },
        }
      : {}),
  });

  return createOpencodeClientRunner({
    client,
    worktreeDir: opts.worktreeDir,
    config: opts.config,
    model: opts.model,
    onClose: () => server.close(),
  });
}

function createClaudeCodeRunner(opts: {
  worktreeDir: string;
  model?: string;
}): PipelineRunner {
  const model = opts.model || DEFAULT_CLAUDE_MODEL;
  const sessionMap = new Map<string, string | undefined>();
  let nextLocalId = 1;

  return {
    async createSession(_title: string): Promise<string> {
      const localId = `claude-local-${nextLocalId++}`;
      sessionMap.set(localId, undefined);
      return localId;
    },
    async prompt(sessionId: string, role: AgentRole, text: string): Promise<PromptResult> {
      const resumeSessionId = sessionMap.get(sessionId);
      const args = buildClaudeArgs({ model, role, resumeSessionId });
      const stdout = await runClaudeCommand(opts.worktreeDir, args, text);
      const parsed = parseClaudeJsonOutput(stdout);
      if (parsed.sessionId) {
        sessionMap.set(sessionId, parsed.sessionId);
      }
      return {
        text: parsed.text,
        usageSummary: parsed.usageSummary,
      };
    },
    close() {},
  };
}

/** Creates the configured LLM runner (`opencode` by default, or `claude-code`). */
export async function createRunner(opts: {
  provider: ProviderName;
  worktreeDir: string;
  config: RepoConfig;
  cfGatewayUrl?: string;
  model?: string;
  serverUrl?: string;
}): Promise<PipelineRunner> {
  if (opts.provider === "claude-code") {
    return createClaudeCodeRunner({
      worktreeDir: opts.worktreeDir,
      model: opts.model,
    });
  }
  return createOpencodeRunner({
    worktreeDir: opts.worktreeDir,
    config: opts.config,
    cfGatewayUrl: opts.cfGatewayUrl,
    model: opts.model,
    serverUrl: opts.serverUrl,
  });
}
