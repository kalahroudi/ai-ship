#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { listCleanupTargets, removeCleanupTargets } from "../src/git.ts";
import { runPipeline } from "../src/pipeline.ts";
import { normalizeProvider } from "../src/runner.ts";

function printHelp() {
  console.log(`ai-ship — project-agnostic OpenCode & Claude Code delivery pipeline

Usage:
  ai-ship "<task description>" [--repo <dir>] [--provider <name>] [--model <id>] [--pr] [--skip-tests] [--skip-review]
  ai-ship --init [--repo <dir>]
  ai-ship --cleanup [--repo <dir>] [--yes]
  ai-ship --cf <account_id> <gateway_id>

Options:
  --repo <dir>       Target git repository (default: current directory)
  --provider <name>  Runner provider: opencode (default, openrouter/cloudflare) or claude-code
  --model <id>       Model ID override (defaults to sonnet-5-5 for claude-code)
  --pr               Push branch and open GitHub PR after all 4 stages pass
  --skip-tests       Skip Stage 2 independent adversarial test generation
  --skip-review      Skip Stage 4 parallel multi-lens review
  --init             Copy starter AGENTS.md and .ai-ship.json into target repo
  --cleanup          List and remove leftover ai-ship worktrees and ai/* branches (prompts for confirmation)
  -y, --yes          Skip confirmation prompt when running --cleanup
  --cf <acct> <gw>   Point ~/.config/opencode/opencode.json at Cloudflare AI Gateway
  -h, --help         Show this help
`);
}

function configureCloudflareGateway(accountId, gatewayId) {
  const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const baseURL = `https://gateway.cloudflare.com/v1/${accountId}/${gatewayId}/openrouter`;
  cfg.provider = cfg.provider ?? {};
  cfg.provider.openrouter = cfg.provider.openrouter ?? {};
  cfg.provider.openrouter.options = cfg.provider.openrouter.options ?? {};
  cfg.provider.openrouter.options.baseURL = baseURL;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  console.log(`[ai-ship] Updated ${configPath}`);
  console.log(`[ai-ship] OpenRouter requests now route via: ${baseURL}`);
}

function initRepo(repoDir) {
  const templatesDir = path.resolve(import.meta.dirname, "..", "templates");
  for (const file of ["AGENTS.md", ".ai-ship.json"]) {
    const dest = path.join(repoDir, file);
    if (fs.existsSync(dest)) {
      console.log(`[ai-ship] Skipping ${file} (already exists at ${dest})`);
    } else {
      fs.copyFileSync(path.join(templatesDir, file), dest);
      console.log(`[ai-ship] Created ${dest}`);
    }
  }
}

async function confirmPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

async function cleanupRepo(repoDir, skipConfirm) {
  const targets = listCleanupTargets(repoDir);
  const deletableBranches = targets.branches.filter((b) => !b.checkedOutInMain);
  const checkedOutBranches = targets.branches.filter((b) => b.checkedOutInMain);

  if (targets.worktrees.length === 0 && deletableBranches.length === 0) {
    console.log(`[ai-ship] No leftover worktrees or ai/* branches found in ${targets.repoDir}.`);
    for (const br of checkedOutBranches) {
      console.log(`[ai-ship] Note: "${br.name}" is currently checked out in the main repo and was skipped.`);
    }
    return;
  }

  console.log(`\n[ai-ship] Found leftover items in ${targets.repoDir}:\n`);
  if (targets.worktrees.length > 0) {
    console.log(`Worktrees (${targets.worktrees.length}):`);
    for (const wt of targets.worktrees) {
      const rel = path.relative(targets.repoDir, wt.path) || wt.path;
      const flags = [
        wt.branch ? `branch: ${wt.branch}` : "untracked/orphaned dir",
        wt.dirty ? "uncommitted changes" : null,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(`  - ${rel} (${flags})`);
    }
    console.log("");
  }

  if (deletableBranches.length > 0) {
    console.log(`Branches (${deletableBranches.length}):`);
    for (const br of deletableBranches) {
      console.log(`  - ${br.name} [${br.merged ? "merged" : "unmerged"}]`);
    }
    console.log("");
  }

  if (checkedOutBranches.length > 0) {
    for (const br of checkedOutBranches) {
      console.log(`[ai-ship] Skipping "${br.name}" (currently checked out in main repo).`);
    }
    console.log("");
  }

  if (!skipConfirm) {
    const confirmed = await confirmPrompt(
      "Are you sure you want to permanently delete these worktrees and branches? [y/N] "
    );
    if (!confirmed) {
      console.log("[ai-ship] Cleanup cancelled.");
      return;
    }
  }

  const result = removeCleanupTargets(targets);
  console.log(
    `[ai-ship] Removed ${result.removedWorktrees.length} worktree(s) and ${result.removedBranches.length} branch(es).`
  );
  if (result.skippedBranches.length > 0) {
    console.log(`[ai-ship] Skipped branch(es): ${result.skippedBranches.join(", ")}`);
  }
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
  printHelp();
  process.exit(0);
}

let repoDir = process.cwd();
let openPr = false;
let skipTests = false;
let skipReview = false;
let doInit = false;
let doCleanup = false;
let skipConfirm = false;
let rawProvider;
let model;
const positional = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--repo" && args[i + 1]) {
    repoDir = path.resolve(args[++i]);
  } else if (arg.startsWith("--repo=")) {
    repoDir = path.resolve(arg.slice("--repo=".length));
  } else if (arg === "--provider" && args[i + 1]) {
    rawProvider = args[++i];
  } else if (arg.startsWith("--provider=")) {
    rawProvider = arg.slice("--provider=".length);
  } else if (arg === "--model" && args[i + 1]) {
    model = args[++i];
  } else if (arg.startsWith("--model=")) {
    model = arg.slice("--model=".length);
  } else if (arg === "--pr") {
    openPr = true;
  } else if (arg === "--skip-tests") {
    skipTests = true;
  } else if (arg === "--skip-review") {
    skipReview = true;
  } else if (arg === "--init") {
    doInit = true;
  } else if (arg === "--cleanup") {
    doCleanup = true;
  } else if (arg === "--yes" || arg === "-y") {
    skipConfirm = true;
  } else if ((arg === "--cf" || arg === "-cf") && args[i + 1] && args[i + 2]) {
    configureCloudflareGateway(args[i + 1], args[i + 2]);
    process.exit(0);
  } else if (arg.startsWith("-")) {
    console.error(`Error: unknown or incomplete option "${arg}".`);
    printHelp();
    process.exit(1);
  } else {
    positional.push(arg);
  }
}

if (doInit) {
  initRepo(repoDir);
  process.exit(0);
}

if (doCleanup) {
  await cleanupRepo(repoDir, skipConfirm);
  process.exit(0);
}

const provider = normalizeProvider(rawProvider);
const task = positional.join(" ").trim();
if (!task) {
  console.error("Error: please provide a task description.");
  printHelp();
  process.exit(1);
}

await runPipeline({ repoDir, task, openPr, skipTests, skipReview, provider, model });
