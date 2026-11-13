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

test("templates/.ai-ship.json includes distinct openrouter role models", () => {
  const dir = makeTempRepo();
  const templatePath = path.resolve(import.meta.dirname, "..", "templates", ".ai-ship.json");
  fs.copyFileSync(templatePath, path.join(dir, ".ai-ship.json"));

  const cfg = loadRepoConfig(dir);
  assert.deepEqual(cfg.implementerModel, { providerID: "openrouter", id: "anthropic/claude-sonnet-4" });
  assert.deepEqual(cfg.testerModel, { providerID: "openrouter", id: "openai/gpt-4.1" });
  assert.deepEqual(cfg.reviewerModel, { providerID: "openrouter", id: "google/gemini-2.5-pro" });

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

test("loadRepoConfig defaults to role-specific openrouter models when .ai-ship.json is absent", () => {
  const dir = makeTempRepo();
  const cfg = loadRepoConfig(dir);
  assert.deepEqual(cfg.implementerModel, { providerID: "openrouter", id: "anthropic/claude-sonnet-4" });
  assert.deepEqual(cfg.testerModel, { providerID: "openrouter", id: "openai/gpt-4.1" });
  assert.deepEqual(cfg.reviewerModel, { providerID: "openrouter", id: "google/gemini-2.5-pro" });

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
