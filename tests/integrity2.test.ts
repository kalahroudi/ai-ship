import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ProtectedPathError,
  findScriptInvokedPaths,
  findTamperedBinTools,
  scriptNamesInvoked,
  snapshotBinTools,
} from "../src/integrity.ts";
import { cloneDirCopyOnWrite } from "../src/git.ts";
import { runPipeline } from "../src/pipeline.ts";
import type { OpencodeClient } from "../src/runner.ts";

// Hermetic pricing: never read the developer's real ~/.config/ai-ship/models.json.
const prevModelsFile = process.env.AI_SHIP_MODELS_FILE;
process.env.AI_SHIP_MODELS_FILE = path.join(os.tmpdir(), `ai-ship-no-models-${process.pid}.json`);
process.on("exit", () => {
  if (prevModelsFile === undefined) delete process.env.AI_SHIP_MODELS_FILE;
  else process.env.AI_SHIP_MODELS_FILE = prevModelsFile;
});

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function write(dir: string, file: string, content: string): void {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}
function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd: dir, stdio: "ignore" });
}

test("cloneDirCopyOnWrite uses cp -c on darwin and --reflink=always on linux", () => {
  const calls: string[][] = [];
  const dest = path.join(tmp("ai-ship-c-"), "d");
  const mk = (args: string[]) => {
    calls.push(args);
    fs.mkdirSync(dest, { recursive: true });
    return 0;
  };
  assert.equal(cloneDirCopyOnWrite("/s", dest, mk, "darwin"), true);
  assert.equal(cloneDirCopyOnWrite("/s", dest, mk, "linux"), true);
  assert.deepEqual(calls[0], ["-c", "-R", "/s", dest]);
  assert.deepEqual(calls[1], ["--reflink=always", "-R", "/s", dest]);
});

test("cloneDirCopyOnWrite returns false for unsupported platforms without running cp", () => {
  let ran = false;
  assert.equal(cloneDirCopyOnWrite("/s", "/nonexistent-d", () => ((ran = true), 0), "win32"), false);
  assert.equal(ran, false);
});

test("cloneDirCopyOnWrite removes a partial dest on failure", () => {
  const dest = path.join(tmp("ai-ship-c-"), "d");
  const ok = cloneDirCopyOnWrite("/s", dest, () => (fs.mkdirSync(dest), 1), "darwin");
  assert.equal(ok, false);
  assert.equal(fs.existsSync(dest), false);
});

function binRepo(): string {
  const dir = tmp("ai-ship-bin-");
  write(dir, "node_modules/pkg/cli.js", "console.log(1)\n");
  write(dir, "node_modules/.bin/tsc", "#!/bin/sh\nexit 0\n");
  write(dir, "node_modules/.bin/lint", "#!/bin/sh\nexit 0\n");
  fs.symlinkSync("../pkg/cli.js", path.join(dir, "node_modules/.bin/viapkg"));
  return dir;
}

test("findTamperedBinTools reports changed and removed tools, allows new ones", () => {
  const dir = binRepo();
  try {
    const base = snapshotBinTools(dir);
    assert.ok(base.has(".bin/tsc") && base.has(".bin/viapkg"));
    assert.deepEqual(findTamperedBinTools(dir, base), []);
    write(dir, "node_modules/.bin/newtool", "x");
    assert.deepEqual(findTamperedBinTools(dir, base), []);
    write(dir, "node_modules/.bin/tsc", "#!/bin/sh\nexit 0 # pwn\n");
    fs.rmSync(path.join(dir, "node_modules/.bin/lint"));
    write(dir, "node_modules/pkg/cli.js", "evil\n"); // symlink target changed
    const t = findTamperedBinTools(dir, base);
    assert.ok(t.some((x) => x.includes("tsc") && x.includes("changed")), t.join());
    assert.ok(t.some((x) => x.includes("lint") && x.includes("removed")), t.join());
    assert.ok(t.some((x) => x.includes("viapkg")), t.join());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshotBinTools tolerates broken links and missing .bin", () => {
  const dir = tmp("ai-ship-bin-");
  try {
    assert.equal(snapshotBinTools(dir).size, 0);
    write(dir, "node_modules/.bin/ok", "a");
    fs.symlinkSync("../nowhere", path.join(dir, "node_modules/.bin/broken"));
    const snap = snapshotBinTools(dir);
    assert.equal(snap.get(".bin/broken"), null);
    assert.ok(snap.get(".bin/ok"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findScriptInvokedPaths finds direct, npm-run, pre-script and nested invocations", () => {
  const dir = tmp("ai-ship-sip-");
  try {
    write(dir, "scripts/test.sh", "exit 0\n");
    write(dir, "tools/check.js", "\n");
    write(dir, "scripts/pre.sh", "\n");
    write(dir, "node_modules/x/run.js", "\n");
    write(
      dir,
      "package.json",
      JSON.stringify({
        scripts: { test: "node tools/check.js", pretest: "bash scripts/pre.sh", unused: "bash scripts/unused.sh" },
      })
    );
    write(dir, "scripts/unused.sh", "\n");
    assert.deepEqual(findScriptInvokedPaths(dir, ["bash scripts/test.sh"]), ["scripts/test.sh"]);
    assert.deepEqual(findScriptInvokedPaths(dir, ["npm run test"]), ["scripts/pre.sh", "tools/check.js"]);
    assert.deepEqual(findScriptInvokedPaths(dir, ["pnpm test"]), ["scripts/pre.sh", "tools/check.js"]);
    assert.deepEqual(
      findScriptInvokedPaths(dir, ["node node_modules/x/run.js", "bash scripts/missing.sh", "echo hi"]),
      []
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeClient(repoDir: string, onPrompt: (wt: string) => void): OpencodeClient {
  let sess = 0;
  return {
    session: {
      async create() {
        return { data: { id: `s-${++sess}` } };
      },
      async prompt() {
        const root = path.join(repoDir, ".ai-ship-worktrees");
        onPrompt(path.join(root, fs.readdirSync(root)[0]));
        return {
          data: {
            parts: [{ type: "text", text: "Done.\nVERDICT: CLEAN" }],
            info: { cost: 0.01, tokens: { input: 10, output: 5 } },
          },
        };
      },
    },
  } as unknown as OpencodeClient;
}

function pipelineRepo(): string {
  const dir = tmp("ai-ship-pl2-");
  git(dir, "init", "-q", "-b", "main");
  write(dir, "README.md", "# t\n");
  write(dir, "package.json", JSON.stringify({ name: "x", scripts: { test: "bash scripts/test.sh" } }));
  write(dir, "scripts/test.sh", "exit 0\n");
  write(dir, ".gitignore", ".ai-ship-worktrees/\nnode_modules/\n");
  write(
    dir,
    ".ai-ship.json",
    JSON.stringify({
      baseBranch: "main",
      verify: ["bash scripts/test.sh"],
      maxFixRetries: 1,
      maxReviewRounds: 1,
      securityScan: false,
      safetyCheck: false,
    })
  );
  write(dir, "node_modules/.bin/tool", "#!/bin/sh\nexit 0\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("runPipeline rejects when the implementer rewrites a node_modules/.bin tool", async () => {
  const repoDir = pipelineRepo();
  try {
    const client = fakeClient(repoDir, (wt) => write(wt, "node_modules/.bin/tool", "#!/bin/sh\nexit 0 # rigged\n"));
    await assert.rejects(
      () => runPipeline({ repoDir, task: "rig", openPr: false, skipTests: true, skipReview: true, client }),
      /tool binaries changed/
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("runPipeline rejects with ProtectedPathError when the implementer edits a verify-invoked script", async () => {
  const repoDir = pipelineRepo();
  try {
    const client = fakeClient(repoDir, (wt) => write(wt, "scripts/test.sh", "exit 0 # weakened\n"));
    await assert.rejects(
      () => runPipeline({ repoDir, task: "weaken", openPr: false, skipTests: true, skipReview: true, client }),
      (err: unknown) => err instanceof ProtectedPathError
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("scriptNamesInvoked parses package-manager script invocations", () => {
  assert.deepEqual(scriptNamesInvoked("npm test"), ["test"]);
  assert.deepEqual(scriptNamesInvoked("npm t"), ["test"]);
  assert.deepEqual(scriptNamesInvoked("npm run -s lint"), ["lint"]);
  assert.deepEqual(scriptNamesInvoked("npm run-script x"), ["x"]);
  assert.deepEqual(scriptNamesInvoked("pnpm --filter x lint"), ["lint"]);
  assert.deepEqual(scriptNamesInvoked("yarn build && npm run verify"), ["build", "verify"]);
  assert.deepEqual(scriptNamesInvoked("bun run check"), ["check"]);
  assert.deepEqual(scriptNamesInvoked("npm install"), []);
});

test("findScriptInvokedPaths follows npm test, shell helpers one level, and excludes tester paths", () => {
  const dir = tmp("ai-ship-sip2-");
  try {
    write(dir, "package.json", JSON.stringify({ scripts: { test: "bash scripts/test.sh" } }));
    write(dir, "scripts/test.sh", "bash scripts/helper.sh\n");
    write(dir, "scripts/helper.sh", "exit 0\n");
    write(dir, "tests/a.test.js", "\n");
    assert.deepEqual(findScriptInvokedPaths(dir, ["npm test"]), ["scripts/helper.sh", "scripts/test.sh"]);
    assert.deepEqual(findScriptInvokedPaths(dir, ["node --test tests/a.test.js"]), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshotBinTools detects edits to package files behind a bin shim", () => {
  const dir = tmp("ai-ship-bin2-");
  try {
    write(dir, "node_modules/pkg/package.json", "{}");
    write(dir, "node_modules/pkg/bin.js", "require('./lib/impl.js')\n");
    write(dir, "node_modules/pkg/lib/impl.js", "ok\n");
    fs.mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true });
    fs.symlinkSync("../pkg/bin.js", path.join(dir, "node_modules/.bin/pkg"));
    const base = snapshotBinTools(dir);
    assert.deepEqual(findTamperedBinTools(dir, base), []);
    write(dir, "node_modules/pkg/lib/impl.js", "process.exit(0) // rigged\n");
    const t = findTamperedBinTools(dir, base);
    assert.ok(t.some((x) => x.includes("pkg") && x.includes("changed")), t.join());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cloneDirCopyOnWrite produces an isolated clone (darwin)", { skip: process.platform !== "darwin" }, () => {
  const root = tmp("ai-ship-cow-");
  try {
    write(root, "src/f.txt", "orig");
    const dest = path.join(root, "dest");
    if (!cloneDirCopyOnWrite(path.join(root, "src"), dest)) return; // filesystem without clone support
    fs.writeFileSync(path.join(dest, "f.txt"), "changed");
    assert.equal(fs.readFileSync(path.join(root, "src/f.txt"), "utf8"), "orig");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
