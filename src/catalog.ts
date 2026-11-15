import fs from "node:fs";
import { getModelsFilePath, normalizePricing, type ModelPricing, type PricingTable } from "./pricing.ts";

/**
 * Model catalog: one source of truth for the models ai-ship may route to, read from the same
 * `~/.config/ai-ship/models.json` that holds pricing (`AI_SHIP_MODELS_FILE` overrides the path):
 *
 * {
 *   "gateway": { "accountId": "<your-account-id>", "gatewayId": "<your-gateway-id>", "tokenEnv": "CF_AIG_TOKEN", "enabled": true },
 *   "fx": { "GBPUSD": 1.27 },
 *   "models": [ { "id": "deepseek/deepseek-chat", "family": "deepseek", "tier": 1, "context": 128000,
 *                 "pricing": { "in": 0, "out": 0 }, "strengths": { "implement": 0.6 }, "toolCalling": true,
 *                 "maxConcurrency": 4, "enabled": true } ]
 * }
 *
 * Model ids use the Cloudflare AI Gateway `/compat` naming (`<provider>/<model>`); through the gateway they are
 * addressed in OpenCode as `aig/<provider>/<model>`.
 */

export type Tier = 1 | 2 | 3;
export type RoleStrength = "implement" | "test" | "review" | "reason";

export interface CatalogModel {
  id: string;
  name?: string;
  family?: string;
  tier: Tier;
  context?: number;
  outputLimit?: number;
  pricing?: ModelPricing;
  strengths?: Partial<Record<RoleStrength, number>>;
  toolCalling?: boolean;
  maxConcurrency?: number;
  rpm?: number;
  enabled: boolean;
}

export interface GatewayConfig {
  accountId: string;
  gatewayId: string;
  tokenEnv: string;
  enabled: boolean;
  /** Override for tests or other gateway hosts (default https://gateway.ai.cloudflare.com/v1). */
  baseUrl?: string;
}

export interface Catalog {
  gateway?: GatewayConfig;
  fx: { GBPUSD: number };
  models: CatalogModel[];
}

export const GATEWAY_PROVIDER_ID = "aig";
export const DEFAULT_GBPUSD = 1.27;

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Validates a raw catalog object; returns the normalized catalog and human-readable problems. */
export function parseCatalog(raw: unknown): { catalog: Catalog; problems: string[] } {
  const problems: string[] = [];
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let gateway: GatewayConfig | undefined;
  const g = obj.gateway as Record<string, unknown> | undefined;
  if (g && typeof g === "object") {
    if (typeof g.accountId !== "string" || typeof g.gatewayId !== "string") {
      problems.push("gateway: accountId and gatewayId must be strings");
    } else {
      gateway = {
        accountId: g.accountId,
        gatewayId: g.gatewayId,
        tokenEnv: typeof g.tokenEnv === "string" && g.tokenEnv ? g.tokenEnv : "CF_AIG_TOKEN",
        enabled: g.enabled !== false,
        ...(typeof g.baseUrl === "string" ? { baseUrl: g.baseUrl } : {}),
      };
    }
  }
  const fxRaw = (obj.fx as Record<string, unknown> | undefined)?.GBPUSD;
  const fx = { GBPUSD: isNum(fxRaw) && fxRaw > 0 ? fxRaw : DEFAULT_GBPUSD };
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const [i, m] of (Array.isArray(obj.models) ? obj.models : []).entries()) {
    const r = (m ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id.includes("/")) {
      problems.push(`models[${i}]: id must be "<provider>/<model>"`);
      continue;
    }
    if (seen.has(r.id)) {
      problems.push(`models[${i}]: duplicate id ${r.id}`);
      continue;
    }
    seen.add(r.id);
    const tier = r.tier === 1 || r.tier === 2 || r.tier === 3 ? r.tier : undefined;
    if (!tier) problems.push(`models[${i}] ${r.id}: tier must be 1, 2 or 3 (defaulting to 2)`);
    const pricing = r.pricing ? normalizePricing({ [r.id]: r.pricing })[r.id] : undefined;
    if (r.pricing && !pricing) problems.push(`models[${i}] ${r.id}: pricing needs numeric "in" and "out"`);
    const strengths: Partial<Record<RoleStrength, number>> = {};
    for (const k of ["implement", "test", "review", "reason"] as const) {
      const v = (r.strengths as Record<string, unknown> | undefined)?.[k];
      if (isNum(v)) strengths[k] = Math.max(0, Math.min(1, v));
    }
    models.push({
      id: r.id,
      ...(typeof r.name === "string" ? { name: r.name } : {}),
      family: typeof r.family === "string" ? r.family : r.id.split("/")[0],
      tier: tier ?? 2,
      ...(isNum(r.context) ? { context: r.context } : {}),
      ...(isNum(r.outputLimit) ? { outputLimit: r.outputLimit } : {}),
      ...(pricing ? { pricing } : {}),
      strengths,
      toolCalling: r.toolCalling !== false,
      ...(isNum(r.maxConcurrency) ? { maxConcurrency: r.maxConcurrency } : {}),
      ...(isNum(r.rpm) ? { rpm: r.rpm } : {}),
      enabled: r.enabled !== false,
    });
  }
  return { catalog: { ...(gateway ? { gateway } : {}), fx, models }, problems };
}

/** Loads the catalog from the models file (missing file → empty catalog). */
export function loadCatalog(filePath = getModelsFilePath()): { catalog: Catalog; problems: string[] } {
  try {
    if (!fs.existsSync(filePath)) return { catalog: { fx: { GBPUSD: DEFAULT_GBPUSD }, models: [] }, problems: [] };
    return parseCatalog(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (err) {
    return { catalog: { fx: { GBPUSD: DEFAULT_GBPUSD }, models: [] }, problems: [`could not read ${filePath}: ${(err as Error).message}`] };
  }
}

/** Pricing entries derived from catalog models, keyed both as `<provider>/<model>` and `aig/<provider>/<model>`. */
export function catalogPricing(catalog: Catalog): PricingTable {
  const out: PricingTable = {};
  for (const m of catalog.models) {
    if (!m.pricing) continue;
    out[m.id] = m.pricing;
    out[`${GATEWAY_PROVIDER_ID}/${m.id}`] = m.pricing;
  }
  return out;
}

/** Cloudflare AI Gateway OpenAI-compatible endpoint for a gateway config. */
export function gatewayCompatUrl(g: GatewayConfig): string {
  const base = (g.baseUrl ?? "https://gateway.ai.cloudflare.com/v1").replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(g.accountId)}/${encodeURIComponent(g.gatewayId)}/compat`;
}

/**
 * OpenCode `provider` entry routing every enabled catalog model through the Cloudflare AI Gateway `/compat`
 * endpoint (or through the local egress proxy when `proxyUrl` is given). Models carry `cost` and `limit` so
 * OpenCode lists them and computes costs; provider keys stay in Cloudflare (BYOK).
 */
export function buildGatewayProvider(catalog: Catalog, opts: { proxyUrl?: string } = {}): Record<string, unknown> | undefined {
  const g = catalog.gateway;
  if (!g || !g.enabled) return undefined;
  const models: Record<string, unknown> = {};
  for (const m of catalog.models) {
    if (!m.enabled) continue;
    models[m.id] = {
      name: m.name ?? `${m.id} (gateway)`,
      ...(m.pricing
        ? {
            cost: {
              input: m.pricing.in,
              output: m.pricing.out,
              cache_read: m.pricing.cacheRead ?? m.pricing.in,
              cache_write: m.pricing.cacheWrite ?? m.pricing.in,
            },
          }
        : {}),
      ...(m.context ? { limit: { context: m.context, output: m.outputLimit ?? Math.min(32_000, m.context) } } : {}),
      tool_call: m.toolCalling !== false,
    };
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Cloudflare AI Gateway",
    options: {
      baseURL: opts.proxyUrl ?? gatewayCompatUrl(g),
      // The proxy adds the gateway auth header itself; direct calls use OpenCode's {env:...} substitution.
      ...(opts.proxyUrl ? {} : { headers: { "cf-aig-authorization": `Bearer {env:${g.tokenEnv}}` } }),
      apiKey: "gateway",
      // ask @ai-sdk/openai-compatible to request usage on streamed responses (stream_options.include_usage)
      includeUsage: true,
    },
    models,
  };
}

/** One line per model for `ai-ship --models`. */
export function formatCatalog(catalog: Catalog): string[] {
  const lines = [
    catalog.gateway
      ? `Gateway: ${catalog.gateway.accountId}/${catalog.gateway.gatewayId} (${catalog.gateway.enabled ? "enabled" : "disabled"}, token env ${catalog.gateway.tokenEnv})`
      : "Gateway: not configured",
  ];
  for (const m of catalog.models) {
    const price = m.pricing ? `$${m.pricing.in}/$${m.pricing.out} per Mtok` : "no price";
    lines.push(`${m.enabled ? "✔" : "·"} T${m.tier} ${m.id} [${m.family}] ${price}${m.context ? ` ctx=${m.context}` : ""}`);
  }
  return lines;
}

/**
 * Sends a 1-token chat completion per enabled model through the gateway to check reachability and latency.
 * `fetchImpl` is injectable for tests.
 */
export async function syncCatalog(
  catalog: Catalog,
  opts: { token?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<Array<{ id: string; ok: boolean; ms: number; detail: string }>> {
  const g = catalog.gateway;
  if (!g) throw new Error("no gateway configured in models.json");
  const token = opts.token ?? process.env[g.tokenEnv];
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${gatewayCompatUrl(g)}/chat/completions`;
  const out: Array<{ id: string; ok: boolean; ms: number; detail: string }> = [];
  for (const m of catalog.models.filter((x) => x.enabled)) {
    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "cf-aig-authorization": `Bearer ${token}` } : {}),
          "cf-aig-metadata": JSON.stringify({ app: "ai-ship", purpose: "models-sync" }),
        },
        body: JSON.stringify({ model: m.id, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      out.push({ id: m.id, ok: res.ok, ms: Date.now() - started, detail: res.ok ? "ok" : `HTTP ${res.status}` });
    } catch (err) {
      out.push({ id: m.id, ok: false, ms: Date.now() - started, detail: (err as Error).message });
    }
  }
  return out;
}
