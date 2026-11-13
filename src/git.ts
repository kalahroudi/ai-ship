import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectDefaultBaseBranch, detectPackageManager } from "./config.ts";

export interface WorktreeHandle {
  repoDir: string;
  worktreeDir: string;
  branch: string;
  baseBranch: string;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
}

export type PnpmRunner = (args: string[], cwd: string, quiet: boolean) => number | null;

function defaultPnpmRunner(args: string[], cwd: string, quiet: boolean): number | null {
  const res = spawnSync("pnpm", args, {
    cwd,
    stdio: quiet ? "ignore" : "inherit",
  });
  return res.status;
}

export function setupWorktreeDependencies(
  repoDir: string,
  worktreeDir: string,
  runPnpm: PnpmRunner = defaultPnpmRunner
): void {
  if (!fs.existsSync(path.join(worktreeDir, "package.json"))) return;
  if (fs.existsSync(path.join(worktreeDir, "node_modules"))) return;

  // pnpm refuses to run when node_modules is a symlink (ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH)
  // and workspace packages need their own node_modules directories.
  if (detectPackageManager(worktreeDir) === "pnpm") {
    const hasLockfile = fs.existsSync(path.join(worktreeDir, "pnpm-lock.yaml"));
    const baseArgs = ["install", ...(hasLockfile ? ["--frozen-lockfile"] : [])];
    console.log("[ai-ship] Installing pnpm dependencies in worktree...");
    if (runPnpm([...baseArgs, "--offline"], worktreeDir, true) === 0) return;
    if (runPnpm([...baseArgs, "--prefer-offline"], worktreeDir, false) === 0) return;
    throw new Error(`pnpm install failed in worktree ${worktreeDir}`);
  }

  const mainModules = path.join(repoDir, "node_modules");
  if (fs.existsSync(mainModules)) {
    fs.symlinkSync(mainModules, path.join(worktreeDir, "node_modules"), "dir");
  }
}

export function resolveFreshBaseRef(repoDir: string, baseBranch: string): string {
  const hasOrigin =
    spawnSync("git", ["remote", "get-url", "origin"], { cwd: repoDir, stdio: "ignore" }).status === 0;
  if (hasOrigin) {
    spawnSync("git", ["fetch", "origin", baseBranch], { cwd: repoDir, stdio: "ignore" });
    const remoteRef = `origin/${baseBranch}`;
    const hasRemoteRef =
      spawnSync("git", ["rev-parse", "--verify", remoteRef], { cwd: repoDir, stdio: "ignore" }).status === 0;
    if (hasRemoteRef) return remoteRef;
  }
  return baseBranch;
}

export function createWorktree(repoDir: string, baseBranch: string, task: string): WorktreeHandle {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = `${slugify(task)}-${stamp}`;
  const branch = `ai/${slug}`;
  const root = path.join(repoDir, ".ai-ship-worktrees");
  const worktreeDir = path.join(root, slug);
  const startRef = resolveFreshBaseRef(repoDir, baseBranch);

  fs.mkdirSync(root, { recursive: true });
  execSync(`git worktree add -b "${branch}" "${worktreeDir}" "${startRef}"`, {
    cwd: repoDir,
    stdio: "inherit",
  });

  setupWorktreeDependencies(repoDir, worktreeDir);

  return { repoDir, worktreeDir, branch, baseBranch };
}

export function getDiff(worktreeDir: string, baseBranch: string): string {
  try {
    const committed = execSync(`git diff "${baseBranch}...HEAD"`, {
      cwd: worktreeDir,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const unstaged = execSync("git diff", {
      cwd: worktreeDir,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const untrackedList = execSync("git ls-files --others --exclude-standard", {
      cwd: worktreeDir,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);

    let untracked = "";
    for (const file of untrackedList.slice(0, 20)) {
      if (file.includes("shared-diff-context.txt")) continue;
      const full = path.join(worktreeDir, file);
      if (fs.statSync(full).size > 64 * 1024) continue;
      untracked += `\n--- /dev/null\n+++ b/${file}\n${fs.readFileSync(full, "utf8")}\n`;
    }

    return [committed, unstaged, untracked].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

export function runShell(command: string, cwd: string): { ok: boolean; output: string } {
  const res = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
  return { ok: res.status === 0, output };
}

export function commitAll(worktreeDir: string, message: string): boolean {
  const status = execSync("git status --porcelain", { cwd: worktreeDir, encoding: "utf8" }).trim();
  if (!status) return false;
  execSync("git add -A", { cwd: worktreeDir, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", message], { cwd: worktreeDir, stdio: "inherit" });
  return true;
}

export interface RebaseResult {
  updated: boolean;
  conflicted: boolean;
  targetRef: string;
  conflictedFiles: string[];
}

export function isRebaseInProgress(worktreeDir: string): boolean {
  const gitDirRes = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: worktreeDir,
    encoding: "utf8",
  });
  if (gitDirRes.status !== 0) return false;
  const gitDir = path.resolve(worktreeDir, gitDirRes.stdout.trim());
  return fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"));
}

export function abortRebase(worktreeDir: string): void {
  spawnSync("git", ["rebase", "--abort"], { cwd: worktreeDir, stdio: "ignore" });
}

export function rebaseOntoBase(worktree: WorktreeHandle): RebaseResult {
  const targetRef = resolveFreshBaseRef(worktree.worktreeDir, worktree.baseBranch);
  const aheadRes = spawnSync("git", ["rev-list", "--count", `HEAD..${targetRef}`], {
    cwd: worktree.worktreeDir,
    encoding: "utf8",
  });
  const behindCount = aheadRes.status === 0 ? Number(aheadRes.stdout.trim()) : 0;
  if (!behindCount) {
    return { updated: false, conflicted: false, targetRef, conflictedFiles: [] };
  }

  const rebaseRes = spawnSync("git", ["rebase", targetRef], {
    cwd: worktree.worktreeDir,
    encoding: "utf8",
  });
  if (rebaseRes.status === 0) {
    return { updated: true, conflicted: false, targetRef, conflictedFiles: [] };
  }

  const conflictsRes = spawnSync("git", ["diff", "--name-only", "--diff-filter=U"], {
    cwd: worktree.worktreeDir,
    encoding: "utf8",
  });
  const conflictedFiles = (conflictsRes.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  return { updated: true, conflicted: true, targetRef, conflictedFiles };
}

export function pushAndOpenPR(worktree: WorktreeHandle, title: string, body: string): void {
  execSync(`git push -u origin "${worktree.branch}"`, {
    cwd: worktree.worktreeDir,
    stdio: "inherit",
  });
  spawnSync(
    "gh",
    ["pr", "create", "--base", worktree.baseBranch, "--head", worktree.branch, "--title", title, "--body", body],
    { cwd: worktree.worktreeDir, stdio: "inherit" }
  );
}

export interface WorktreeCleanupItem {
  path: string;
  branch: string | null;
  dirty: boolean;
  registered: boolean;
}

export interface BranchCleanupItem {
  name: string;
  merged: boolean;
  checkedOutInMain: boolean;
}

export interface CleanupTargets {
  repoDir: string;
  worktreeRoot: string;
  worktrees: WorktreeCleanupItem[];
  branches: BranchCleanupItem[];
}

function safeRealpath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isSubpath(parentDir: string, candidatePath: string): boolean {
  const rel = path.relative(parentDir, candidatePath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isWorktreeDirty(worktreePath: string): boolean {
  if (!fs.existsSync(worktreePath)) return false;
  const res = spawnSync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  return res.status === 0 && res.stdout.trim().length > 0;
}

function parseWorktreePorcelain(raw: string): Array<{ path: string; branch: string | null }> {
  const entries: Array<{ path: string; branch: string | null }> = [];
  let current: { path: string; branch: string | null } | null = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: safeRealpath(line.slice("worktree ".length).trim()), branch: null };
    } else if (line.startsWith("branch ") && current) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line.trim() === "" && current) {
      entries.push(current);
      current = null;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function listCleanupTargets(repoDir: string, baseBranch?: string): CleanupTargets {
  const resolvedRepoDir = safeRealpath(repoDir);
  const gitCheck = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: resolvedRepoDir,
    encoding: "utf8",
  });
  if (gitCheck.status !== 0) {
    throw new Error(`Not a git repository: ${repoDir}`);
  }

  const worktreeRoot = path.join(resolvedRepoDir, ".ai-ship-worktrees");
  const listRes = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: resolvedRepoDir,
    encoding: "utf8",
  });
  if (listRes.status !== 0) {
    throw new Error(`Failed to list git worktrees in ${repoDir}: ${listRes.stderr.trim()}`);
  }

  const registered = parseWorktreePorcelain(listRes.stdout);
  const worktrees: WorktreeCleanupItem[] = [];
  const seenPaths = new Set<string>();

  for (const entry of registered) {
    if (entry.path === resolvedRepoDir) continue;
    const inRoot = isSubpath(worktreeRoot, entry.path);
    const isAiBranch = entry.branch !== null && entry.branch.startsWith("ai/");
    if (!inRoot && !isAiBranch) continue;

    seenPaths.add(entry.path);
    worktrees.push({
      path: entry.path,
      branch: entry.branch,
      dirty: isWorktreeDirty(entry.path),
      registered: true,
    });
  }

  if (fs.existsSync(worktreeRoot)) {
    for (const dirent of fs.readdirSync(worktreeRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const dirPath = safeRealpath(path.join(worktreeRoot, dirent.name));
      if (seenPaths.has(dirPath)) continue;
      worktrees.push({
        path: dirPath,
        branch: null,
        dirty: isWorktreeDirty(dirPath),
        registered: false,
      });
    }
  }

  const currentMainBranch = spawnSync("git", ["branch", "--show-current"], {
    cwd: resolvedRepoDir,
    encoding: "utf8",
  }).stdout.trim();

  const resolvedBase = baseBranch || detectDefaultBaseBranch(resolvedRepoDir);
  const mergedSet = new Set<string>();
  const mergedRes = spawnSync("git", ["branch", "--merged", resolvedBase, "--format=%(refname:short)"], {
    cwd: resolvedRepoDir,
    encoding: "utf8",
  });
  if (mergedRes.status === 0) {
    for (const name of mergedRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
      mergedSet.add(name);
    }
  }

  const branchRes = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/ai/"], {
    cwd: resolvedRepoDir,
    encoding: "utf8",
  });
  const branches: BranchCleanupItem[] = branchRes.status === 0
    ? branchRes.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({
          name,
          merged: mergedSet.has(name),
          checkedOutInMain: name === currentMainBranch,
        }))
    : [];

  return { repoDir: resolvedRepoDir, worktreeRoot, worktrees, branches };
}

export function removeCleanupTargets(targets: CleanupTargets): {
  removedWorktrees: string[];
  removedBranches: string[];
  skippedBranches: string[];
} {
  const removedWorktrees: string[] = [];
  const removedBranches: string[] = [];
  const skippedBranches: string[] = [];

  for (const wt of targets.worktrees) {
    if (wt.registered) {
      spawnSync("git", ["worktree", "remove", "--force", wt.path], {
        cwd: targets.repoDir,
        stdio: "ignore",
      });
    }
    if (fs.existsSync(wt.path)) {
      fs.rmSync(wt.path, { recursive: true, force: true });
    }
    removedWorktrees.push(wt.path);
  }

  spawnSync("git", ["worktree", "prune"], {
    cwd: targets.repoDir,
    stdio: "ignore",
  });

  if (fs.existsSync(targets.worktreeRoot) && fs.readdirSync(targets.worktreeRoot).length === 0) {
    fs.rmdirSync(targets.worktreeRoot);
  }

  for (const br of targets.branches) {
    if (br.checkedOutInMain) {
      skippedBranches.push(br.name);
      continue;
    }
    const res = spawnSync("git", ["branch", "-D", br.name], {
      cwd: targets.repoDir,
      stdio: "ignore",
    });
    if (res.status === 0) {
      removedBranches.push(br.name);
    } else {
      skippedBranches.push(br.name);
    }
  }

  return { removedWorktrees, removedBranches, skippedBranches };
}
