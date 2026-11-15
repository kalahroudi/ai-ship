import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Per-model token prices in USD per million tokens. Used when the provider/OpenCode does not report a cost
 * (OpenCode reports $0 for models missing from its models.dev catalog, e.g. custom openai-compatible or
 * Cloudflare AI Gateway /compat models), so the budget circuit breaker is not blind.
 */
export interface ModelPricing {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Date (YYYY-MM-DD) the prices were last checked against the provider's pricing page. */
  checked?: string;
}

export type PricingTable = Record<string, ModelPricing>;

export type CostSource = "provider" | "computed" | "unknown" | "none";

export interface UsageForCost {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead: number;
  cacheWrite?: number;
}

/** Path of the user-level models/pricing file (override with AI_SHIP_MODELS_FILE). */
export function getModelsFilePath(): string {
  return process.env.AI_SHIP_MODELS_FILE || path.join(os.homedir(), ".config", "ai-ship", "models.json");
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/** Validates and normalizes a raw pricing map, dropping entries without numeric `in`/`out` prices. */
export function normalizePricing(raw: unknown): PricingTable {
  const out: PricingTable = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    if (!isFiniteNonNegative(v.in) || !isFiniteNonNegative(v.out)) continue;
    out[key.trim()] = {
      in: v.in,
      out: v.out,
      ...(isFiniteNonNegative(v.cacheRead) ? { cacheRead: v.cacheRead } : {}),
      ...(isFiniteNonNegative(v.cacheWrite) ? { cacheWrite: v.cacheWrite } : {}),
      ...(typeof v.checked === "string" ? { checked: v.checked } : {}),
    };
  }
  return out;
}

/**
 * Loads the pricing table: `pricing` from ~/.config/ai-ship/models.json, overridden by `pricing` from the
 * repo config (loaded from the main repo, never the agent-writable worktree).
 */
export function loadPricingTable(repoPricing?: unknown, filePath = getModelsFilePath()): PricingTable {
  let fromFile: PricingTable = {};
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { pricing?: unknown };
      fromFile = normalizePricing(parsed?.pricing);
    }
  } catch (err) {
    console.error(`[ai-ship] Warning: could not read pricing from ${filePath}: ${(err as Error).message}`);
  }
  return { ...fromFile, ...normalizePricing(repoPricing) };
}

/**
 * Finds the price for a `provider/model` label: exact match, then case-insensitive, then a key that the label
 * ends with (so `cloudflare-ai-gateway/deepseek/deepseek-chat` matches a `deepseek/deepseek-chat` entry).
 */
export function findPricing(table: PricingTable, modelLabel: string | undefined): ModelPricing | undefined {
  if (!modelLabel) return undefined;
  if (table[modelLabel]) return table[modelLabel];
  const lower = modelLabel.toLowerCase();
  let best: { key: string; price: ModelPricing } | undefined;
  for (const [key, price] of Object.entries(table)) {
    const k = key.toLowerCase();
    if (k === lower) return price;
    if (lower.endsWith(`/${k}`) && (!best || k.length > best.key.length)) best = { key: k, price };
  }
  return best?.price;
}

/** Computes USD cost from token usage. Reasoning tokens are billed as output tokens. */
export function computeCost(usage: UsageForCost, price: ModelPricing): number {
  const perToken = (perMillion: number | undefined) => (perMillion ?? 0) / 1_000_000;
  return (
    usage.input * perToken(price.in) +
    (usage.output + (usage.reasoning ?? 0)) * perToken(price.out) +
    usage.cacheRead * perToken(price.cacheRead ?? price.in) +
    (usage.cacheWrite ?? 0) * perToken(price.cacheWrite ?? price.in)
  );
}

function totalTokens(u: UsageForCost): number {
  return u.input + u.output + (u.reasoning ?? 0) + u.cacheRead + (u.cacheWrite ?? 0);
}

/**
 * Resolves the cost of one call: the provider-reported cost when it is a positive number, otherwise a cost
 * computed from the pricing table. Returns source "unknown" when tokens were used but no price is known,
 * and "none" when nothing was used.
 */
export function resolveCost(
  usage: UsageForCost,
  providerCost: number | undefined,
  modelLabel: string | undefined,
  table: PricingTable
): { costUsd: number; costSource: CostSource } {
  if (typeof providerCost === "number" && Number.isFinite(providerCost) && providerCost > 0) {
    return { costUsd: providerCost, costSource: "provider" };
  }
  if (totalTokens(usage) === 0) return { costUsd: 0, costSource: "none" };
  const price = findPricing(table, modelLabel);
  if (!price) return { costUsd: 0, costSource: "unknown" };
  return { costUsd: computeCost(usage, price), costSource: "computed" };
}

/** Model labels (from `labels`) that have no pricing entry. */
export function findUnpricedModels(table: PricingTable, labels: Array<string | undefined>): string[] {
  const missing = new Set<string>();
  for (const l of labels) {
    if (l && !findPricing(table, l)) missing.add(l);
  }
  return [...missing];
}

/** OpenCode `models[].cost` block (USD per million tokens) for a price entry. */
export function toOpencodeCost(price: ModelPricing): Record<string, number> {
  // Same defaults as computeCost (cache billed at the input price when unset), so OpenCode and ai-ship agree.
  return {
    input: price.in,
    output: price.out,
    cache_read: price.cacheRead ?? price.in,
    cache_write: price.cacheWrite ?? price.in,
  };
}
