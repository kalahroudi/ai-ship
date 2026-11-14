import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadRepoConfig } from "../src/config.ts";
import { slugify } from "../src/git.ts";

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-test-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  return dir;
}

test("slugify creates safe branch names", () => {
  assert.equal(slugify("Add Org Invite Rate-Limiting!"), "add-org-invite-rate-limiting");
  assert.equal(slugify("   "), "task");
});

test("loadRepoConfig auto-detects pnpm scripts", () => {
  const dir = makeTempRepo();
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      scripts: {
        typecheck: "tsc --noEmit",
        lint: "eslint .",
        test: "vitest run",
      },
    })
  );

  const cfg = loadRepoConfig(dir);
  assert.equal(cfg.baseBranch, "main");
  assert.deepEqual(cfg.verify.slice(0, 3), ["pnpm typecheck", "pnpm lint", "pnpm test"]);
  assert.equal(cfg.testCommand, "pnpm test");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadRepoConfig respects .ai-ship.json overrides", () => {
  const dir = makeTempRepo();
  fs.writeFileSync(
    path.join(dir, ".ai-ship.json"),
    JSON.stringify({
      baseBranch: "develop",
      verify: ["make test"],
      securityScan: false,
      maxFixRetries: 5,
    })
  );

  const cfg = loadRepoConfig(dir);
  assert.equal(cfg.baseBranch, "develop");
  assert.deepEqual(cfg.verify, ["make test"]);
  assert.equal(cfg.maxFixRetries, 5);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("templates/.ai-ship.json includes distinct multi-provider role models and provider defaults", () => {
  const dir = makeTempRepo();
  const templatePath = path.resolve(import.meta.dirname, "..", "templates", ".ai-ship.json");
  fs.copyFileSync(templatePath, path.join(dir, ".ai-ship.json"));

  const cfg = loadRepoConfig(dir);
  assert.deepEqual(cfg.implementerModel, { providerID: "deepseek", id: "deepseek-chat" });
  assert.deepEqual(cfg.testerModel, { providerID: "parasail", id: "Qwen/Qwen2.5-Coder-32B-Instruct" });
  assert.deepEqual(cfg.reviewerModel, { providerID: "deepseek", id: "deepseek-reasoner" });
  assert.equal(cfg.providers?.deepseek?.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.providers?.deepseek?.options?.baseURL, "https://api.deepseek.com/v1");
  assert.equal(cfg.providers?.parasail?.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.providers?.parasail?.options?.baseURL, "https://api.parasail.io/v1");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadRepoConfig prefers package.json verify script when present", () => {
  const dir = makeTempRepo();
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      scripts: { verify: "pnpm typecheck && pnpm guard && pnpm test", typecheck: "tsc", test: "vitest" },
    })
  );
  const cfg = loadRepoConfig(dir);
  assert.equal(cfg.verify[0], "pnpm verify");
  assert.ok(!cfg.verify.includes("pnpm typecheck"));
  assert.equal(cfg.testCommand, "pnpm test");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadRepoConfig defaults to DeepSeek Direct and Parasail.io when .ai-ship.json is absent", () => {
  const dir = makeTempRepo();
  const cfg = loadRepoConfig(dir);
  assert.deepEqual(cfg.implementerModel, { providerID: "deepseek", id: "deepseek-chat" });
  assert.deepEqual(cfg.testerModel, { providerID: "parasail", id: "Qwen/Qwen2.5-Coder-32B-Instruct" });
  assert.deepEqual(cfg.reviewerModel, { providerID: "deepseek", id: "deepseek-reasoner" });
  assert.equal(cfg.providers?.deepseek?.options?.baseURL, "https://api.deepseek.com/v1");
  assert.equal(cfg.providers?.parasail?.options?.baseURL, "https://api.parasail.io/v1");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadRepoConfig merges per-provider baseURL and custom providers from .ai-ship.json", () => {
  const dir = makeTempRepo();
  fs.writeFileSync(
    path.join(dir, ".ai-ship.json"),
    JSON.stringify({
      defaultProvider: "parasail",
      providers: {
        deepseek: {
          baseURL: "https://gateway.ai.cloudflare.com/v1/acct/gw/deepseek",
        },
        telnyx: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "https://api.telnyx.com/v2/ai",
            apiKey: "{env:TELNYX_API_KEY}",
          },
        },
      },
    })
  );

  const cfg = loadRepoConfig(dir);
  assert.equal(cfg.defaultProvider, "parasail");
  assert.equal(cfg.providers?.deepseek?.npm, "@ai-sdk/openai-compatible");
  assert.equal(
    cfg.providers?.deepseek?.options?.baseURL,
    "https://gateway.ai.cloudflare.com/v1/acct/gw/deepseek"
  );
  assert.equal(cfg.providers?.deepseek?.options?.apiKey, "{env:DEEPSEEK_API_KEY}");
  assert.equal(cfg.providers?.parasail?.options?.baseURL, "https://api.parasail.io/v1");
  assert.equal(cfg.providers?.telnyx?.options?.baseURL, "https://api.telnyx.com/v2/ai");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadRepoConfig prefers package.json verify script when present", () => {
  const dir = makeTempRepo();
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      scripts: { verify: "pnpm typecheck && pnpm guard && pnpm test", typecheck: "tsc", test: "vitest" },
    })
  );
  const cfg = loadRepoConfig(dir);
  assert.equal(cfg.verify[0], "pnpm verify");
  assert.ok(!cfg.verify.includes("pnpm typecheck"));
  assert.equal(cfg.testCommand, "pnpm test");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadRepoConfig appends pentest script to verify unless verify already includes it", () => {
  const dir = makeTempRepo();
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      scripts: {
        verify: "pnpm typecheck && pnpm test",
        pentest: "node scripts/pentest.mjs",
      },
    })
  );
  const cfg = loadRepoConfig(dir);
  assert.deepEqual(cfg.verify.slice(0, 2), ["pnpm verify", "pnpm pentest"]);

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      scripts: {
        verify: "pnpm typecheck && pnpm test && pnpm pentest",
        pentest: "node scripts/pentest.mjs",
      },
    })
  );
  const cfgAlreadyIncluded = loadRepoConfig(dir);
  assert.equal(cfgAlreadyIncluded.verify[0], "pnpm verify");
  assert.ok(!cfgAlreadyIncluded.verify.includes("pnpm pentest"));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadRepoConfig sets default budget thresholds and supports overrides or disabling", () => {
  const dir = makeTempRepo();
  const defaults = loadRepoConfig(dir);
  assert.equal(defaults.maxTaskCostUsd, 5);
  assert.equal(defaults.maxTaskTokens, 2_000_000);

  fs.writeFileSync(
    path.join(dir, ".ai-ship.json"),
    JSON.stringify({
      maxTaskCostUsd: 1.25,
      maxTaskTokens: 250000,
    })
  );
  const custom = loadRepoConfig(dir);
  assert.equal(custom.maxTaskCostUsd, 1.25);
  assert.equal(custom.maxTaskTokens, 250000);

  fs.writeFileSync(
    path.join(dir, ".ai-ship.json"),
    JSON.stringify({
      maxTaskCostUsd: null,
      maxTaskTokens: 0,
    })
  );
  const disabled = loadRepoConfig(dir);
  assert.equal(disabled.maxTaskCostUsd, undefined);
  assert.equal(disabled.maxTaskTokens, undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});
