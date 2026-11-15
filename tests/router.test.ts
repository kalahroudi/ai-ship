import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { classifyTask, extractIdentifiers, parseNumstat, reclassifyFromDiff, type Classification } from "../src/classify.ts";
import { adjustTier, baseTier, formatRoutePlan, routeModels, scoreModel } from "../src/router.ts";
import { parseCatalog, type Catalog } from "../src/catalog.ts";
import { planRouting, runPipeline } from "../src/pipeline.ts";
import { parseCliArgs, DEFAULT_PROVIDERS, type RepoConfig } from "../src/config.ts";
import type { OpencodeClient } from "../src/runner.ts";

// Hermetic: temp models + ledger files, never the developer's real ones.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-router-"));
const modelsFile = path.join(tmp, "models.json");
const prev = { m: process.env.AI_SHIP_MODELS_FILE, l: process.env.AI_SHIP_LEDGER_FILE };
process.env.AI_SHIP_MODELS_FILE = modelsFile;
process.env.AI_SHIP_LEDGER_FILE = path.join(tmp, "ledger.jsonl");
process.on("exit", () => {
  for (const [k, v] of [["AI_SHIP_MODELS_FILE", prev.m], ["AI_SHIP_LEDGER_FILE", prev.l]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const RAW_MODELS = {
  models: [
    { id: "pa/small", family: "fa", tier: 1, pricing: { in: 1, out: 2 } },
    { id: "pa/big", family: "fa", tier: 3, pricing: { in: 10, out: 20 } },
    { id: "pb/small", family: "fb", tier: 1, pricing: { in: 1, out: 2 } },
    { id: "pb/mid", family: "fb", tier: 2, pricing: { in: 3, out: 6 } },
    { id: "pc/mid", family: "fc", tier: 2, pricing: { in: 3, out: 6 } },
    { id: "pc/big", family: "fc", tier: 3, pricing: { in: 10, out: 20 } },
  ],
};
const catalog = (extra: Record<string, unknown> = {}): Catalog => parseCatalog({ ...RAW_MODELS, ...extra }).catalog;
const cls = (o: Partial<Classification> = {}): Classification => ({ size: "M", risk: "med", kind: "feature", domains: [], estFiles: 0, confidence: 0.5, reasons: [], ...o });
const familyOf = (c: Catalog, ref: string) => c.models.find((m) => m.id === ref.replace(/^aig\//, ""))?.family;

// ---- classifier ----
test("classify: docs → S/low; auth fix → high risk; bullets → L/M; tags override", () => {
  const docs = classifyTask({ task: "Update the README with install steps" });
  assert.equal(docs.kind, "docs");
  assert.equal(docs.size, "S");
  assert.equal(docs.risk, "low");

  const auth = classifyTask({ task: "Fix login session bug" });
  assert.equal(auth.kind, "fix");
  assert.equal(auth.risk, "high");
  assert.ok(auth.domains.includes("auth"));

  const bullets = (n: number) => ["Add a thing", ...Array.from({ length: n }, (_, i) => `- step ${i}`)].join("\n");
  assert.equal(classifyTask({ task: bullets(2) }).size, "M");
  assert.equal(classifyTask({ task: bullets(6) }).size, "L");
  assert.equal(classifyTask({ task: "Add a thing" }).size, "S");
  assert.equal(classifyTask({ task: `Add ${"word ".repeat(260)}` }).size, "L");

  const t = classifyTask({ task: "Add a thing", tags: ["size:L", "risk:high", "bogus"] });
  assert.equal(t.size, "L");
  assert.equal(t.risk, "high");
  const t2 = classifyTask({ task: "Fix login session bug", tags: ["RISK:low"] });
  assert.equal(t2.risk, "low");
});

test("classify: estFiles counts git grep hits for extracted identifiers", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "repo-"));
  execSync("git init -q -b main", { cwd: dir });
  for (const f of ["a.ts", "b.ts", "c.ts"]) fs.writeFileSync(path.join(dir, f), "export const parseWidgetConfig = 1;\n");
  fs.writeFileSync(path.join(dir, "d.ts"), "nothing\n");
  execSync("git add -A", { cwd: dir });
  const c = classifyTask({ task: "Refactor `parseWidgetConfig` handling", repoDir: dir });
  assert.equal(c.estFiles, 3);
  assert.equal(c.size, "M"); // >2 files
  assert.deepEqual(extractIdentifiers("use `foo_bar` and FooBar here"), ["foo_bar", "FooBar"]);
});

test("reclassifyFromDiff only upgrades and flags sensitive paths", () => {
  const base = cls({ size: "M", risk: "low" });
  assert.equal(reclassifyFromDiff(base, { files: ["a.ts"], linesChanged: 5 }).size, "M");
  assert.equal(reclassifyFromDiff(base, { files: ["a.ts"], linesChanged: 400 }).size, "L");
  assert.equal(reclassifyFromDiff(cls({ size: "S" }), { files: ["a", "b", "c", "d"], linesChanged: 10 }).size, "M");
  assert.equal(reclassifyFromDiff(cls({ size: "S" }), { files: Array.from({ length: 13 }, (_, i) => `f${i}`), linesChanged: 1 }).size, "L");
  const s = reclassifyFromDiff(base, { files: ["src/auth/login.ts"], linesChanged: 3 });
  assert.equal(s.risk, "high");
  assert.deepEqual(parseNumstat("3\t2\tsrc/a.ts\n-\t-\timg.png\n"), { files: ["src/a.ts", "img.png"], linesChanged: 5 });
});

// ---- router ----
test("tier policy and adjustments", () => {
  assert.equal(baseTier("implementer", cls({ size: "S", risk: "low" })), 1);
  assert.equal(baseTier("implementer", cls({ size: "L" })), 3);
  assert.equal(baseTier("security", cls({ risk: "high" })), 3);
  assert.equal(adjustTier(2, { role: "implementer", risk: "low", budget: "GREEN", escalate: true }), 3);
  assert.equal(adjustTier(3, { role: "tester", risk: "low", budget: "RED" }), 1);
  assert.equal(adjustTier(3, { role: "implementer", risk: "low", budget: "STOP" }), 1);
  assert.equal(adjustTier(3, { role: "reviewer", risk: "low", budget: "AMBER" }), 2);
  assert.equal(adjustTier(3, { role: "security", risk: "high", budget: "AMBER" }), 3);
  const cheap = catalog().models[0];
  const unpriced = parseCatalog({ models: [{ id: "x/y", tier: 1 }] }).catalog.models[0];
  assert.ok(scoreModel(cheap, "implementer") > scoreModel(unpriced, "implementer"));
});

test("routeModels keeps all reviewing roles off the implementer's family", () => {
  const c = catalog();
  const plan = routeModels({ catalog: c, classification: cls({ size: "L", risk: "high" }), budget: "GREEN" });
  const impl = plan.decisions.implementer!;
  assert.equal(impl.tier, 3);
  const implFam = familyOf(c, impl.model);
  for (const role of ["tester", "reviewer", "security", "bughunter"] as const) {
    const d = plan.decisions[role]!;
    assert.ok(d, role);
    assert.notEqual(familyOf(c, d.model), implFam, `${role} family differs`);
    for (const fb of d.fallbacks) assert.notEqual(familyOf(c, fb), implFam, `${role} fallback family differs`);
  }
  assert.ok(formatRoutePlan(plan).some((l) => l.includes("implementer")));
});

test("routeModels: budget AMBER/RED, security protection, escalation", () => {
  const big = cls({ size: "L", risk: "high" });
  const amber = routeModels({ catalog: catalog(), classification: big, budget: "AMBER" });
  assert.equal(amber.decisions.implementer!.tier, 2);
  assert.equal(amber.decisions.security!.tier, 3, "security not downgraded on high risk");
  const red = routeModels({ catalog: catalog(), classification: big, budget: "RED" });
  assert.equal(red.decisions.implementer!.tier, 1);
  const med = cls({ size: "M", risk: "med" });
  const base = routeModels({ catalog: catalog(), classification: med, budget: "GREEN" });
  const esc = routeModels({ catalog: catalog(), classification: med, budget: "GREEN", escalate: true });
  assert.equal(base.decisions.implementer!.tier, 2);
  assert.equal(esc.decisions.implementer!.tier, 3);
  assert.notEqual(esc.decisions.implementer!.model, base.decisions.implementer!.model);
});

test("routeModels: fallbacks prefer other providers; gateway prefix; no-candidate note", () => {
  // Extra family fd with a same-provider sibling of the implementer's pick, so an allowed fallback exists.
  const c = catalog({ models: [...RAW_MODELS.models, { id: "pd/small", family: "fd", tier: 1 }, { id: "pa/other", family: "fa", tier: 1, pricing: { in: 1, out: 2 } }] });
  const plan = routeModels({ catalog: c, classification: cls({ size: "S", risk: "low" }), budget: "GREEN" });
  const impl = plan.decisions.implementer!;
  const prov = impl.catalogId.split("/")[0];
  assert.ok(impl.fallbacks.length > 0, "allowed fallback exists");
  assert.notEqual(impl.fallbacks[0].split("/")[0], prov, "other provider first");
  const gw = routeModels({ catalog: c, classification: cls(), budget: "GREEN", viaGateway: true });
  assert.match(gw.decisions.implementer!.model, /^aig\//);
  assert.ok(gw.decisions.implementer!.fallbacks.every((f) => f.startsWith("aig/")));
  assert.equal(gw.decisions.implementer!.catalogId.startsWith("aig/"), false);

  const single = parseCatalog({ models: [{ id: "pa/only", family: "fa", tier: 1 }] }).catalog;
  const p2 = routeModels({ catalog: single, classification: cls(), budget: "GREEN" });
  assert.ok(p2.decisions.implementer);
  assert.equal(p2.decisions.tester, undefined);
  assert.ok(p2.notes.some((n) => n.includes("no catalog model for tester")));
});

test("routeModels: implementer fallbacks never land on a reviewing role's primary family", () => {
  const c = parseCatalog({ models: [
    { id: "pa/small", family: "fa", tier: 1, pricing: { in: 1, out: 2 } },
    { id: "pb/small", family: "fb", tier: 1, pricing: { in: 1, out: 2 } },
    { id: "pb/mid", family: "fb", tier: 2 },
    { id: "pc/mid", family: "fc", tier: 2 },
  ] }).catalog;
  const plan = routeModels({ catalog: c, classification: cls({ size: "S", risk: "low" }), budget: "GREEN" });
  const d = plan.decisions;
  const implFam = familyOf(c, d.implementer!.model);
  const reviewFams = new Set(["tester", "reviewer", "security", "bughunter"].map((r) => familyOf(c, d[r as "tester"]!.model)));
  for (const fb of d.implementer!.fallbacks) assert.ok(!reviewFams.has(familyOf(c, fb)), `impl fallback ${fb} crosses`);
  for (const r of ["tester", "reviewer", "security", "bughunter"] as const) {
    for (const fb of d[r]!.fallbacks) assert.notEqual(familyOf(c, fb), implFam, `${r} fallback ${fb} crosses`);
  }
});

const REVIEWING = ["tester", "reviewer", "security", "bughunter"] as const;

test("classify: weak words are not high risk; precise patterns are; docs capped at med", () => {
  for (const t of ["Show token usage in the status bar", "Fix typo in README about the session picker", "Add zod schema validation"]) {
    assert.notEqual(classifyTask({ task: t }).risk, "high", t);
  }
  for (const t of ["Fix IDOR in org invite endpoint", "Add Stripe refund webhook handling", "Rotate signing keys for JWT"]) {
    assert.equal(classifyTask({ task: t }).risk, "high", t);
  }
  assert.notEqual(classifyTask({ task: "Update README: document the login and password flow" }).risk, "high");
  assert.ok(!extractIdentifiers("tweak `config` and `parseWidgetConfig`").includes("config"));
});

test("routeModels: pinned implementer is not routed and its family is excluded from reviewers", () => {
  const c = catalog();
  for (const pin of ["pa/big", "aig/pa/big"]) {
    const plan = routeModels({ catalog: c, classification: cls(), budget: "GREEN", pinnedImplementer: pin, viaGateway: pin.startsWith("aig/") });
    assert.equal(plan.decisions.implementer, undefined);
    for (const r of REVIEWING) {
      const d = plan.decisions[r]!;
      assert.notEqual(familyOf(c, d.model), "fa", `${r} avoids pinned family (${pin})`);
      for (const fb of d.fallbacks) assert.notEqual(familyOf(c, fb), "fa");
    }
  }
});

test("routeModels: fallbacks skip non-tool-calling models and trim after family filtering", () => {
  const c = parseCatalog({ models: [
    { id: "pa/impl", family: "fa", tier: 1, pricing: { in: 1, out: 1 } },
    { id: "pa/sib1", family: "fa", tier: 1, pricing: { in: 1, out: 1 } },
    { id: "pa/sib2", family: "fa", tier: 1, pricing: { in: 1, out: 1 } },
    { id: "pb/rev", family: "fb", tier: 1, pricing: { in: 1, out: 1 } },
    { id: "pc/nofn", family: "fc", tier: 1, toolCalling: false },
    { id: "pd/ok1", family: "fd", tier: 2, pricing: { in: 9, out: 9 } },
    { id: "pe/ok2", family: "fe", tier: 3, pricing: { in: 9, out: 9 } },
  ] }).catalog;
  const plan = routeModels({ catalog: c, classification: cls({ size: "S", risk: "low" }), budget: "GREEN" });
  const rev = plan.decisions.reviewer!;
  assert.ok(!rev.fallbacks.some((f) => f.includes("nofn")), "no non-tool-calling fallback");
  assert.ok(rev.fallbacks.every((f) => familyOf(c, f) !== "fa"), "same-family siblings filtered");
  assert.ok(rev.fallbacks.length <= 2);
  const implFb = plan.decisions.implementer!.fallbacks;
  assert.equal(implFb.length, 2, "implementer fallbacks trimmed to 2 after filtering");
  assert.ok(implFb.every((f) => familyOf(c, f) !== "fb" && !f.includes("nofn")));
  assert.ok(plan.decisions.implementer!.fallbacks.every((f) => !f.includes("nofn")));
});

// ---- planRouting ----
const baseCfg: RepoConfig = {
  baseBranch: "main", verify: [], testCommand: null, providers: DEFAULT_PROVIDERS, defaultProvider: "deepseek",
  maxFixRetries: 3, maxReviewRounds: 2, securityScan: true, safetyCheck: true,
};

test("planRouting: disabled without router flag or empty catalog; enabled otherwise", () => {
  fs.writeFileSync(modelsFile, JSON.stringify(RAW_MODELS));
  const off = planRouting({ config: baseCfg, task: "Add thing", repoDir: tmp });
  assert.equal(off.plan, undefined);
  assert.equal(off.classification.size, "S");
  const on = planRouting({ config: { ...baseCfg, router: true }, task: "Add thing", repoDir: tmp, tags: ["size:L"] });
  assert.equal(on.classification.size, "L");
  assert.ok(on.plan?.decisions.implementer);
  assert.ok(on.lines.length > 0);
  assert.equal(planRouting({ config: { ...baseCfg, router: false }, task: "Add thing", repoDir: tmp }).plan, undefined, "router:false (claude-code path)");
  fs.writeFileSync(modelsFile, JSON.stringify({ models: [{ id: "pa/x", tier: 1, enabled: false }] }));
  assert.equal(planRouting({ config: { ...baseCfg, router: true }, task: "x", repoDir: tmp }).plan, undefined);
});

// ---- CLI ----
test("parseCliArgs: --route and repeatable --tag", () => {
  const p = parseCliArgs(["--route", "--tag", "size:L", "--tag=risk:high", "do it"]);
  assert.equal(p.routeOnly, true);
  assert.deepEqual(p.tags, ["size:L", "risk:high"]);
  assert.equal(parseCliArgs(["task"]).routeOnly, false);
  assert.deepEqual(parseCliArgs(["task"]).tags, []);
});

// ---- pipeline ----
function initRepo(verifyOk: boolean): string {
  const dir = fs.mkdtempSync(path.join(tmp, "pipe-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync('git config user.email "t@example.com" && git config user.name T', { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# t\n");
  fs.writeFileSync(path.join(dir, ".ai-ship.json"), JSON.stringify({
    baseBranch: "main",
    verify: [verifyOk ? `node -e "process.exit(0)"` : `node -e "console.error('FAIL always');process.exit(1)"`],
    router: true, maxFixRetries: 3, maxReviewRounds: 1, reviewStaggerMs: 0, securityScan: false, safetyCheck: false,
    bughunter: false, maxTaskTokens: 1_000_000_000, maxTaskCostUsd: 100,
  }));
  execSync("git add -A && git commit -q -m init", { cwd: dir });
  return dir;
}

function modelClient() {
  const implModels: string[] = [];
  const implTexts: string[] = [];
  const titles = new Map<string, string>();
  let n = 0;
  const client = {
    session: {
      async create(req: { body: { title: string } }) {
        const id = `s-${++n}`;
        titles.set(id, req.body.title);
        return { data: { id } };
      },
      async prompt(req: { query: { directory: string }; body: { agent: string; model?: { providerID: string; modelID: string }; parts: Array<{ text: string }> } }) {
        let text = "Fine.\nVERDICT: CLEAN";
        if (req.body.agent === "implementer") {
          implModels.push(req.body.model ? `${req.body.model.providerID}/${req.body.model.modelID}` : "none");
          implTexts.push(req.body.parts[0].text);
          fs.mkdirSync(path.join(req.query.directory, "src"), { recursive: true });
          fs.writeFileSync(path.join(req.query.directory, "src/a.ts"), `export const v = ${implModels.length};\n`);
          text = "Implemented.";
        }
        return { data: { parts: [{ type: "text", text }], info: { cost: 0.001, tokens: { input: 5, output: 5, cache: { read: 0 } } } } };
      },
    },
  } as unknown as OpencodeClient;
  return { client, implModels, implTexts };
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const o = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = o; }
}

test("pipeline: routed model is used for the implementer; --model pin wins", async () => {
  fs.writeFileSync(modelsFile, JSON.stringify(RAW_MODELS));
  const dir = initRepo(true);
  try {
    const a = modelClient();
    const res = await quiet(() => runPipeline({ repoDir: dir, task: "Add feature", openPr: false, client: a.client, skipTests: true, skipBughunter: true }));
    assert.equal(a.implModels[0], "pa/small");
    assert.ok(res.classification);
    assert.ok(res.routing && res.routing.length > 0);

    const b = modelClient();
    await quiet(() => runPipeline({ repoDir: dir, task: "Add feature again", openPr: false, client: b.client, skipTests: true, skipBughunter: true, model: "pc/pinned" }));
    assert.equal(b.implModels[0], "pc/pinned");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: after 2 failed verify fixes the implementer escalates to a tier-up model outside reviewing families (once)", async () => {
  // pd/mid (family fd, pricey so reviewers never pick it) is the only higher-tier model no reviewing role uses.
  const RAW = { models: [...RAW_MODELS.models, { id: "pd/mid", family: "fd", tier: 2, pricing: { in: 50, out: 90 } }] };
  fs.writeFileSync(modelsFile, JSON.stringify(RAW));
  const dir = initRepo(false);
  try {
    const cat = catalog({ models: RAW.models });
    const plan = routeModels({ catalog: cat, classification: cls({ size: "S", risk: "low" }), budget: "GREEN" });
    const expected = plan.decisions.implementer!;
    const reviewingFams = new Set<string>();
    for (const r of REVIEWING) {
      reviewingFams.add(familyOf(cat, plan.decisions[r]!.model) ?? "");
      for (const fb of plan.decisions[r]!.fallbacks) reviewingFams.add(familyOf(cat, fb) ?? "");
    }
    const up = routeModels({ catalog: cat, classification: cls({ size: "S", risk: "low" }), budget: "GREEN", escalate: true, implementerExcludeFamilies: reviewingFams }).decisions.implementer!;
    assert.equal(up.tier, 2, "one tier up");
    assert.ok(!reviewingFams.has(familyOf(cat, up.model) ?? ""), "escalated model outside every reviewing family");
    assert.notEqual(up.model, expected.model);
    const c = modelClient();
    await assert.rejects(() => quiet(() => runPipeline({ repoDir: dir, task: "Add feature", openPr: false, client: c.client, skipTests: true, skipReview: true, skipBughunter: true })));
    assert.deepEqual(c.implModels.slice(0, 3), [expected.model, expected.model, expected.model]);
    assert.equal(c.implModels[3], up.model, "third fix prompt uses the escalated model");
    assert.ok(c.implModels.slice(3).every((m) => m === up.model));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
