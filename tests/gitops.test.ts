import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  remoteBranchExists,
  buildCommitMessage,
  buildPushArgs,
  commitAll,
  createWorktree,
  inferCommitType,
  listCleanupTargets,
  pushAndOpenPR,
  removeCleanupTargets,
} from "../src/git.ts";

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-gitops-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

function branchList(dir: string): string[] {
  return execSync("git branch --format='%(refname:short)'", { cwd: dir, encoding: "utf8" })
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean);
}

test("buildPushArgs forces with lease only for existing ai/* remote branches", () => {
  assert.deepEqual(buildPushArgs("ai/x", true), ["push", "--force-with-lease", "--force-if-includes", "-u", "origin", "ai/x"]);
  assert.deepEqual(buildPushArgs("ai/x", false), ["push", "-u", "origin", "ai/x"]);
  assert.deepEqual(buildPushArgs("main", true), ["push", "-u", "origin", "main"]);
  assert.deepEqual(buildPushArgs("feature/ai/x", true), ["push", "-u", "origin", "feature/ai/x"]);
  assert.ok(!buildPushArgs("release", true).includes("--force-with-lease"));
});

function setupPushRepo() {
  const dir = makeRepo();
  const handle = createWorktree(dir, "main", "push test");
  fs.writeFileSync(path.join(handle.worktreeDir, "feature.txt"), "clean change\n");
  assert.equal(commitAll(handle.worktreeDir, "feat: push test"), true);
  return { dir, handle };
}

type Call = string[];
function fakes(opts: { prUrl?: string; remote: boolean }) {
  const ghCalls: Call[] = [];
  const gitCalls: Call[] = [];
  const gh = (args: string[]) => {
    ghCalls.push(args);
    if (args[1] === "view") {
      return opts.prUrl
        ? { status: 0, stdout: `${opts.prUrl}\n`, stderr: "" }
        : { status: 1, stdout: "", stderr: "no pull requests found" };
    }
    if (args[1] === "create") return { status: 0, stdout: "https://github.com/o/r/pull/9\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return {
    ghCalls,
    gitCalls,
    opts: {
      gh,
      git: (args: string[]) => void gitCalls.push(args),
      remoteExists: () => opts.remote,
    },
  };
}

test("pushAndOpenPR edits the existing open PR instead of creating one", () => {
  const { dir, handle } = setupPushRepo();
  const f = fakes({ prUrl: "https://github.com/o/r/pull/5", remote: true });
  const url = pushAndOpenPR(handle, "New title", "New body", f.opts);
  assert.equal(url, "https://github.com/o/r/pull/5");
  const edit = f.ghCalls.find((c) => c[0] === "pr" && c[1] === "edit");
  assert.ok(edit);
  assert.deepEqual(edit, ["pr", "edit", handle.branch, "--body", "New body"]);
  assert.equal(edit.includes("--title"), false);
  assert.equal(f.ghCalls.some((c) => c[0] === "pr" && c[1] === "create"), false);
  assert.deepEqual(f.gitCalls[0], ["push", "--force-with-lease", "--force-if-includes", "-u", "origin", handle.branch]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pushAndOpenPR creates a draft PR when none exists and remote branch is new", () => {
  const { dir, handle } = setupPushRepo();
  const f = fakes({ remote: false });
  const url = pushAndOpenPR(handle, "T", "B", { ...f.opts, draft: true });
  assert.equal(url, "https://github.com/o/r/pull/9");
  const create = f.ghCalls.find((c) => c[1] === "create");
  assert.ok(create);
  assert.ok(create.includes("--draft"));
  assert.equal(f.ghCalls.some((c) => c[1] === "edit"), false);
  assert.deepEqual(f.gitCalls[0], ["push", "-u", "origin", handle.branch]);
  assert.ok(!f.gitCalls[0].includes("--force-with-lease"));

  const f2 = fakes({ remote: false });
  pushAndOpenPR(handle, "T", "B", f2.opts);
  assert.ok(!f2.ghCalls.find((c) => c[1] === "create")!.includes("--draft"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pushAndOpenPR never force-pushes a non-ai branch", () => {
  const { dir, handle } = setupPushRepo();
  const f = fakes({ remote: true });
  pushAndOpenPR({ ...handle, branch: "feature/other" }, "T", "B", f.opts);
  assert.deepEqual(f.gitCalls[0], ["push", "-u", "origin", "feature/other"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("inferCommitType and buildCommitMessage", () => {
  const table: Array<[string, string]> = [
    ["Fix login crash", "fix"],
    ["Refactor auth module", "refactor"],
    ["Update README", "docs"],
    ["Add org invite endpoint", "feat"],
    ["Add tests for parser", "test"],
    ["Optimize query performance", "perf"],
    ["Bump dependencies", "chore"],
  ];
  for (const [task, type] of table) {
    assert.equal(inferCommitType(task), type, task);
    assert.ok(buildCommitMessage(task).startsWith(`${type}: `), task);
  }
  assert.equal(buildCommitMessage("Fix login crash"), "fix: Fix login crash");
  assert.equal(buildCommitMessage("Add org invite endpoint\nwith extra detail\nmore"), "feat: Add org invite endpoint");
  const long = buildCommitMessage("Add " + "very long title ".repeat(20));
  assert.ok(long.length <= 72, String(long.length));
  assert.ok(long.endsWith("…"));
  assert.ok(long.startsWith("feat: Add very"));
});

test("removeCleanupTargets removes clean merged worktree and branch", () => {
  const dir = makeRepo();
  const h = createWorktree(dir, "main", "merged one");
  const res = removeCleanupTargets(listCleanupTargets(dir, "main"));
  assert.equal(res.removedWorktrees.length, 1);
  assert.deepEqual(res.removedBranches, [h.branch]);
  assert.deepEqual(res.skippedBranches, []);
  assert.deepEqual(res.skippedWorktrees, []);
  assert.equal(fs.existsSync(h.worktreeDir), false);
  assert.equal(branchList(dir).includes(h.branch), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("removeCleanupTargets keeps unmerged branch unless forced", () => {
  const dir = makeRepo();
  const h = createWorktree(dir, "main", "unmerged one");
  fs.writeFileSync(path.join(h.worktreeDir, "work.txt"), "work\n");
  assert.equal(commitAll(h.worktreeDir, "feat: work"), true);

  const targets = listCleanupTargets(dir, "main");
  assert.equal(targets.branches.find((b) => b.name === h.branch)?.merged, false);
  const res = removeCleanupTargets(targets);
  assert.equal(res.removedWorktrees.length, 1);
  assert.equal(fs.existsSync(h.worktreeDir), false);
  assert.deepEqual(res.removedBranches, []);
  assert.deepEqual(res.skippedBranches, [h.branch]);
  assert.equal(branchList(dir).includes(h.branch), true);

  const forced = removeCleanupTargets(listCleanupTargets(dir, "main"), { force: true });
  assert.deepEqual(forced.removedBranches, [h.branch]);
  assert.equal(branchList(dir).includes(h.branch), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createWorktree keeps .ai-ship-worktrees out of main repo status", () => {
  const dir = makeRepo();
  createWorktree(dir, "main", "status test");
  assert.ok(fs.existsSync(path.join(dir, ".ai-ship-worktrees")));
  const status = execSync("git status --porcelain", { cwd: dir, encoding: "utf8" });
  assert.equal(status.includes(".ai-ship-worktrees"), false, status);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("inferCommitType only reads the first line and real fix signals", () => {
  const table: Array<[string, string]> = [
    ["Add error handling page", "feat"],
    ["Add bug report form", "feat"],
    ["Fix login crash", "fix"],
    ["Bug: x", "fix"],
    ["crash when saving", "fix"],
    ["Add feature\nfix the crash too", "feat"],
  ];
  for (const [task, type] of table) assert.equal(inferCommitType(task), type, task);
});

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("remoteBranchExists matches exact refs/heads only", () => {
  const dir = makeRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-bare-")) + "/o.git";
  execSync(`git init --bare -b main "${bare}"`, { stdio: "ignore" });
  git(dir, `remote add origin "${bare}"`);
  git(dir, "branch ai/x");
  git(dir, "branch foo/ai/y");
  git(dir, "push origin ai/x foo/ai/y");
  assert.equal(remoteBranchExists(dir, "ai/x"), true);
  assert.equal(remoteBranchExists(dir, "ai/missing"), false);
  assert.equal(remoteBranchExists(dir, "ai/y"), false);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.dirname(bare), { recursive: true, force: true });
});

test("pushAndOpenPR really force-pushes a rebased branch but refuses to clobber unseen-then-fetched collaborator work", () => {
  const { dir, handle } = setupPushRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-real-push-"));
  const bare = path.join(tmp, "o.git");
  execSync(`git init --bare -b main "${bare}"`, { stdio: "ignore" });
  git(dir, `remote add origin "${bare}"`);
  const gh = (args: string[]) =>
    args[1] === "view"
      ? { status: 1, stdout: "", stderr: "none" }
      : { status: 0, stdout: "https://github.com/o/r/pull/1\n", stderr: "" };
  const wt = handle.worktreeDir;

  assert.equal(pushAndOpenPR(handle, "T", "B", { gh }), "https://github.com/o/r/pull/1");
  assert.equal(remoteBranchExists(wt, handle.branch), true);

  // Rewrite history locally (amend), then re-push: needs the forced path.
  git(wt, '-c user.email=t@e.com -c user.name=T commit --amend -m "feat: amended"');
  const localTip = git(wt, "rev-parse HEAD").trim();
  assert.doesNotThrow(() => pushAndOpenPR(handle, "T", "B", { gh }));
  assert.equal(git(bare, `rev-parse refs/heads/${handle.branch}`).trim(), localTip);

  // Collaborator pushes to the same branch from another clone.
  const other = path.join(tmp, "other");
  execSync(`git clone -q "${bare}" "${other}"`, { stdio: "ignore" });
  git(other, `checkout -q ${handle.branch}`);
  fs.writeFileSync(path.join(other, "collab.txt"), "collab\n");
  git(other, "add -A");
  git(other, '-c user.email=c@e.com -c user.name=C commit -q -m "collab"');
  git(other, `push -q origin ${handle.branch}`);
  const collabTip = git(other, "rev-parse HEAD").trim();

  // Fetch without integrating, amend again, push must be rejected.
  git(wt, "fetch origin");
  git(wt, '-c user.email=t@e.com -c user.name=T commit --amend -q -m "feat: amended again"');
  assert.throws(() => pushAndOpenPR(handle, "T", "B", { gh }));
  assert.equal(git(bare, `rev-parse refs/heads/${handle.branch}`).trim(), collabTip);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("removeCleanupTargets keeps a worktree that became dirty after listing", () => {
  const dir = makeRepo();
  const h = createWorktree(dir, "main", "late dirty");
  const targets = listCleanupTargets(dir, "main");
  assert.equal(targets.worktrees[0].dirty, false);
  const late = path.join(h.worktreeDir, "late.txt");
  fs.writeFileSync(late, "unsaved\n");
  const res = removeCleanupTargets(targets);
  assert.equal(res.removedWorktrees.length, 0);
  assert.equal(res.skippedWorktrees.length, 1);
  assert.equal(fs.existsSync(late), true);
  assert.equal(branchList(dir).includes(h.branch), true);
  assert.deepEqual(res.removedBranches, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("forceRemovableBranches excludes branches checked out in main", () => {
  const dir = makeRepo();
  const h = createWorktree(dir, "main", "fr one");
  fs.writeFileSync(path.join(h.worktreeDir, "w.txt"), "w\n");
  commitAll(h.worktreeDir, "feat: w");
  git(dir, "checkout -q -b ai/checked-out-main");
  git(dir, '-c user.email=t@e.com -c user.name=T commit --allow-empty -q -m extra');
  git(dir, "checkout -q main");
  git(dir, "checkout -q ai/checked-out-main");
  const targets = listCleanupTargets(dir, "main");
  assert.equal(targets.branches.find((b) => b.name === "ai/checked-out-main")?.checkedOutInMain, true);
  const res = removeCleanupTargets(targets);
  assert.ok(res.skippedBranches.includes("ai/checked-out-main"));
  assert.ok(res.skippedBranches.includes(h.branch));
  assert.deepEqual(res.forceRemovableBranches, [h.branch]);
  fs.rmSync(dir, { recursive: true, force: true });
});
