import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildGatewayProvider,
  catalogPricing,
  formatCatalog,
  gatewayCompatUrl,
  loadCatalog,
  parseCatalog,
  syncCatalog,
} from "../src/catalog.ts";
import { loadPricingTable } from "../src/pricing.ts";
import { parseCliArgs } from "../src/config.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aiship-cat-"));
}

const GW = { accountId: "acc", gatewayId: "gw" };

test("parseCatalog: gateway defaults, fx default, model defaults", () => {
  const { catalog, problems } = parseCatalog({
    gateway: GW,
    models: [{ id: "deepseek/deepseek-chat", strengths: { implement: 5, test: -2, review: 0.5 } }],
  });
  assert.deepEqual(problems.length, 1); // missing tier
  assert.match(problems[0], /tier/);
  assert.equal(catalog.gateway?.tokenEnv, "CF_AIG_TOKEN");
  assert.equal(catalog.gateway?.enabled, true);
  assert.equal(catalog.fx.GBPUSD, 1.27);
  const m = catalog.models[0];
  assert.equal(m.tier, 2);
  assert.equal(m.family, "deepseek");
  assert.equal(m.enabled, true);
  assert.equal(m.strengths?.implement, 1);
  assert.equal(m.strengths?.test, 0);
  assert.equal(m.strengths?.review, 0.5);
});

test("parseCatalog: invalid gateway, bad ids, duplicates, bad tier, null pricing", () => {
  const r = parseCatalog({
    gateway: { accountId: 1 },
    fx: { GBPUSD: 1.4 },
    models: [
      { id: "nosep", tier: 1 },
      { id: "a/b", tier: 3, pricing: { in: 1, out: 2 } },
      { id: "a/b", tier: 1 },
      { id: "c/d", tier: 9 },
      { id: "e/f", tier: 1, pricing: { in: null, out: null } },
    ],
  });
  assert.equal(r.catalog.gateway, undefined);
  assert.equal(r.catalog.fx.GBPUSD, 1.4);
  assert.deepEqual(r.catalog.models.map((m) => m.id), ["a/b", "c/d", "e/f"]);
  assert.equal(r.catalog.models[0].pricing?.out, 2);
  assert.equal(r.catalog.models[1].tier, 2);
  assert.equal(r.catalog.models[2].pricing, undefined);
  const joined = r.problems.join("\n");
  assert.match(joined, /accountId and gatewayId/);
  assert.match(joined, /<provider>\/<model>/);
  assert.match(joined, /duplicate id a\/b/);
  assert.match(joined, /c\/d: tier/);
  assert.match(joined, /e\/f: pricing/);
});

test("loadCatalog: missing file, bad JSON, good file", () => {
  const d = tmp();
  const missing = loadCatalog(path.join(d, "nope.json"));
  assert.deepEqual(missing.catalog.models, []);
  assert.deepEqual(missing.problems, []);
  const bad = path.join(d, "bad.json");
  fs.writeFileSync(bad, "{oops");
  const r = loadCatalog(bad);
  assert.equal(r.catalog.models.length, 0);
  assert.equal(r.problems.length, 1);
  const good = path.join(d, "good.json");
  fs.writeFileSync(good, JSON.stringify({ models: [{ id: "x/y", tier: 1 }] }));
  assert.equal(loadCatalog(good).catalog.models[0].id, "x/y");
});

test("templates/models.json: gateway disabled, null prices give problems but models load", () => {
  const { catalog, problems } = loadCatalog(path.resolve("templates/models.json"));
  assert.equal(catalog.gateway?.enabled, false);
  assert.equal(catalog.models.length, 5);
  assert.ok(catalog.models.every((m) => m.pricing === undefined));
  assert.ok(problems.length >= 5);
  assert.ok(problems.every((p) => /pricing/.test(p)));
  assert.equal(buildGatewayProvider(catalog), undefined);
});

test("catalogPricing and loadPricingTable cover id and aig/id", () => {
  const raw = { models: [{ id: "a/b", tier: 1, pricing: { in: 1, out: 2 } }, { id: "c/d", tier: 1 }] };
  const { catalog } = parseCatalog(raw);
  const p = catalogPricing(catalog);
  assert.deepEqual(Object.keys(p).sort(), ["a/b", "aig/a/b"]);
  assert.equal(p["aig/a/b"].in, 1);
  const f = path.join(tmp(), "m.json");
  fs.writeFileSync(f, JSON.stringify(raw));
  const t = loadPricingTable(undefined, f);
  assert.equal(t["a/b"].out, 2);
  assert.equal(t["aig/a/b"].out, 2);
  assert.equal(t["c/d"], undefined);
});

test("gatewayCompatUrl", () => {
  assert.equal(
    gatewayCompatUrl({ ...GW, tokenEnv: "T", enabled: true }),
    "https://gateway.ai.cloudflare.com/v1/acc/gw/compat"
  );
  assert.equal(
    gatewayCompatUrl({ ...GW, tokenEnv: "T", enabled: true, baseUrl: "http://x:1/v1//" }),
    "http://x:1/v1/acc/gw/compat"
  );
});

test("buildGatewayProvider: direct vs proxy, enabled models only, cost and limit", () => {
  const { catalog } = parseCatalog({
    gateway: { ...GW, tokenEnv: "MY_TOK" },
    models: [
      { id: "a/b", tier: 1, context: 100000, pricing: { in: 1, out: 2, cacheRead: 0.1 } },
      { id: "c/d", tier: 1, enabled: false },
      { id: "e/f", tier: 1 },
    ],
  });
  const p = buildGatewayProvider(catalog) as any;
  assert.deepEqual(Object.keys(p.models), ["a/b", "e/f"]);
  assert.deepEqual(p.models["a/b"].cost, { input: 1, output: 2, cache_read: 0.1, cache_write: 1 });
  assert.equal(p.models["a/b"].limit.context, 100000);
  assert.equal(p.models["e/f"].cost, undefined);
  assert.equal(p.options.baseURL, "https://gateway.ai.cloudflare.com/v1/acc/gw/compat");
  assert.equal(p.options.headers["cf-aig-authorization"], "Bearer {env:MY_TOK}");
  assert.equal(p.options.includeUsage, true);
  const px = buildGatewayProvider(catalog, { proxyUrl: "http://127.0.0.1:9" }) as any;
  assert.equal(px.options.baseURL, "http://127.0.0.1:9");
  assert.equal(px.options.headers, undefined);
  const off = parseCatalog({ gateway: { ...GW, enabled: false }, models: [] }).catalog;
  assert.equal(buildGatewayProvider(off), undefined);
  assert.equal(buildGatewayProvider(parseCatalog({}).catalog), undefined);
});

test("formatCatalog", () => {
  const lines = formatCatalog(
    parseCatalog({ gateway: GW, models: [{ id: "a/b", tier: 1, pricing: { in: 1, out: 2 } }, { id: "c/d", tier: 3, enabled: false }] }).catalog
  );
  assert.match(lines[0], /acc\/gw \(enabled/);
  assert.match(lines[1], /T1 a\/b .*\$1\/\$2 per Mtok/);
  assert.match(lines[2], /T3 c\/d .*no price/);
  assert.match(formatCatalog(parseCatalog({}).catalog)[0], /not configured/);
});

test("syncCatalog: one request per enabled model with gateway auth; errors reported", async () => {
  const { catalog } = parseCatalog({
    gateway: GW,
    models: [{ id: "a/b", tier: 1 }, { id: "c/d", tier: 1, enabled: false }, { id: "e/f", tier: 1 }],
  });
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, init });
    const model = JSON.parse(init.body).model;
    if (model === "e/f") return new Response("no", { status: 500 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const res = await syncCatalog(catalog, { token: "tok", fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://gateway.ai.cloudflare.com/v1/acc/gw/compat/chat/completions");
  assert.equal(calls[0].init.headers["cf-aig-authorization"], "Bearer tok");
  assert.equal(JSON.parse(calls[0].init.body).max_tokens, 1);
  assert.deepEqual(res.map((r) => [r.id, r.ok, r.detail]), [["a/b", true, "ok"], ["e/f", false, "HTTP 500"]]);
  const thrower = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
  const r2 = await syncCatalog(catalog, { token: "t", fetchImpl: thrower });
  assert.equal(r2[0].ok, false);
  assert.equal(r2[0].detail, "boom");
  await assert.rejects(syncCatalog(parseCatalog({}).catalog), /no gateway/);
});

test("parseCliArgs: --models flags", () => {
  assert.equal(parseCliArgs(["--models"]).modelsAction, "list");
  assert.equal(parseCliArgs(["--models-sync"]).modelsAction, "sync");
  assert.equal(parseCliArgs(["--models-opencode-config"]).modelsAction, "opencode-config");
});
