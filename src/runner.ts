import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import type { ModelRef, RepoConfig } from "./config.ts";
import { loadPricingTable, resolveCost, toOpencodeCost, findPricing, type CostSource, type PricingTable } from "./pricing.ts";
import { buildGatewayProvider, GATEWAY_PROVIDER_ID, gatewayCompatUrl, loadCatalog } from "./catalog.ts";
import { startEgressProxy, type EgressUsage } from "./egress.ts";

export type OpencodeClient = ReturnType<typeof createOpencodeClient>;

export type ProviderName = "opencode" | "claude-code";
export type AgentRole = "implementer" | "tester" | "reviewer" | "bughunter";

export const READ_ONLY_OPENCODE_TOOLS: Readonly<Record<string, boolean>> = {
  write: false,
  edit: false,
  patch: false,
  multiedit: false,
  bash: false,
  webfetch: false,
};

/** Returns true when the given role must be restricted to read-only file inspection tools. */
export function isReadOnlyRole(role: AgentRole): boolean {
  return role === "reviewer" || role === "bughunter";
}

/** Builds OpenCode `config.agent` entries enforcing read-only permissions for reviewer and bughunter roles. */
export function buildOpencodeAgentConfig(): Record<
  "reviewer" | "bughunter",
  {
    tools: Record<string, boolean>;
    permission: { edit: "deny"; bash: "deny"; webfetch: "deny" };
  }
> {
  const readOnly = {
    tools: { ...READ_ONLY_OPENCODE_TOOLS },
    permission: {
      edit: "deny" as const,
      bash: "deny" as const,
      webfetch: "deny" as const,
    },
  };
  return {
    reviewer: readOnly,
    bughunter: {
      tools: { ...readOnly.tools },
      permission: { ...readOnly.permission },
    },
  };
}

export const DEFAULT_CLAUDE_MODEL = "sonnet";

/** Per-role Claude models for the claude-code runner; distinct by default so tests/reviews are independent. */
export const DEFAULT_CLAUDE_ROLE_MODELS: Readonly<Record<AgentRole, string>> = {
  implementer: "opus",
  tester: "sonnet",
  reviewer: "haiku",
  bughunter: "sonnet",
};

export const AGENT_ROLES: readonly AgentRole[] = ["implementer", "tester", "reviewer", "bughunter"];

/** CLI/MCP per-role model overrides (`provider/model` for OpenCode, alias or id for claude-code). */
export type RoleModelOverrides = Partial<Record<AgentRole, string>>;

function roleConfigModel(config: RepoConfig, role: AgentRole): ModelRef | undefined {
  return role === "implementer"
    ? config.implementerModel
    : role === "tester"
      ? config.testerModel
      : role === "bughunter"
        ? config.bughunterModel
        : config.reviewerModel;
}

/**
 * Resolves the model label used for each role.
 * `overrides.implementer` (the `--model` flag) only affects the implementer; other roles keep their own model.
 * Returns undefined for a role whose model is left to the OpenCode agent config.
 */
export function resolveRoleModelLabels(
  provider: ProviderName,
  config: RepoConfig,
  overrides: RoleModelOverrides = {}
): Record<AgentRole, string | undefined> {
  const out = {} as Record<AgentRole, string | undefined>;
  for (const role of AGENT_ROLES) {
    if (provider === "claude-code") {
      out[role] = overrides[role] || config.claudeModels?.[role] || DEFAULT_CLAUDE_ROLE_MODELS[role];
    } else {
      const defaultProvider = config.defaultProvider ?? config.implementerModel?.providerID ?? "deepseek";
      const parsed = parseOpencodeModel(overrides[role], defaultProvider);
      const ref = parsed ?? toOpencodeModel(roleConfigModel(config, role));
      out[role] = ref ? `${ref.providerID}/${ref.modelID}` : undefined;
    }
  }
  return out;
}

export class ModelIndependenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelIndependenceError";
  }
}

function roleFallbackConfigModel(config: RepoConfig, role: AgentRole): ModelRef | undefined {
  return role === "implementer"
    ? config.implementerFallbackModel
    : role === "tester"
      ? config.testerFallbackModel
      : role === "bughunter"
        ? config.bughunterFallbackModel
        : config.reviewerFallbackModel;
}

/** Fallback model labels per role (OpenCode only; the claude-code runner has no per-role fallback). */
export function resolveRoleFallbackLabels(
  provider: ProviderName,
  config: RepoConfig
): Record<AgentRole, string | undefined> {
  const out = {} as Record<AgentRole, string | undefined>;
  for (const role of AGENT_ROLES) {
    const ref = provider === "claude-code" ? undefined : roleFallbackConfigModel(config, role);
    out[role] = ref ? `${ref.providerID}/${ref.id}` : undefined;
  }
  return out;
}

function normalizeModelLabel(label: string): string {
  return label.trim().toLowerCase();
}

/** Last path segment of a model label (e.g. "openrouter/anthropic/claude-x" -> "claude-x"). */
function modelBaseName(label: string): string {
  const parts = normalizeModelLabel(label).split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * Checks that the tester, reviewer(s) and bughunter never run on the implementer's model, including via
 * fallback models used after a 429/5xx failover. Exact matches (case-insensitive) are violations and throw
 * ModelIndependenceError when `strict`; the same model name reached through a different provider prefix is
 * reported as a warning. Returns all problems/warnings.
 */
export function checkModelIndependence(opts: {
  labels: Record<AgentRole, string | undefined>;
  fallbacks?: Partial<Record<AgentRole, string | undefined>>;
  lensModels?: Record<string, ModelRef>;
  strict: boolean;
  provider?: ProviderName;
}): string[] {
  const implementerModels = [opts.labels.implementer, opts.fallbacks?.implementer].filter(
    (l): l is string => Boolean(l)
  );
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!opts.labels.implementer) {
    warnings.push("implementer model is resolved by the OpenCode agent config; independence could not be verified");
  }

  const consider = (who: string, label: string | undefined) => {
    if (!label) {
      warnings.push(`${who} model is resolved by the OpenCode agent config; independence could not be verified`);
      return;
    }
    // Exact matches first, so a same-name warning against the primary can't shadow an exact fallback match.
    const exact = implementerModels.find((impl) => normalizeModelLabel(label) === normalizeModelLabel(impl));
    if (exact) {
      problems.push(`${who} uses the implementer's model (${exact})`);
      return;
    }
    const sameName = implementerModels.find((impl) => modelBaseName(label) === modelBaseName(impl));
    if (sameName) {
      warnings.push(`${who} (${label}) may be the same model as the implementer (${sameName}) via a different provider`);
    }
  };

  for (const role of ["tester", "reviewer", "bughunter"] as const) {
    consider(role, opts.labels[role]);
    if (opts.fallbacks?.[role]) consider(`${role} fallback`, opts.fallbacks[role]);
  }
  for (const [lens, ref] of Object.entries(opts.lensModels ?? {})) {
    consider(`review lens "${lens}"`, ref.providerID ? `${ref.providerID}/${ref.id}` : ref.id);
  }

  if (problems.length > 0 && opts.strict) {
    const hint =
      opts.provider === "claude-code"
        ? 'Set distinct "claudeModels" per role in .ai-ship.json (or --tester-model/--reviewer-model/--bughunter-model),'
        : "Set distinct testerModel/reviewerModel/bughunterModel and their fallbacks in .ai-ship.json (or --tester-model/--reviewer-model/--bughunter-model),";
    throw new ModelIndependenceError(
      [
        "Independent tests/reviews require models different from the implementer:",
        ...problems.map((p) => `- ${p}`),
        hint,
        'or set "strictIndependence": false in .ai-ship.json to allow it.',
      ].join("\n")
    );
  }
  return [...problems, ...warnings];
}

/** Formats the role -> model table printed at pipeline start. */
export function formatRoleModelTable(labels: Record<AgentRole, string | undefined>): string[] {
  return AGENT_ROLES.map((r) => `  ${r.padEnd(11)} ${labels[r] ?? "(OpenCode agent default)"}`);
}

export interface FallbackActivation {
  role: AgentRole;
  from: string;
  to: string;
  reason: string;
}

export interface PromptUsage {
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
  /** Reasoning tokens (billed as output by most providers). */
  reasoning?: number;
  cacheWrite?: number;
  /** Where costUsd came from: provider-reported, computed from the pricing table, or unknown (no price). */
  costSource?: CostSource;
}

export interface PromptResult {
  text: string;
  usageSummary: string;
  usage?: PromptUsage;
  fallback?: FallbackActivation;
  /** `provider/model` that served this call, when known. */
  model?: string;
  /** Number of failed attempts (empty replies, transient errors) whose usage was folded into `usage`. */
  wastedAttempts?: number;
}

/** Adds two usages (token counts and cost); the cost source degrades to the least reliable of the two. */
export function addUsage(a: PromptUsage | undefined, b: PromptUsage | undefined): PromptUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const rank: Record<CostSource, number> = { none: 0, provider: 1, computed: 2, unknown: 3 };
  const sa = a.costSource ?? "provider";
  const sb = b.costSource ?? "provider";
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    costUsd: a.costUsd + b.costUsd,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
    costSource: rank[sa] >= rank[sb] ? sa : sb,
  };
}

/** Formats a usage as `in=… out=… cache_read=… [reasoning=… cache_write=…] | $… [(computed|cost unknown)]`. */
export function formatUsageSummary(u: PromptUsage): string {
  const extras = [
    u.reasoning ? ` reasoning=${u.reasoning}` : "",
    u.cacheWrite ? ` cache_write=${u.cacheWrite}` : "",
  ].join("");
  const source =
    u.costSource === "computed" ? " (computed)" : u.costSource === "unknown" ? " (cost unknown: no pricing)" : "";
  return `in=${u.input} out=${u.output} cache_read=${u.cacheRead}${extras} | $${u.costUsd.toFixed(4)}${source}`;
}

export interface PromptOptions {
  modelOverride?: { providerID: string; modelID: string };
}

export interface PipelineRunner {
  createSession(title: string): Promise<string>;
  prompt(sessionId: string, role: AgentRole, text: string, options?: PromptOptions): Promise<PromptResult>;
  /** Compacts/summarizes a long-running session; returns true when the history was actually reduced. */
  compact?(sessionId: string, role: AgentRole): Promise<boolean>;
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
    providerID?: string;
    modelID?: string;
    parentID?: string;
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
  if (
    value === "opencode" ||
    value === "openrouter" ||
    value === "cloudflare" ||
    value === "deepseek" ||
    value === "parasail" ||
    value === "telnyx"
  ) {
    return "opencode";
  }
  if (value === "claude-code") {
    return "claude-code";
  }
  throw new Error(
    `Unknown provider "${raw}". Supported providers: opencode (default, deepseek/parasail/telnyx/openrouter/cloudflare), claude-code.`
  );
}

/** Parses an optional `--model` string into OpenCode's `{ providerID, modelID }` shape. */
export function parseOpencodeModel(
  model?: string,
  defaultProvider = "deepseek"
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash > 0) {
    return {
      providerID: model.slice(0, slash),
      modelID: model.slice(slash + 1),
    };
  }
  return { providerID: defaultProvider, modelID: model };
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
    usage: extractOpencodeUsage(res.data),
  };
}

function extractOpencodeUsage(data: PromptResponseData | undefined): PromptUsage | undefined {
  const t = data?.info?.tokens;
  const cost = data?.info?.cost;
  if (!t && typeof cost !== "number") return undefined;
  return {
    input: t?.input ?? 0,
    output: t?.output ?? 0,
    cacheRead: t?.cache?.read ?? 0,
    costUsd: typeof cost === "number" ? cost : 0,
    reasoning: t?.reasoning ?? 0,
    cacheWrite: t?.cache?.write ?? 0,
    costSource: typeof cost === "number" && cost > 0 ? "provider" : "unknown",
  };
}

interface StepMessage {
  info?: {
    role?: string;
    parentID?: string;
    cost?: number;
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  };
}

/**
 * OpenCode creates one assistant message per agent step, but `session.prompt` returns only the last one.
 * Sums tokens/cost over every assistant message answering the same user message (same `parentID`), so
 * tool-using turns are fully accounted for. Returns undefined when nothing matches.
 */
export function sumStepUsage(messages: StepMessage[], parentID: string): PromptUsage | undefined {
  let total: PromptUsage | undefined;
  let anyCost = false;
  for (const m of messages) {
    if (m.info?.role !== "assistant" || m.info.parentID !== parentID) continue;
    const t = m.info.tokens;
    const cost = typeof m.info.cost === "number" ? m.info.cost : 0;
    if (cost > 0) anyCost = true;
    total = addUsage(total, {
      input: t?.input ?? 0,
      output: t?.output ?? 0,
      cacheRead: t?.cache?.read ?? 0,
      cacheWrite: t?.cache?.write ?? 0,
      reasoning: t?.reasoning ?? 0,
      costUsd: cost,
      costSource: "provider",
    });
  }
  if (total) total.costSource = anyCost ? "provider" : "unknown";
  return total;
}

/**
 * Applies the pricing table to an OpenCode result: keeps a positive provider cost, otherwise computes the
 * cost from tokens (source "computed") or marks it "unknown". Also records which model served the call.
 */
export function applyPricing(
  result: PromptResult,
  modelLabel: string | undefined,
  table: PricingTable
): PromptResult {
  if (!result.usage) return { ...result, ...(modelLabel ? { model: modelLabel } : {}) };
  const resolved = resolveCost(result.usage, result.usage.costUsd, modelLabel, table);
  const usage: PromptUsage = { ...result.usage, costUsd: resolved.costUsd, costSource: resolved.costSource };
  return { ...result, usage, usageSummary: formatUsageSummary(usage), ...(modelLabel ? { model: modelLabel } : {}) };
}

/** Parses a formatted `in=... out=... cache_read=... | $...` usage summary string into structured counts. */
export function parseUsageSummary(summary: string): PromptUsage | undefined {
  const inMatch = summary.match(/\bin=(\d+)\b/);
  const outMatch = summary.match(/\bout=(\d+)\b/);
  const cacheMatch = summary.match(/\bcache_read=(\d+)\b/);
  const costMatch = summary.match(/\$(\d+(?:\.\d+)?)/);
  if (!inMatch && !outMatch && !cacheMatch && !costMatch) {
    return undefined;
  }
  return {
    input: inMatch ? Number(inMatch[1]) : 0,
    output: outMatch ? Number(outMatch[1]) : 0,
    cacheRead: cacheMatch ? Number(cacheMatch[1]) : 0,
    costUsd: costMatch ? Number(costMatch[1]) : 0,
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
  if (isReadOnlyRole(opts.role)) {
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
  usage?: PromptUsage;
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

  const usage: PromptUsage | undefined =
    u || typeof item.total_cost_usd === "number"
      ? {
          input: u?.input_tokens ?? 0,
          output: u?.output_tokens ?? 0,
          cacheRead: u?.cache_read_input_tokens ?? 0,
          costUsd: typeof item.total_cost_usd === "number" ? item.total_cost_usd : 0,
          costSource:
            typeof item.total_cost_usd === "number"
              ? "provider"
              : (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) > 0
                ? "unknown"
                : "none",
        }
      : undefined;

  return {
    text,
    sessionId: item.session_id,
    usageSummary,
    usage,
  };
}

function resolveClaudeBinary(): string {
  if (spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0) {
    return "claude";
  }
  for (const candidate of ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "claude";
}

function runClaudeCommand(cwd: string, args: string[], promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveClaudeBinary(), args, {
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

export interface TransientErrorInfo {
  transient: boolean;
  statusCode?: number;
  reason: string;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

function extractNumericStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const obj = err as Record<string, unknown>;
  for (const key of ["statusCode", "status"]) {
    if (typeof obj[key] === "number") return obj[key] as number;
  }
  for (const nestedKey of ["data", "cause", "response"]) {
    const nested = obj[nestedKey];
    if (typeof nested === "object" && nested !== null) {
      const status = extractNumericStatus(nested);
      if (status !== undefined) return status;
    }
  }
  return undefined;
}

/** Thrown when a read-only role (reviewer/bughunter) gets an empty reply; classified as transient so retry/fallback runs. */
export class EmptyModelResponseError extends Error {
  readonly role: AgentRole;
  /** Tokens/cost spent on the empty reply, so retries still count against the budget. */
  readonly usage?: PromptUsage;
  constructor(role: AgentRole, usage?: PromptUsage) {
    super(`${role} returned an empty response`);
    this.name = "EmptyModelResponseError";
    this.role = role;
    this.usage = usage;
  }
}

/** Throws EmptyModelResponseError when a read-only role's reply has no text. Writer roles may legitimately end with tool calls only. */
export function assertNonEmptyReadOnlyReply(role: AgentRole, result: PromptResult): PromptResult {
  if (isReadOnlyRole(role) && !result.text.trim()) {
    throw new EmptyModelResponseError(role, result.usage);
  }
  return result;
}

/** Usage attached to a failed attempt (e.g. an empty reply), if any. */
function usageOfError(err: unknown): PromptUsage | undefined {
  if (err && typeof err === "object" && "usage" in err) {
    const u = (err as { usage?: unknown }).usage;
    if (u && typeof u === "object" && typeof (u as PromptUsage).input === "number") return u as PromptUsage;
  }
  return undefined;
}

/** Classifies whether a provider/transport error is a transient 429 or 5xx failure. */
export function classifyProviderError(err: unknown): TransientErrorInfo {
  if (err instanceof EmptyModelResponseError) {
    return { transient: true, reason: "empty response" };
  }
  const statusCode = extractNumericStatus(err);
  if (statusCode !== undefined) {
    if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) {
      return { transient: true, statusCode, reason: `HTTP ${statusCode}` };
    }
    return { transient: false, statusCode, reason: `HTTP ${statusCode}` };
  }

  const msg = formatOpencodeError(err);
  const httpMatch = msg.match(/\b(?:HTTP|status(?:\s*code)?[:=\s]*)\s*(4\d{2}|5\d{2})\b/i);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    if (code === 429 || (code >= 500 && code < 600)) {
      return { transient: true, statusCode: code, reason: `HTTP ${code}` };
    }
    return { transient: false, statusCode: code, reason: `HTTP ${code}` };
  }

  if (/\b(?:too many requests|rate[- ]?limit(?:ed| exceed(?:ed)?)?)\b/i.test(msg)) {
    return { transient: true, statusCode: 429, reason: "HTTP 429 (rate limit)" };
  }

  const serverPhrase = msg.match(
    /\b(?:internal server error|bad gateway|service unavailable|gateway timeout|overloaded)\b/i
  );
  if (serverPhrase) {
    return { transient: true, reason: serverPhrase[0] };
  }

  const netMatch = msg.match(
    /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|fetch failed|socket hang up)\b/i
  );
  if (netMatch) {
    return { transient: true, reason: netMatch[0] };
  }

  return { transient: false, reason: msg.slice(0, 120) };
}

/** Computes bounded exponential backoff with equal jitter for transient retries. */
export function computeBackoffMs(
  retryIndex: number,
  opts?: { baseDelayMs?: number; maxDelayMs?: number; random?: () => number }
): number {
  const baseDelayMs = Math.max(0, opts?.baseDelayMs ?? 1000);
  const maxDelayMs = Math.max(baseDelayMs, opts?.maxDelayMs ?? 15000);
  const rand = opts?.random ?? Math.random;
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, retryIndex));
  const jittered = Math.round(exp * (0.5 + 0.5 * Math.min(1, Math.max(0, rand()))));
  return Math.min(maxDelayMs, jittered);
}

function formatModelLabel(model?: { providerID: string; modelID: string }): string {
  return model ? `${model.providerID}/${model.modelID}` : "(default)";
}

/**
 * Executes an LLM prompt with 0ms immediate failover to `fallbackModel` on 429/5xx,
 * plus bounded exponential backoff + jitter retries when no fallback is configured
 * or when both primary and fallback fail transiently.
 */
export async function executeWithFailoverAndRetry(opts: {
  role: AgentRole;
  primaryModel?: { providerID: string; modelID: string };
  fallbackModel?: { providerID: string; modelID: string };
  invoke: (model?: { providerID: string; modelID: string }) => Promise<PromptResult>;
  retry?: RetryOptions;
}): Promise<PromptResult> {
  const maxRetries = Math.max(0, opts.retry?.maxRetries ?? 3);
  const sleepFn =
    opts.retry?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const fallback = opts.fallbackModel;
  const hasDistinctFallback = Boolean(
    fallback &&
      (!opts.primaryModel ||
        fallback.providerID !== opts.primaryModel.providerID ||
        fallback.modelID !== opts.primaryModel.modelID)
  );

  let lastError: unknown;
  let wasted: PromptUsage | undefined;
  let wastedAttempts = 0;
  const noteWasted = (err: unknown) => {
    const u = usageOfError(err);
    wastedAttempts += 1;
    if (u) wasted = addUsage(wasted, u);
  };
  const withWasted = (res: PromptResult): PromptResult => {
    if (wastedAttempts === 0) return res;
    const usage = addUsage(res.usage, wasted);
    return {
      ...res,
      ...(usage ? { usage, usageSummary: formatUsageSummary(usage) } : {}),
      wastedAttempts,
    };
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return withWasted(await opts.invoke(opts.primaryModel));
    } catch (primaryErr) {
      const primaryInfo = classifyProviderError(primaryErr);
      if (!primaryInfo.transient) {
        throw primaryErr;
      }
      lastError = primaryErr;
      noteWasted(primaryErr);

      if (hasDistinctFallback && fallback) {
        try {
          const fallbackRes = withWasted(await opts.invoke(fallback));
          return {
            ...fallbackRes,
            fallback: {
              role: opts.role,
              from: formatModelLabel(opts.primaryModel),
              to: formatModelLabel(fallback),
              reason: primaryInfo.reason,
            },
          };
        } catch (fallbackErr) {
          const fbInfo = classifyProviderError(fallbackErr);
          if (!fbInfo.transient) {
            throw fallbackErr;
          }
          lastError = fallbackErr;
          noteWasted(fallbackErr);
        }
      }

      if (attempt < maxRetries) {
        const delayMs = computeBackoffMs(attempt, opts.retry);
        opts.retry?.onRetry?.({
          attempt: attempt + 1,
          delayMs,
          reason: primaryInfo.reason,
        });
        await sleepFn(delayMs);
      }
    }
  }

  if (wasted && lastError && typeof lastError === "object") {
    (lastError as { wastedUsage?: PromptUsage }).wastedUsage = wasted;
  }
  throw lastError;
}

function toOpencodeModel(ref?: ModelRef): { providerID: string; modelID: string } | undefined {
  return ref ? { providerID: ref.providerID, modelID: ref.id } : undefined;
}

/** Wraps an existing OpenCode client (embedded server, `opencode serve`, or plugin context). */
export function createOpencodeClientRunner(opts: {
  client: OpencodeClient;
  worktreeDir: string;
  config: RepoConfig;
  /** Implementer model override (the `--model` flag). Other roles are not affected. */
  model?: string;
  roleModels?: RoleModelOverrides;
  retry?: RetryOptions;
  /** Pricing used when OpenCode reports no cost (defaults to ~/.config/ai-ship/models.json + config.pricing). */
  pricing?: PricingTable;
  onClose?: () => void;
}): PipelineRunner {
  const pricing = opts.pricing ?? loadPricingTable(opts.config.pricing);
  const defaultProvider =
    opts.config.defaultProvider ?? opts.config.implementerModel?.providerID ?? "deepseek";
  const overrides: RoleModelOverrides = { ...opts.roleModels, ...(opts.model ? { implementer: opts.model } : {}) };

  const modelForRole = (role: AgentRole, override?: { providerID: string; modelID: string }) => {
    if (override) return override;
    const cli = parseOpencodeModel(overrides[role], defaultProvider);
    if (cli) return cli;
    return toOpencodeModel(roleConfigModel(opts.config, role));
  };

  const fallbackModelForRole = (role: AgentRole) => {
    const roleCfg =
      role === "implementer"
        ? opts.config.implementerFallbackModel
        : role === "tester"
          ? opts.config.testerFallbackModel
          : role === "bughunter"
            ? opts.config.bughunterFallbackModel
            : opts.config.reviewerFallbackModel;
    return toOpencodeModel(roleCfg);
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
    async prompt(
      sessionId: string,
      role: AgentRole,
      text: string,
      promptOpts?: PromptOptions
    ): Promise<PromptResult> {
      const primaryModel = modelForRole(role, promptOpts?.modelOverride);
      const fallbackModel = fallbackModelForRole(role);

      return executeWithFailoverAndRetry({
        role,
        primaryModel,
        fallbackModel,
        retry: opts.retry,
        invoke: async (model) => {
          const tools = isReadOnlyRole(role) ? { ...READ_ONLY_OPENCODE_TOOLS } : undefined;
          const res = await opts.client.session.prompt({
            path: { id: sessionId },
            query: { directory: opts.worktreeDir },
            body: {
              agent: role,
              ...(model ? { model } : {}),
              ...(tools ? { tools } : {}),
              parts: [{ type: "text", text }],
            },
          });
          const data = (res as { data?: PromptResponseData }).data;
          const servedBy = model
            ? `${model.providerID}/${model.modelID}`
            : data?.info?.providerID && data?.info?.modelID
              ? `${data.info.providerID}/${data.info.modelID}`
              : undefined;
          let parsed = parseOpencodePromptResponse(res as { data?: PromptResponseData; error?: unknown }, role);
          const parentID = data?.info?.parentID;
          if (parentID && opts.client.session.messages) {
            try {
              const list = await opts.client.session.messages({
                path: { id: sessionId },
                query: { directory: opts.worktreeDir },
              });
              const summed = sumStepUsage((list.data ?? []) as StepMessage[], parentID);
              if (summed) parsed = { ...parsed, usage: summed, usageSummary: formatUsageSummary(summed) };
            } catch (err) {
              // keep last-step usage, but say so: multi-step turns may be undercounted
              console.error(
                `[ai-ship] Warning: could not list session messages to sum step usage (${(err as Error).message}); cost may be undercounted.`
              );
            }
          }
          return assertNonEmptyReadOnlyReply(role, applyPricing(parsed, servedBy, pricing));
        },
      });
    },
    async compact(sessionId: string, role: AgentRole): Promise<boolean> {
      const model = modelForRole(role);
      if (!model || !opts.client.session.summarize) return false;
      try {
        const res = await opts.client.session.summarize({
          path: { id: sessionId },
          query: { directory: opts.worktreeDir },
          body: { providerID: model.providerID, modelID: model.modelID },
        });
        return !(res as { error?: unknown }).error;
      } catch {
        return false;
      }
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

const CF_NATIVE_GATEWAY_PROVIDERS = new Set([
  "deepseek",
  "openrouter",
  "openai",
  "anthropic",
  "groq",
  "mistral",
  "perplexity-ai",
  "google-ai-studio",
  "workers-ai",
]);

const CF_BARE_GATEWAY_RE = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[^/]+\/[^/]+$/i;

/** Provider routed through Context Lens: `contextLensProvider`, else the implementer's/default provider. */
export function resolveContextLensProvider(
  config: RepoConfig,
  available: readonly string[],
  implementerProvider?: string
): string | undefined {
  // An explicit choice (or the implementer's provider) wins even if it is an OpenCode built-in that is not
  // declared in `providers`; the caller then adds a provider entry carrying only the proxy baseURL.
  const preferred = config.contextLensProvider || implementerProvider || config.implementerModel?.providerID;
  if (preferred) return preferred;
  return (config.defaultProvider && available.includes(config.defaultProvider) ? config.defaultProvider : undefined) ?? available[0];
}

/** Settings that are ignored when ai-ship attaches to an existing OpenCode server or plugin client. */
export function describeIgnoredForAttachedServer(opts: {
  cfGatewayUrl?: string;
  contextLensUrl?: string;
  config: RepoConfig;
}): string[] {
  const ignored: string[] = [];
  if (opts.cfGatewayUrl) ignored.push("Cloudflare AI Gateway URL");
  if (opts.contextLensUrl) ignored.push("Context Lens proxy");
  if (opts.config.providers && Object.keys(opts.config.providers).length > 0) ignored.push(".ai-ship.json providers");
  ignored.push("read-only agent config for reviewer/bughunter (per-prompt tool restrictions still apply)");
  return ignored;
}

/**
 * Checks an attached server's agent config: reviewer/bughunter should deny edit and bash. Returns warnings.
 * ai-ship also disables write/edit/patch/bash per prompt, so this is defence in depth.
 */
export async function checkAttachedReadOnlyAgents(client: OpencodeClient): Promise<string[]> {
  try {
    const res = await (client as unknown as { config?: { get?: () => Promise<{ data?: unknown }> } }).config?.get?.();
    const agents = ((res?.data as { agent?: Record<string, { permission?: Record<string, unknown> }> } | undefined)
      ?.agent ?? {}) as Record<string, { permission?: Record<string, unknown> }>;
    const warnings: string[] = [];
    for (const role of ["reviewer", "bughunter"]) {
      const perm = agents[role]?.permission ?? {};
      const missing = (["edit", "bash", "webfetch"] as const).filter((k) => perm[k] !== "deny");
      if (!agents[role]) warnings.push(`attached server has no "${role}" agent; relying on per-prompt tool restrictions`);
      else if (missing.length > 0) {
        warnings.push(`attached server's "${role}" agent does not deny ${missing.join(", ")}; relying on per-prompt tool restrictions`);
      }
    }
    return warnings;
  } catch (err) {
    return [`could not read the attached server's agent config (${(err as Error).message})`];
  }
}

/** Builds OpenCode `config.provider` entries from `.ai-ship.json`, optional Cloudflare AI Gateway URL, and optional Context Lens proxy URL. */
export function buildOpencodeProviderConfig(
  config: RepoConfig,
  cfGatewayUrl?: string,
  contextLensUrl?: string,
  pricing: PricingTable = loadPricingTable(config.pricing),
  implementerProvider?: string
): Record<string, Record<string, unknown>> | undefined {
  const providers: Record<string, Record<string, unknown>> = {};
  const withCost = (providerId: string, models: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [modelId, def] of Object.entries(models)) {
      const price = findPricing(pricing, `${providerId}/${modelId}`);
      const base = def && typeof def === "object" ? (def as Record<string, unknown>) : {};
      out[modelId] = price && base.cost === undefined ? { ...base, cost: toOpencodeCost(price) } : base;
    }
    return out;
  };
  for (const [id, pCfg] of Object.entries(config.providers ?? {})) {
    const options = {
      ...(pCfg.baseURL ? { baseURL: pCfg.baseURL } : {}),
      ...(pCfg.options ?? {}),
    };
    providers[id] = {
      ...(pCfg.npm ? { npm: pCfg.npm } : {}),
      ...(pCfg.name ? { name: pCfg.name } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {}),
      ...(pCfg.models ? { models: withCost(id, pCfg.models) } : {}),
    };
  }

  if (cfGatewayUrl) {
    const trimmed = cfGatewayUrl.replace(/\/+$/, "");
    if (CF_BARE_GATEWAY_RE.test(trimmed)) {
      for (const id of Object.keys(providers)) {
        if (!CF_NATIVE_GATEWAY_PROVIDERS.has(id)) continue;
        const existingOpts = (providers[id].options as Record<string, unknown> | undefined) ?? {};
        providers[id].options = {
          ...existingOpts,
          baseURL: `${trimmed}/${id}`,
        };
      }
    } else {
      const targetProvider =
        trimmed.split("/").pop()?.toLowerCase() === "compat"
          ? undefined
          : trimmed.split("/").pop()?.toLowerCase();
      if (targetProvider && CF_NATIVE_GATEWAY_PROVIDERS.has(targetProvider)) {
        const prev = providers[targetProvider] ?? {};
        const existingOpts = (prev.options as Record<string, unknown> | undefined) ?? {};
        providers[targetProvider] = {
          ...prev,
          options: { ...existingOpts, baseURL: trimmed },
        };
      } else {
        const fallbackId = config.defaultProvider ?? config.implementerModel?.providerID ?? "deepseek";
        const prev = providers[fallbackId] ?? {};
        const existingOpts = (prev.options as Record<string, unknown> | undefined) ?? {};
        providers[fallbackId] = {
          ...prev,
          options: { ...existingOpts, baseURL: trimmed },
        };
      }
    }
  }

  if (contextLensUrl) {
    // A Context Lens proxy forwards to ONE upstream. Pointing every provider at it would send all providers'
    // requests to the same upstream (and drop the Cloudflare gateway URLs), so only route the chosen provider.
    const trimmed = contextLensUrl.replace(/\/+$/, "");
    const target = resolveContextLensProvider(config, Object.keys(providers), implementerProvider);
    if (target) {
      if (!providers[target]) {
        console.log(
          `[ai-ship] Context Lens provider "${target}" is not declared in providers; adding a proxy-only entry (check for a typo in "contextLensProvider" if unexpected).`
        );
      }
      const prev = providers[target] ?? {};
      const existingOpts = (prev.options as Record<string, unknown> | undefined) ?? {};
      providers[target] = { ...prev, options: { ...existingOpts, baseURL: trimmed } };
      const bypassed = Object.keys(providers).filter((id) => id !== target);
      console.log(
        `[ai-ship] Context Lens proxies provider "${target}"${bypassed.length ? `; not proxied: ${bypassed.join(", ")}` : ""} (set "contextLensProvider" to choose).`
      );
    }
  }

  return Object.keys(providers).length > 0 ? providers : undefined;
}

async function createOpencodeRunner(opts: {
  worktreeDir: string;
  config: RepoConfig;
  cfGatewayUrl?: string;
  contextLensUrl?: string;
  model?: string;
  roleModels?: RoleModelOverrides;
  serverUrl?: string;
  onGatewayUsage?: (u: EgressUsage) => void;
  gatewayMetadata?: Record<string, string>;
}): Promise<PipelineRunner> {
  if (opts.serverUrl) {
    const client = createOpencodeClient({ baseUrl: opts.serverUrl });
    return createOpencodeClientRunner({
      client,
      worktreeDir: opts.worktreeDir,
      config: opts.config,
      model: opts.model,
      roleModels: opts.roleModels,
    });
  }

  const implementerProvider = parseOpencodeModel(
    opts.roleModels?.implementer ?? opts.model,
    opts.config.defaultProvider ?? opts.config.implementerModel?.providerID ?? "deepseek"
  )?.providerID;
  const providerConfig = buildOpencodeProviderConfig(
    opts.config,
    opts.cfGatewayUrl,
    opts.contextLensUrl,
    undefined,
    implementerProvider
  );

  // Model catalog + Cloudflare AI Gateway: expose every enabled catalog model as `aig/<provider>/<model>`,
  // routed through the local egress proxy (adds gateway auth + metadata, reports usage).
  const { catalog, problems } = loadCatalog();
  for (const p of problems) console.log(`[ai-ship] models.json: ${p}`);
  let closeProxy: (() => Promise<void>) | undefined;
  if (catalog.gateway?.enabled) {
    const token = process.env[catalog.gateway.tokenEnv];
    if (!token) console.log(`[ai-ship] Warning: ${catalog.gateway.tokenEnv} is not set; gateway requests will be unauthenticated.`);
    const proxy = await startEgressProxy({
      upstreamBase: gatewayCompatUrl(catalog.gateway),
      token,
      metadata: () => ({ app: "ai-ship", ...(opts.gatewayMetadata ?? {}) }),
      onUsage: opts.onGatewayUsage,
    });
    closeProxy = proxy.close;
    const aig = buildGatewayProvider(catalog, { proxyUrl: proxy.url });
    if (aig) {
      const merged = providerConfig ?? {};
      merged[GATEWAY_PROVIDER_ID] = aig;
      console.log(`[ai-ship] Cloudflare AI Gateway: ${Object.keys((aig.models as object) ?? {}).length} catalog model(s) via ${GATEWAY_PROVIDER_ID}/<provider>/<model>`);
      return finishOpencodeRunner(opts, merged, closeProxy);
    }
  }
  return finishOpencodeRunner(opts, providerConfig, closeProxy);
}

async function finishOpencodeRunner(
  opts: { worktreeDir: string; config: RepoConfig; model?: string; roleModels?: RoleModelOverrides },
  providerConfig: Record<string, Record<string, unknown>> | undefined,
  closeProxy?: () => Promise<void>
): Promise<PipelineRunner> {
  const agentConfig = buildOpencodeAgentConfig();
  let started: Awaited<ReturnType<typeof createOpencode>>;
  try {
    started = await createOpencode({
      port: 0,
      config: {
        ...(providerConfig ? { provider: providerConfig as never } : {}),
        agent: agentConfig as never,
      },
    });
  } catch (err) {
    await closeProxy?.(); // do not leave the egress proxy listening
    throw err;
  }
  const { client, server } = started;

  return createOpencodeClientRunner({
    client,
    worktreeDir: opts.worktreeDir,
    config: opts.config,
    model: opts.model,
    roleModels: opts.roleModels,
    onClose: () => {
      server.close();
      void closeProxy?.();
    },
  });
}

export function createClaudeCodeRunner(opts: {
  worktreeDir: string;
  config?: RepoConfig;
  /** Implementer model override (the `--model` flag). */
  model?: string;
  roleModels?: RoleModelOverrides;
  /** Test seam: replaces spawning the `claude` CLI. */
  exec?: (cwd: string, args: string[], promptText: string) => Promise<string>;
}): PipelineRunner {
  const overrides: RoleModelOverrides = { ...opts.roleModels, ...(opts.model ? { implementer: opts.model } : {}) };
  const modelFor = (role: AgentRole) =>
    overrides[role] || opts.config?.claudeModels?.[role] || DEFAULT_CLAUDE_ROLE_MODELS[role];
  const exec = opts.exec ?? runClaudeCommand;
  const sessionMap = new Map<string, string | undefined>();
  let nextLocalId = 1;

  return {
    async createSession(_title: string): Promise<string> {
      const localId = `claude-local-${nextLocalId++}`;
      sessionMap.set(localId, undefined);
      return localId;
    },
    async prompt(sessionId: string, role: AgentRole, text: string): Promise<PromptResult> {
      return executeWithFailoverAndRetry({
        role,
        invoke: async () => {
          const resumeSessionId = sessionMap.get(sessionId);
          const args = buildClaudeArgs({ model: modelFor(role), role, resumeSessionId });
          const stdout = await exec(opts.worktreeDir, args, text);
          const parsed = parseClaudeJsonOutput(stdout);
          if (parsed.sessionId) {
            sessionMap.set(sessionId, parsed.sessionId);
          }
          return assertNonEmptyReadOnlyReply(role, {
            text: parsed.text,
            usageSummary: parsed.usageSummary,
            usage: parsed.usage,
          });
        },
      });
    },
    async compact(sessionId: string): Promise<boolean> {
      // claude-code: start a fresh CLI session on the next prompt (the pipeline re-states the task).
      if (!sessionMap.get(sessionId)) return false;
      sessionMap.set(sessionId, undefined);
      return true;
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
  contextLensUrl?: string;
  model?: string;
  roleModels?: RoleModelOverrides;
  serverUrl?: string;
  onGatewayUsage?: (u: EgressUsage) => void;
  gatewayMetadata?: Record<string, string>;
}): Promise<PipelineRunner> {
  if (opts.provider === "claude-code") {
    return createClaudeCodeRunner({
      worktreeDir: opts.worktreeDir,
      config: opts.config,
      model: opts.model,
      roleModels: opts.roleModels,
    });
  }
  return createOpencodeRunner({
    worktreeDir: opts.worktreeDir,
    config: opts.config,
    cfGatewayUrl: opts.cfGatewayUrl,
    contextLensUrl: opts.contextLensUrl,
    model: opts.model,
    roleModels: opts.roleModels,
    serverUrl: opts.serverUrl,
    onGatewayUsage: opts.onGatewayUsage,
    gatewayMetadata: opts.gatewayMetadata,
  });
}
