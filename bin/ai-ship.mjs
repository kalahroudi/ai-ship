#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { listCleanupTargets, removeCleanupTargets } from "../src/git.ts";
import { loadRepoConfig, parseCliArgs } from "../src/config.ts";
import { startMcpServer } from "../src/mcp.ts";
import { parseNotyAddress, resolveNotyTask } from "../src/noty.ts";
import { runDreamConsolidation, runPipeline } from "../src/pipeline.ts";
import { normalizeProvider } from "../src/runner.ts";
import { formatSafetyFindings, scanWorktreeSafety } from "../src/safety.ts";

function printHelp() {
  console.log(`ai-ship — project-agnostic OpenCode & Claude Code delivery pipeline

Usage:
  ai-ship "<task description or noty://item/...>" [--repo <dir>] [--worktree <dir>] [--provider <name>] [--model <id>] [--server <url>] [--pr] [--draft] [--skip-tests] [--skip-review]
  ai-ship --noty <noty://item/...> [--noty-dir <dir>] [--repo <dir>] [options]
  ai-ship --dream [--repo <dir>] [--server <url>] [--model <id>]
  ai-ship --init [--repo <dir>]
  ai-ship --cleanup [--repo <dir>] [--yes]
  ai-ship --safety-check [--repo <dir>]
  ai-ship --cf <account_id> <gateway_id> [provider]
  ai-ship --mcp

Options:
  --repo <dir>       Target git repository (default: current directory)
  --noty <uri>       Resolve task description from a Noty item URI (noty://item/<uuid>)
  --noty-dir <dir>   Override Noty markdown directory (or set NOTY_DIR)
  --provider <name>  Runner provider: opencode (default, deepseek/parasail/telnyx/openrouter/cloudflare) or claude-code
  --model <id>       Model ID override (defaults to sonnet-5-5 for claude-code)
  --server <url>     Attach to a running \`opencode serve\` URL (visible on mobile/web)
  --context-lens [url]  Route OpenCode provider requests through Context Lens proxy (default: http://localhost:4040)
  --dream            Consolidate repo memory from recent OpenCode transcripts
  --pr               Push branch and open GitHub PR after all 4 stages pass
  --draft            Open the PR as a GitHub Draft PR (implies --pr)
  --worktree <dir>   Reuse an existing ai-ship worktree to iterate on its branch
  --skip-tests       Skip Stage 2 independent adversarial test generation
  --skip-review      Skip Stage 4 parallel multi-lens review
  --skip-bughunter   Skip Stage 4b adversarial Hunter -> Skeptic -> Referee pass
  --init             Copy starter AGENTS.md and .ai-ship.json into target repo
  --cleanup          List and remove leftover ai-ship worktrees and ai/* branches (prompts for confirmation)
  --safety-check     Scan repo/worktree diff and untracked files for leaked deployment config, secrets, keys, emails, and IDs
  -y, --yes          Skip confirmation prompt when running --cleanup
  --cf <acct> <gw> [provider]  Point ~/.config/opencode/opencode.json at Cloudflare AI Gateway
  -h, --help         Show this help
`);
}

function configureCloudflareGateway(accountId, gatewayId, targetProvider) {
  const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const cfg = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  cfg.provider = cfg.provider ?? {};

  const providersToUpdate = targetProvider
    ? [targetProvider]
    : Object.keys(cfg.provider).length > 0
      ? Object.keys(cfg.provider)
      : ["deepseek"];

  console.log(`[ai-ship] Updated ${configPath}`);
  for (const providerId of providersToUpdate) {
    const baseURL = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${providerId}`;
    cfg.provider[providerId] = cfg.provider[providerId] ?? {};
    cfg.provider[providerId].options = cfg.provider[providerId].options ?? {};
    cfg.provider[providerId].options.baseURL = baseURL;
    console.log(`[ai-ship] ${providerId} requests now route via: ${baseURL}`);
  }

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
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
if (args.includes("--mcp")) {
  startMcpServer();
} else {
  await runCli(args);
}

async function runCli(args) {
const parsed = parseCliArgs(args);
if (parsed.unknownOption) {
  console.error(`Error: unknown or incomplete option "${parsed.unknownOption}".`);
  printHelp();
  process.exit(1);
}
if (parsed.help) {
  printHelp();
  process.exit(0);
}
if (parsed.cfArgs) {
  configureCloudflareGateway(parsed.cfArgs.accountId, parsed.cfArgs.gatewayId, parsed.cfArgs.provider);
  process.exit(0);
}

const {
  repoDir,
  openPr,
  draft,
  worktreeDir,
  skipTests,
  skipReview,
  skipBughunter,
  doInit,
  doCleanup,
  doSafetyCheck,
  doDream,
  skipConfirm,
  notyAddress,
  notyDir,
  rawProvider,
  model,
  serverUrl,
  contextLens,
  positional,
} = parsed;

if (doInit) {
  initRepo(repoDir);
  process.exit(0);
}

if (doCleanup) {
  await cleanupRepo(repoDir, skipConfirm);
  process.exit(0);
}

if (doSafetyCheck) {
  const cfg = loadRepoConfig(repoDir);
  const res = scanWorktreeSafety(repoDir, {
    baseBranch: cfg.baseBranch,
    allowlist: cfg.safetyAllowlist,
  });
  console.log(formatSafetyFindings(res.findings));
  process.exit(res.ok ? 0 : 1);
}

if (doDream) {
  const res = await runDreamConsolidation({ repoDir, serverUrl, model });
  console.log(`[ai-ship] Dream consolidation: ${res.memoryPath} (${res.usageSummary})`);
  process.exit(0);
}

const provider = normalizeProvider(rawProvider);
let task = positional.join(" ").trim();
const notyInput = notyAddress ?? (parseNotyAddress(task) ? task : null);
if (notyInput) {
  const note = resolveNotyTask(notyInput, notyDir);
  console.log(`[ai-ship] Resolved Noty task "${note.title || note.id}" from ${note.filePath}`);
  task = note.task;
}

if (!task) {
  console.error("Error: please provide a task description.");
  printHelp();
  process.exit(1);
}

await runPipeline({ repoDir, worktreeDir, task, openPr, draft, skipTests, skipReview, skipBughunter, provider, model, serverUrl, contextLens });
}
