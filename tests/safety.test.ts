import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  formatSafetyFindings,
  redactValue,
  scanLineForLeaks,
  scanWorktreeSafety,
} from "../src/safety.ts";
import { commitAll, createWorktree, openPrFromWorktree } from "../src/git.ts";

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-safety-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "ci@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "CI"', { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n", "utf8");
  execSync("git add -A && git commit -m 'init'", { cwd: dir, stdio: "ignore" });
  return dir;
}

test("scanLineForLeaks catches wrangler deployment config IDs and allows placeholders", () => {
  const realAccount = "a1b2c3d4" + "e5f60718293a4b5c6d7e8f90";
  const realDbId = "123e4567-" + "e89b-12d3-a456-426614174000";

  const f1 = scanLineForLeaks("wrangler.toml", 3, `account_id = "${realAccount}"`);
  assert.equal(f1.length, 1);
  assert.equal(f1[0].rule, "deployment-config-id");
  assert.equal(f1[0].preview.includes(realAccount), false);

  const f2 = scanLineForLeaks("wrangler.jsonc", 12, `  "database_id": "${realDbId}",`);
  assert.equal(f2.length, 1);
  assert.equal(f2[0].rule, "deployment-config-id");

  const f3 = scanLineForLeaks("wrangler.toml", 8, `id = "${realAccount}"`);
  assert.equal(f3.length, 1);
  assert.equal(f3[0].rule, "wrangler-resource-id");

  // Placeholders & env refs must pass
  assert.equal(scanLineForLeaks("wrangler.toml", 3, 'account_id = "<YOUR_ACCOUNT_ID>"').length, 0);
  assert.equal(scanLineForLeaks("wrangler.toml", 4, 'database_id = "00000000-0000-0000-0000-000000000000"').length, 0);
  assert.equal(scanLineForLeaks("src/env.ts", 1, "const accountId = process.env.CF_ACCOUNT_ID;").length, 0);
});

test("scanLineForLeaks catches API keys, private keys, DB URIs, and redacts output", () => {
  const fakeAws = "AKIA" + "IOSFODNN7EXAMPLE";
  const fakeGhp = "ghp_" + "1234567890abcdef1234567890abcdef1234";
  const fakeSk = "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz123456";

  const awsFindings = scanLineForLeaks("src/config.ts", 10, `const key = "${fakeAws}";`);
  assert.equal(awsFindings.length, 1);
  assert.equal(awsFindings[0].rule, "aws-access-key");
  assert.equal(formatSafetyFindings(awsFindings).includes(fakeAws), false);

  const ghpFindings = scanLineForLeaks("src/ci.ts", 2, `token: "${fakeGhp}"`);
  assert.equal(ghpFindings.length, 1);
  assert.equal(ghpFindings[0].rule, "github-token");
  assert.equal(formatSafetyFindings(ghpFindings).includes(fakeGhp), false);

  const skFindings = scanLineForLeaks("src/ai.ts", 5, `ANTHROPIC_API_KEY=${fakeSk}`);
  assert.equal(skFindings.length, 1);
  assert.equal(skFindings[0].rule, "anthropic-api-key");

  const pkFindings = scanLineForLeaks("src/cert.ts", 1, "-----BEGIN RSA " + "PRIVATE KEY-----");
  assert.equal(pkFindings.length, 1);
  assert.equal(pkFindings[0].rule, "private-key-block");

  const dbFindings = scanLineForLeaks("src/db.ts", 4, 'url = "postgres://admin:S3cr3tPassw0rd@' + 'prod-db.internal:5432/app"');
  assert.ok(dbFindings.some((f) => f.rule === "database-credentials-uri"));
});

test("scanLineForLeaks catches real emails while ignoring placeholders and asset @2x suffixes", () => {
  const testEmail = "founder@" + "acme-startup.io";
  const realEmail = scanLineForLeaks("src/seed.ts", 7, `const email = "${testEmail}";`);
  assert.equal(realEmail.length, 1);
  assert.equal(realEmail[0].rule, "email-address");
  assert.equal(realEmail[0].preview.includes(testEmail), false);

  assert.equal(scanLineForLeaks("src/seed.ts", 8, 'const email = "user@example.com";').length, 0);
  assert.equal(scanLineForLeaks("tests/auth.test.ts", 3, 'const email = "alice@test.local";').length, 0);
  assert.equal(scanLineForLeaks("src/ui.tsx", 5, 'src="/images/logo@2x.png"').length, 0);
  assert.equal(scanLineForLeaks("package.json", 5, '"@types/node": "^22.0.0"').length, 0);
});

test("scanLineForLeaks catches hardcoded entity IDs in production files and respects allowlist", () => {
  const orgUuid = "550e8400-e29b-41d4-a716-446655440000";
  const prod = scanLineForLeaks("src/tenant.ts", 4, `const orgId = "${orgUuid}";`);
  assert.equal(prod.length, 1);
  assert.equal(prod[0].rule, "hardcoded-entity-id");

  // Allowed in test files
  assert.equal(scanLineForLeaks("tests/tenant.test.ts", 4, `const orgId = "${orgUuid}";`).length, 0);

  // Allowlist regex/substring
  const allowlisted = scanLineForLeaks("src/tenant.ts", 4, `const orgId = "${orgUuid}";`, [orgUuid]);
  assert.equal(allowlisted.length, 0);
});

test("redactValue masks middle characters", () => {
  assert.equal(redactValue("short"), "***");
  assert.equal(redactValue("1234567890abcdef"), "1234***cdef");
});

test("scanWorktreeSafety catches blocked files and openPrFromWorktree refuses to push leaks", () => {
  const repoDir = initTempGitRepo();
  try {
    // Untracked .dev.vars and .env.example (example should pass, .dev.vars should fail)
    fs.writeFileSync(path.join(repoDir, ".env.example"), "API_KEY=<YOUR_API_KEY>\n", "utf8");
    fs.writeFileSync(path.join(repoDir, ".dev.vars"), "CF_SECRET=supersecretvalue123\n", "utf8");

    const res1 = scanWorktreeSafety(repoDir, { baseBranch: "main" });
    assert.equal(res1.ok, false);
    assert.ok(res1.findings.some((f) => f.rule === "blocked-wrangler-dev-vars"));
    assert.ok(!res1.findings.some((f) => f.file === ".env.example"));

    fs.rmSync(path.join(repoDir, ".dev.vars"));

    // Worktree branch with committed wrangler.toml leak
    const wt = createWorktree(repoDir, "main", "wrangler leak");
    const leakedAcct = "a1b2c3d4" + "e5f60718293a4b5c6d7e8f90";
    fs.writeFileSync(
      path.join(wt.worktreeDir, "wrangler.toml"),
      `name = "my-worker"\naccount_id = "${leakedAcct}"\n`,
      "utf8"
    );
    commitAll(wt.worktreeDir, "add wrangler");

    const res2 = scanWorktreeSafety(wt.worktreeDir, { baseBranch: "main" });
    assert.equal(res2.ok, false);
    assert.ok(res2.findings.some((f) => f.rule === "deployment-config-id"));

    // openPrFromWorktree must block pushing even with mocked pushAndOpen
    let pushCalled = false;
    assert.throws(
      () =>
        openPrFromWorktree(
          { repoDir, worktreeDir: wt.worktreeDir, branch: wt.branch, baseBranch: "main", title: "Add wrangler" },
          {
            rebase: () => ({ updated: false, conflicted: false, targetRef: "main", conflictedFiles: [] }),
            pushAndOpen: () => {
              pushCalled = true;
              return "https://github.com/org/repo/pull/1";
            },
          }
        ),
      /Safety check FAILED/
    );
    assert.equal(pushCalled, false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
