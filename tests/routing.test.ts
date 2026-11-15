import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOpencodeProviderConfig,
  checkAttachedReadOnlyAgents,
  describeIgnoredForAttachedServer,
  resolveContextLensProvider,
  type OpencodeClient,
} from "../src/runner.ts";
import { DEFAULT_PROVIDERS, parseCliArgs, type RepoConfig } from "../src/config.ts";

const prevModelsFile = process.env.AI_SHIP_MODELS_FILE;
process.env.AI_SHIP_MODELS_FILE = path.join(os.tmpdir(), `ai-ship-no-models-${process.pid}.json`);
process.on("exit", () => {
  if (prevModelsFile === undefined) delete process.env.AI_SHIP_MODELS_FILE;
  else process.env.AI_SHIP_MODELS_FILE = prevModelsFile;
});

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
const urlOf = (c: ReturnType<typeof buildOpencodeProviderConfig>, id: string) =>
  (c?.[id]?.options as Record<string, unknown> | undefined)?.baseURL;

function quietly<T>(fn: () => T): { result: T; logs: string[] } {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    return { result: fn(), logs };
  } finally {
    console.log = orig;
  }
}

test("context lens routes only the implementer provider and keeps the CF gateway URL on others", () => {
  const cfg: RepoConfig = { ...baseCfg, implementerModel: { providerID: "parasail", id: "x" } };
  const { result, logs } = quietly(() =>
    buildOpencodeProviderConfig(cfg, "https://gateway.ai.cloudflare.com/v1/acct/gw", "http://localhost:4040/")
  );
  assert.equal(urlOf(result, "parasail"), "http://localhost:4040");
  assert.equal(urlOf(result, "deepseek"), "https://gateway.ai.cloudflare.com/v1/acct/gw/deepseek");
  assert.ok(logs.some((l) => l.includes("deepseek") && l.includes("not proxied")));
});

test("undeclared implementer provider gets a lens-only entry; single provider still logs", () => {
  const { result, logs } = quietly(() =>
    buildOpencodeProviderConfig(baseCfg, undefined, "http://localhost:4040/", undefined, "anthropic")
  );
  assert.equal(urlOf(result, "anthropic"), "http://localhost:4040");
  assert.equal(urlOf(result, "deepseek"), "https://api.deepseek.com/v1");
  assert.ok(logs.some((l) => l.includes("anthropic")));
  const single: RepoConfig = { ...baseCfg, providers: { deepseek: DEFAULT_PROVIDERS.deepseek } };
  const r2 = quietly(() => buildOpencodeProviderConfig(single, undefined, "http://localhost:4040"));
  assert.equal(urlOf(r2.result, "deepseek"), "http://localhost:4040");
  assert.ok(r2.logs.some((l) => l.includes("deepseek")));
});

test("contextLensProvider overrides the implementer provider", () => {
  const cfg: RepoConfig = {
    ...baseCfg,
    implementerModel: { providerID: "parasail", id: "x" },
    contextLensProvider: "deepseek",
  };
  const { result } = quietly(() => buildOpencodeProviderConfig(cfg, undefined, "http://localhost:4040"));
  assert.equal(urlOf(result, "deepseek"), "http://localhost:4040");
  assert.equal(urlOf(result, "parasail"), "https://api.parasail.io/v1");
});

test("resolveContextLensProvider falls back: override, implementer, default, first", () => {
  const avail = ["a", "b", "c"];
  const mk = (o: Partial<RepoConfig>): RepoConfig => ({ ...baseCfg, ...o });
  assert.equal(resolveContextLensProvider(mk({ contextLensProvider: "c", defaultProvider: "b" }), avail), "c");
  assert.equal(
    resolveContextLensProvider(mk({ implementerModel: { providerID: "b", id: "m" }, defaultProvider: "a" }), avail),
    "b"
  );
  assert.equal(resolveContextLensProvider(mk({ defaultProvider: "c" }), avail), "c");
  // explicit/implementer choices win even when not declared in `available`
  assert.equal(resolveContextLensProvider(mk({ contextLensProvider: "zzz" }), avail), "zzz");
  assert.equal(resolveContextLensProvider(mk({ defaultProvider: "a" }), avail, "anthropic"), "anthropic");
  // default only if available, else first
  assert.equal(resolveContextLensProvider(mk({ defaultProvider: "qqq" }), avail), "a");
  assert.equal(resolveContextLensProvider(mk({}), []), undefined);
});

test("describeIgnoredForAttachedServer lists only the settings actually set", () => {
  const none = describeIgnoredForAttachedServer({ config: { ...baseCfg, providers: undefined } });
  assert.equal(none.length, 1);
  assert.match(none[0], /read-only agent config/);
  const all = describeIgnoredForAttachedServer({
    cfGatewayUrl: "https://gw",
    contextLensUrl: "http://lens",
    config: baseCfg,
  });
  assert.ok(all.includes("Cloudflare AI Gateway URL"));
  assert.ok(all.includes("Context Lens proxy"));
  assert.ok(all.includes(".ai-ship.json providers"));
});

const fakeClient = (get: () => Promise<unknown>) => ({ config: { get } }) as unknown as OpencodeClient;
const deny = { permission: { edit: "deny", bash: "deny", webfetch: "deny" } };

test("checkAttachedReadOnlyAgents: correct deny yields no warnings", async () => {
  const w = await checkAttachedReadOnlyAgents(
    fakeClient(async () => ({ data: { agent: { reviewer: deny, bughunter: deny } } }))
  );
  assert.deepEqual(w, []);
});

test("checkAttachedReadOnlyAgents: missing agent warns", async () => {
  const w = await checkAttachedReadOnlyAgents(fakeClient(async () => ({ data: { agent: { reviewer: deny } } })));
  assert.equal(w.length, 1);
  assert.match(w[0], /no "bughunter" agent/);
});

test("checkAttachedReadOnlyAgents: permissive agent warns about edit and bash", async () => {
  const w = await checkAttachedReadOnlyAgents(
    fakeClient(async () => ({
      data: { agent: { reviewer: { permission: { edit: "allow", bash: "allow", webfetch: "deny" } }, bughunter: { permission: { edit: "deny", bash: "ask", webfetch: "deny" } } } },
    }))
  );
  assert.equal(w.length, 2);
  assert.match(w[0], /"reviewer".*edit.*bash/);
  assert.match(w[1], /"bughunter".*bash/);
  assert.doesNotMatch(w[1], /edit/);
});

test("checkAttachedReadOnlyAgents: webfetch not denied warns", async () => {
  const noWf = { permission: { edit: "deny", bash: "deny" } };
  const w = await checkAttachedReadOnlyAgents(
    fakeClient(async () => ({ data: { agent: { reviewer: noWf, bughunter: deny } } }))
  );
  assert.equal(w.length, 1);
  assert.match(w[0], /"reviewer".*webfetch/);
});

test("checkAttachedReadOnlyAgents: config.get throwing yields a single warning", async () => {
  const w = await checkAttachedReadOnlyAgents(
    fakeClient(async () => {
      throw new Error("boom");
    })
  );
  assert.equal(w.length, 1);
  assert.match(w[0], /boom/);
});

test("parseCliArgs --cf consumes a known provider but never the task text", () => {
  const dir = os.tmpdir();
  const known = parseCliArgs(["--cf", "acct", "gw", "deepseek", "Fix login"], dir);
  assert.deepEqual(known.cfArgs, { accountId: "acct", gatewayId: "gw", provider: "deepseek" });
  assert.deepEqual(known.positional, ["Fix login"]);

  const task = parseCliArgs(["--cf", "acct", "gw", "fix login"], dir);
  assert.deepEqual(task.cfArgs, { accountId: "acct", gatewayId: "gw", provider: undefined });
  assert.deepEqual(task.positional, ["fix login"]);

  const noThird = parseCliArgs(["--cf", "acct", "gw"], dir);
  assert.equal(noThird.cfArgs?.provider, undefined);
});
