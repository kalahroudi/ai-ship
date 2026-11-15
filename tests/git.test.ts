import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import {
  abortRebase,
  cloneDirCopyOnWrite,
  commitAll,
  createWorktree,
  isRebaseInProgress,
  listCleanupTargets,
  openPrFromWorktree,
  parseOpenPrArgs,
  rebaseOntoBase,
  removeCleanupTargets,
  resolveWorktreeForPr,
  setupWorktreeDependencies,
} from "../src/git.ts";

function makeCommittedRepo(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-git-test-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "ignore" });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

test("createWorktree provides node_modules (private clone or symlink fallback) for npm repos", () => {
  const dir = makeCommittedRepo({
    "package.json": JSON.stringify({ name: "npm-app", version: "1.0.0" }),
  });
  fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });

  const handle = createWorktree(dir, "main", "test npm worktree");
  const wtModules = path.join(handle.worktreeDir, "node_modules");
  const st = fs.lstatSync(wtModules);
  assert.ok(st.isDirectory() || st.isSymbolicLink());
  assert.ok(fs.existsSync(path.join(wtModules, "pkg")));
  fs.writeFileSync(path.join(handle.worktreeDir, "feature.ts"), "export const f = 1;\n");
  commitAll(handle.worktreeDir, "add");
  const tree = execSync("git ls-tree -r HEAD --name-only", { cwd: handle.worktreeDir, encoding: "utf8" });
  assert.doesNotMatch(tree, /node_modules/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("setupWorktreeDependencies falls back to a symlink when the clone fails and leaves no partial dest", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-fb-repo-"));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-fb-wt-"));
  try {
    fs.mkdirSync(path.join(repoDir, "node_modules"));
    const dest = path.join(wt, "node_modules");
    const ok = cloneDirCopyOnWrite(path.join(repoDir, "node_modules"), dest, (args) => {
      fs.mkdirSync(args[args.length - 1], { recursive: true }); // simulate partial copy
      return 1;
    }, "linux");
    assert.equal(ok, false);
    assert.equal(fs.existsSync(dest), false);

    // Unsupported platform path in setup: real setup falls back to symlink or clones; either is fine.
    fs.writeFileSync(path.join(wt, "package.json"), "{}");
    setupWorktreeDependencies(repoDir, wt);
    const st = fs.lstatSync(dest);
    assert.ok(st.isDirectory() || st.isSymbolicLink());
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test("setupWorktreeDependencies runs pnpm install offline without symlinking node_modules", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-pnpm-repo-"));
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-pnpm-wt-"));
  fs.mkdirSync(path.join(repoDir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, "package.json"), "{}");
  fs.writeFileSync(path.join(worktreeDir, "pnpm-lock.yaml"), "");

  const calls: Array<{ args: string[]; cwd: string; quiet: boolean }> = [];
  setupWorktreeDependencies(repoDir, worktreeDir, (args, cwd, quiet) => {
    calls.push({ args, cwd, quiet });
    return 0;
  });

  assert.equal(fs.existsSync(path.join(worktreeDir, "node_modules")), false);
  assert.deepEqual(calls, [
    { args: ["install", "--frozen-lockfile", "--offline"], cwd: worktreeDir, quiet: true },
  ]);

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(worktreeDir, { recursive: true, force: true });
});

test("setupWorktreeDependencies falls back to --prefer-offline when offline install fails", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-pnpm-repo-"));
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-pnpm-wt-"));
  fs.writeFileSync(path.join(worktreeDir, "package.json"), "{}");
  fs.writeFileSync(path.join(worktreeDir, "pnpm-workspace.yaml"), "packages:\n  - .\n");

  const calls: Array<{ args: string[]; quiet: boolean }> = [];
  setupWorktreeDependencies(repoDir, worktreeDir, (args, _cwd, quiet) => {
    calls.push({ args, quiet });
    return calls.length === 1 ? 1 : 0;
  });

  assert.deepEqual(calls, [
    { args: ["install", "--offline"], quiet: true },
    { args: ["install", "--prefer-offline"], quiet: false },
  ]);

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(worktreeDir, { recursive: true, force: true });
});

test("setupWorktreeDependencies throws if pnpm install fails both offline and online", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-pnpm-repo-"));
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-pnpm-wt-"));
  fs.writeFileSync(path.join(worktreeDir, "package.json"), "{}");
  fs.writeFileSync(path.join(worktreeDir, "pnpm-lock.yaml"), "");

  assert.throws(
    () => setupWorktreeDependencies(repoDir, worktreeDir, () => 1),
    /pnpm install failed in worktree/
  );

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(worktreeDir, { recursive: true, force: true });
});

test("listCleanupTargets and removeCleanupTargets clean up worktrees and ai/* branches", () => {
  const dir = makeCommittedRepo({ "README.md": "hello\n" });
  execSync("git branch feature/keep-me", { cwd: dir, stdio: "ignore" });

  const handle = createWorktree(dir, "main", "cleanup test");
  fs.writeFileSync(path.join(handle.worktreeDir, "dirty.txt"), "uncommitted\n");

  const orphanDir = path.join(dir, ".ai-ship-worktrees", "orphaned-dir");
  fs.mkdirSync(orphanDir, { recursive: true });

  const targets = listCleanupTargets(dir, "main");
  assert.equal(targets.worktrees.length, 2);
  const registered = targets.worktrees.find((w) => w.registered);
  const orphan = targets.worktrees.find((w) => !w.registered);
  assert.ok(registered);
  assert.equal(registered.branch, handle.branch);
  assert.equal(registered.dirty, true);
  assert.ok(orphan);

  assert.deepEqual(
    targets.branches.map((b) => b.name),
    [handle.branch]
  );
  assert.equal(targets.branches[0].checkedOutInMain, false);

  // Without force: dirty worktree, orphan dir and the branch attached to the kept worktree survive.
  const safe = removeCleanupTargets(targets);
  assert.deepEqual(safe.removedWorktrees, []);
  assert.deepEqual(safe.removedBranches, []);
  assert.equal(safe.skippedWorktrees.length, 2);
  assert.deepEqual(safe.skippedBranches, [handle.branch]);
  assert.equal(fs.existsSync(handle.worktreeDir), true);
  assert.equal(fs.existsSync(path.join(handle.worktreeDir, "dirty.txt")), true);
  assert.equal(fs.existsSync(orphanDir), true);
  assert.match(
    execSync("git branch --format='%(refname:short)'", { cwd: dir, encoding: "utf8" }),
    new RegExp(handle.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );

  const res = removeCleanupTargets(listCleanupTargets(dir, "main"), { force: true });
  assert.equal(res.removedWorktrees.length, 2);
  assert.deepEqual(res.removedBranches, [handle.branch]);
  assert.equal(fs.existsSync(path.join(dir, ".ai-ship-worktrees")), false);

  const branches = execSync("git branch --format='%(refname:short)'", { cwd: dir, encoding: "utf8" });
  assert.equal(branches.includes(handle.branch), false);
  assert.equal(branches.includes("feature/keep-me"), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI --cleanup prompts for confirmation before deleting", () => {
  const dir = makeCommittedRepo({ "README.md": "hello\n" });
  const handle = createWorktree(dir, "main", "confirm test");
  const cliPath = path.resolve(import.meta.dirname, "..", "bin", "ai-ship.mjs");

  const cancelRun = spawnSync(process.execPath, [cliPath, "--cleanup", "--repo", dir], {
    input: "n\n",
    encoding: "utf8",
  });
  assert.equal(cancelRun.status, 0);
  assert.match(cancelRun.stdout, /Are you sure/);
  assert.match(cancelRun.stdout, /Cleanup cancelled/);
  assert.equal(fs.existsSync(handle.worktreeDir), true);

  const confirmRun = spawnSync(process.execPath, [cliPath, "--cleanup", "--repo", dir], {
    input: "y\n",
    encoding: "utf8",
  });
  assert.equal(confirmRun.status, 0);
  assert.match(confirmRun.stdout, /Are you sure/);
  assert.match(confirmRun.stdout, /Removed 1 worktree\(s\) and 1 branch\(es\)/);
  assert.equal(fs.existsSync(handle.worktreeDir), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("rebaseOntoBase cleanly rebases non-conflicting upstream changes and reports conflicts", () => {
  const dir = makeCommittedRepo({ "shared.txt": "line 1\n", "other.txt": "base\n" });
  const handle = createWorktree(dir, "main", "rebase test");

  // Commit in worktree on shared.txt
  fs.writeFileSync(path.join(handle.worktreeDir, "shared.txt"), "worktree change\n");
  assert.equal(commitAll(handle.worktreeDir, "feat: worktree change"), true);

  // Advance main on a non-conflicting file
  fs.writeFileSync(path.join(dir, "other.txt"), "main non-conflicting\n");
  execSync('git add other.txt && git commit -m "main non-conflicting"', { cwd: dir, stdio: "ignore" });

  const cleanRebase = rebaseOntoBase(handle);
  assert.deepEqual(cleanRebase, {
    updated: true,
    conflicted: false,
    targetRef: "main",
    conflictedFiles: [],
  });
  assert.equal(fs.readFileSync(path.join(handle.worktreeDir, "other.txt"), "utf8"), "main non-conflicting\n");

  // Now advance main on shared.txt to trigger a conflict
  fs.writeFileSync(path.join(dir, "shared.txt"), "conflicting main change\n");
  execSync('git add shared.txt && git commit -m "main conflict"', { cwd: dir, stdio: "ignore" });

  const conflictRebase = rebaseOntoBase(handle);
  assert.equal(conflictRebase.updated, true);
  assert.equal(conflictRebase.conflicted, true);
  assert.deepEqual(conflictRebase.conflictedFiles, ["shared.txt"]);
  assert.equal(isRebaseInProgress(handle.worktreeDir), true);

  abortRebase(handle.worktreeDir);
  assert.equal(isRebaseInProgress(handle.worktreeDir), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseOpenPrArgs extracts title and inline --draft flag", () => {
  assert.deepEqual(parseOpenPrArgs("  M2: Restrict owner access --draft  "), {
    title: "M2: Restrict owner access",
    draft: true,
  });
  assert.deepEqual(parseOpenPrArgs("Fix bug", { draft: true }), {
    title: "Fix bug",
    draft: true,
  });
});

test("resolveWorktreeForPr and openPrFromWorktree resolve by branch, single worktree, or explicit path", () => {
  const repoDir = makeCommittedRepo({ "README.md": "hello\n" });
  const wt1 = createWorktree(repoDir, "main", "m2-task");
  fs.writeFileSync(path.join(wt1.worktreeDir, "README.md"), "updated\n");
  commitAll(wt1.worktreeDir, "feat: m2");

  // Resolves automatically when only 1 active worktree exists
  const autoResolved = resolveWorktreeForPr(repoDir);
  assert.equal(autoResolved.branch, wt1.branch);

  // Resolves by branch even when worktreeDir is just the .ai-ship-worktrees/ root
  const byBranch = resolveWorktreeForPr(repoDir, {
    worktreeDir: ".ai-ship-worktrees/",
    branch: wt1.branch,
  });
  assert.equal(byBranch.worktreeDir, fs.realpathSync(wt1.worktreeDir));

  // openPrFromWorktree passes title, body, and draft to pushAndOpen
  let captured: any;
  const prRes = openPrFromWorktree(
    {
      repoDir,
      title: "M2: Restrict break-glass owner access --draft",
      body: "**What changed**\n- Break-glass route removed",
      worktreeDir: ".ai-ship-worktrees/",
      branch: wt1.branch,
    },
    {
      rebase: () => ({ updated: false, conflicted: false, targetRef: "main", conflictedFiles: [] }),
      pushAndOpen: (wt, title, body, opts) => {
        captured = { wt, title, body, opts };
        return "https://github.com/org/repo/pull/42";
      },
    }
  );
  assert.equal(prRes.prUrl, "https://github.com/org/repo/pull/42");
  assert.equal(prRes.draft, true);
  assert.equal(captured.title, "M2: Restrict break-glass owner access");
  assert.match(captured.body, /Break-glass route removed/);
  assert.equal(captured.opts.draft, true);

  // Rejects dirty worktree
  fs.writeFileSync(path.join(wt1.worktreeDir, "dirty.txt"), "uncommitted\n");
  assert.throws(
    () => openPrFromWorktree({ repoDir, title: "Dirty PR", branch: wt1.branch }),
    /uncommitted changes/
  );
  fs.rmSync(path.join(wt1.worktreeDir, "dirty.txt"));

  // Ambiguous when multiple worktrees exist without branch or worktreeDir
  const wt2 = createWorktree(repoDir, "main", "m3-task");
  assert.throws(
    () => resolveWorktreeForPr(repoDir),
    /Multiple active ai-ship worktrees found/
  );
  assert.equal(resolveWorktreeForPr(repoDir, { worktreeDir: wt2.worktreeDir }).branch, wt2.branch);

  fs.rmSync(repoDir, { recursive: true, force: true });
});
