import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { DiffError, commitAll, createWorktree, ensureWorktreeExcludes, getDiff } from "../src/git.ts";
import { withSharedContext } from "../src/pipeline.ts";

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-diff-test-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.ai-ship-worktrees/\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
  fs.writeFileSync(path.join(dir, "existing.ts"), "export const a = 1;\n");
  fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "x");
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeWorktree() {
  const repo = makeRepo();
  const handle = createWorktree(repo, "main", "task");
  return { repo, wt: handle.worktreeDir, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

test("getDiff survives a cloned-or-symlinked node_modules and commitAll does not commit it", () => {
  const { wt, cleanup } = makeWorktree();
  try {
    // Either a private copy-on-write clone (real directory) or the symlink fallback.
    const st = fs.lstatSync(path.join(wt, "node_modules"));
    assert.ok(st.isDirectory() || st.isSymbolicLink());
    assert.ok(fs.existsSync(path.join(wt, "node_modules", "pkg", "index.js")));
    fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = 42;\n");

    const diff = getDiff(wt, "main");
    assert.match(diff, /feature\.ts/);
    assert.match(diff, /export const feature = 42;/);
    assert.doesNotMatch(diff, /node_modules/);

    assert.equal(commitAll(wt, "add feature"), true);
    const tree = execSync("git ls-tree -r HEAD --name-only", { cwd: wt, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    assert.ok(tree.includes("feature.ts"));
    assert.ok(!tree.some((f) => f.startsWith("node_modules")), `node_modules committed: ${tree.join(",")}`);
    assert.ok(!tree.some((f) => f.startsWith(".ai-ship")));
  } finally {
    cleanup();
  }
});

test("getDiff summarises binary and oversize untracked files instead of inlining them", () => {
  const { wt, cleanup } = makeWorktree();
  try {
    fs.writeFileSync(path.join(wt, "blob.bin"), Buffer.from([1, 2, 0, 3, 4, 5]));
    const big = "SECRET_BIG_CONTENT_".repeat(5000); // > 64KB
    fs.writeFileSync(path.join(wt, "big.txt"), big);

    const diff = getDiff(wt, "main");
    assert.match(diff, /Binary file blob\.bin added \(6 bytes\)/);
    assert.match(diff, new RegExp(`big\\.txt[\\s\\S]*new file, ${big.length} bytes; content omitted`));
    assert.doesNotMatch(diff, /SECRET_BIG_CONTENT_/);
  } finally {
    cleanup();
  }
});

test("getDiff includes staged-but-uncommitted changes", () => {
  const { wt, cleanup } = makeWorktree();
  try {
    fs.writeFileSync(path.join(wt, "existing.ts"), "export const a = 'STAGED_CHANGE';\n");
    execSync("git add existing.ts", { cwd: wt, stdio: "ignore" });
    const diff = getDiff(wt, "main");
    assert.match(diff, /STAGED_CHANGE/);
  } finally {
    cleanup();
  }
});

test("getDiff throws DiffError when git fails instead of returning an empty diff", () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-notrepo-"));
  try {
    assert.throws(
      () => getDiff(notRepo, "main"),
      (err: unknown) => err instanceof DiffError && (err as Error).name === "DiffError"
    );
  } finally {
    fs.rmSync(notRepo, { recursive: true, force: true });
  }

  const { wt, cleanup } = makeWorktree();
  try {
    fs.writeFileSync(path.join(wt, "x.ts"), "x\n");
    assert.throws(() => getDiff(wt, "no-such-branch-anywhere"), (err: unknown) => err instanceof DiffError);
  } finally {
    cleanup();
  }
});

test("getDiff lists names of untracked files beyond the first 20", () => {
  const { wt, cleanup } = makeWorktree();
  try {
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(wt, `f${String(i).padStart(2, "0")}.ts`), `export const v${i} = ${i};\n`);
    }
    const diff = getDiff(wt, "main");
    assert.match(diff, /5 more untracked file\(s\) not shown/);
    for (let i = 20; i < 25; i++) assert.match(diff, new RegExp(`f${i}\\.ts`));
    assert.doesNotMatch(diff, /export const v24 = 24;/);
  } finally {
    cleanup();
  }
});

test("withSharedContext writes the file during fn and removes it on success", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-ctx-"));
  try {
    const file = path.join(dir, ".ai-ship", "shared-context.txt");
    const result = await withSharedContext(dir, "hello context", async () => {
      assert.equal(fs.readFileSync(file, "utf8").trim(), "hello context");
      return 7;
    });
    assert.equal(result, 7);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withSharedContext removes the file when fn throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-ctx-"));
  try {
    const file = path.join(dir, ".ai-ship", "shared-context.txt");
    await assert.rejects(
      withSharedContext(dir, "ctx", async () => {
        assert.equal(fs.existsSync(file), true);
        throw new Error("reviewer blew up");
      }),
      /reviewer blew up/
    );
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureWorktreeExcludes is idempotent", () => {
  const { wt, cleanup } = makeWorktree();
  try {
    ensureWorktreeExcludes(wt);
    ensureWorktreeExcludes(wt);
    const excludePath = path.resolve(
      wt,
      execSync("git rev-parse --git-path info/exclude", { cwd: wt, encoding: "utf8" }).trim()
    );
    const lines = fs.readFileSync(excludePath, "utf8").split("\n").map((l) => l.trim());
    for (const entry of ["/node_modules", "/.ai-ship/", "/.ai-ship-shared-context.txt"]) {
      assert.equal(lines.filter((l) => l === entry).length, 1, `${entry} should appear exactly once`);
    }
  } finally {
    cleanup();
  }
});

function readExclude(dir: string): string {
  const p = path.resolve(
    dir,
    execSync("git rev-parse --git-path info/exclude", { cwd: dir, encoding: "utf8" }).trim()
  );
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

test("getDiff reports an untracked symlink to a directory as a symlink without reading it", () => {
  const { wt, cleanup } = makeWorktree();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-linktarget-"));
  try {
    fs.symlinkSync(target, path.join(wt, "link"), "dir");
    const diff = getDiff(wt, "main");
    assert.ok(diff.includes(`+++ b/link\n(symlink -> ${target})`), diff);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
    cleanup();
  }
});

test("repos that track files under node_modules keep new node_modules files diffed and committed", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-tracked-nm-"));
  try {
    execSync("git init -b main", { cwd: repo, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: repo, stdio: "ignore" });
    execSync('git config user.name "Test"', { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, ".gitignore"), ".ai-ship-worktrees/\n");
    fs.writeFileSync(path.join(repo, "package.json"), "{}");
    fs.mkdirSync(path.join(repo, "node_modules", "vendored"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "vendored", "index.js"), "module.exports = 1;\n");
    execSync("git add -A && git commit -m init", { cwd: repo, stdio: "ignore" });

    const wt = createWorktree(repo, "main", "task").worktreeDir;
    assert.equal(fs.lstatSync(path.join(wt, "node_modules")).isSymbolicLink(), false);
    assert.doesNotMatch(readExclude(wt), /^\/node_modules$/m);
    assert.match(readExclude(wt), /^\/\.ai-ship\/$/m);

    fs.writeFileSync(path.join(wt, "node_modules", "vendored", "added.js"), "module.exports = 2;\n");
    assert.match(getDiff(wt, "main"), /vendored\/added\.js/);
    assert.equal(commitAll(wt, "vendor"), true);
    const tree = execSync("git ls-tree -r HEAD --name-only", { cwd: wt, encoding: "utf8" });
    assert.match(tree, /node_modules\/vendored\/added\.js/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("ensureWorktreeExcludes throws for a non-git directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-notgit-"));
  try {
    assert.throws(() => ensureWorktreeExcludes(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getDiff notes unreadable untracked files instead of throwing", { skip: process.getuid?.() === 0 }, () => {
  const { wt, cleanup } = makeWorktree();
  const file = path.join(wt, "secret.ts");
  try {
    fs.writeFileSync(file, "export const s = 1;\n");
    fs.chmodSync(file, 0o000);
    const diff = getDiff(wt, "main");
    assert.match(diff, /\+\+\+ b\/secret\.ts\n\(unreadable: /);
  } finally {
    try {
      fs.chmodSync(file, 0o644);
    } catch {
      // ignore
    }
    cleanup();
  }
});

test("getDiff falls back to a two-dot diff when the base has no merge base", () => {
  const { wt, cleanup } = makeWorktree();
  try {
    execSync("git checkout --orphan unrelated", { cwd: wt, stdio: "ignore" });
    execSync("git rm -rf --cached . ", { cwd: wt, stdio: "ignore" });
    fs.writeFileSync(path.join(wt, "orphan-file.ts"), "export const orphan = true;\n");
    execSync("git add orphan-file.ts", { cwd: wt, stdio: "ignore" });
    execSync('git commit -m orphan', { cwd: wt, stdio: "ignore" });

    const diff = getDiff(wt, "main");
    assert.match(diff, /^\(no merge base with main; showing two-dot diff main\.\.HEAD\)/);
    assert.match(diff, /orphan-file\.ts/);
    assert.match(diff, /orphan = true/);
  } finally {
    cleanup();
  }
});
