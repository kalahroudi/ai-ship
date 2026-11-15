import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAiShipPlugin } from "../plugin/index.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepoWithWorktree() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-plugin-test-")));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  const wt = path.join(repo, ".ai-ship-worktrees", "task-one");
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, "worktree", "add", "-b", "ai/task-one", wt, "main");
  return { repo, wt };
}

function chain(): any {
  const c: any = {};
  c.optional = () => c;
  c.describe = () => c;
  return c;
}

async function loadHooks(repo: string) {
  const fakeTool: any = (input: unknown) => input;
  fakeTool.schema = { string: chain, boolean: chain };
  const factory = createAiShipPlugin(fakeTool);
  return (await factory({ client: {} as any, directory: repo, worktree: repo })) as any;
}

test("cleanup_worktrees without confirm is a dry run and removes nothing", async () => {
  const { repo, wt } = makeRepoWithWorktree();
  try {
    const hooks = await loadHooks(repo);
    const out = await hooks.tool.cleanup_worktrees.execute({}, { directory: repo, worktree: repo });
    assert.match(out, /Dry run/);
    assert.ok(fs.existsSync(wt));
    assert.match(git(repo, "branch", "--list", "ai/*"), /ai\/task-one/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup_worktrees with confirm removes the ai-ship worktree and branch", async () => {
  const { repo, wt } = makeRepoWithWorktree();
  try {
    const hooks = await loadHooks(repo);
    const out = await hooks.tool.cleanup_worktrees.execute(
      { confirm: true },
      { directory: repo, worktree: repo }
    );
    assert.equal(out, "Removed 1 worktree(s) and 1 branch(es).");
    assert.ok(!fs.existsSync(wt));
    assert.equal(git(repo, "branch", "--list", "ai/*").trim(), "");
    assert.doesNotMatch(git(repo, "worktree", "list"), /task-one/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
