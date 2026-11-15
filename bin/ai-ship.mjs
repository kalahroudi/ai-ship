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
import { createRestApi, discoverDesktopService, findDesktopCli } from "../src/oc2/api.ts";
import { spawnSync } from "node:child_process";
import { createLazyRunner, createOc2Runner } from "../src/oc2/runner.ts";
import { formatProgressEvent, throttleSink } from "../src/progress.ts";
import { formatSafetyFindings, scanWorktreeSafety } from "../src/safety.ts";
import { buildGatewayProvider, formatCatalog, loadCatalog, syncCatalog } from "../src/catalog.ts";
import { computeBudgetStatus, formatBudgetReport, loadBudgetConfig, monthStart, readLedger } from "../src/budget.ts";
import { getModelsFilePath } from "../src/pricing.ts";
import { planRouting } from "../src/pipeline.ts";
import { formatDoctor, initRepo as initRepoFiles, installPlugin, runDoctor, uninstallPlugin } from "../src/doctor.ts";

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
  --model <id>       Implementer model override (provider/model for opencode; alias/id for claude-code)
  --tester-model <id>     Tester model override (must differ from the implementer)
  --reviewer-model <id>   Reviewer model override (must differ from the implementer)
  --bughunter-model <id>  Bughunter model override (must differ from the implementer)
  --server <url>     Attach to a running \`opencode serve\` URL (visible on mobile/web)
  --context-lens [url]  Route OpenCode provider requests through Context Lens proxy (default: http://localhost:4040)
  --attach           Run agents on the OpenCode Desktop 2.x service: each agent is a live subagent session
  --dream            Consolidate repo memory from recent OpenCode transcripts
  --pr               Push branch and open GitHub PR after all 4 stages pass
  --draft            Open the PR as a GitHub Draft PR (implies --pr)
  --worktree <dir>   Reuse an existing ai-ship worktree to iterate on its branch
  --skip-tests       Skip Stage 2 independent adversarial test generation
  --skip-review      Skip Stage 4 parallel multi-lens review
  --skip-bughunter   Skip Stage 4b adversarial Hunter -> Skeptic -> Referee pass
  --allow-config-change  Let agents change protected verify/config files (.ai-ship.json, package.json scripts, CI, test config)
  --init             Copy starter AGENTS.md and .ai-ship.json into target repo
  --route            Dry run: classify the task and print the role → model routing plan (no changes)
  --tag <tag>        Task tag such as size:L or risk:high (overrides the classifier; repeatable)
  --budget           Show month-to-date spend vs the £ budget, forecast and breakdowns (ledger: ~/.local/share/ai-ship/ledger.jsonl)
  --override-budget  Run a task even when the monthly budget governor is in STOP state
  --models           List the model catalog (~/.config/ai-ship/models.json) and gateway settings
  --models-sync      Send a 1-token request per enabled catalog model through the Cloudflare AI Gateway
  --models-opencode-config  Print an OpenCode "provider" entry for the gateway (paste into opencode.json for Desktop)
  --doctor [--fix]   Check the OpenCode 2.x native-plugin setup (--fix removes a duplicate ai-ship MCP entry, with backup)
  --plugin-install   Install the native OpenCode 2.x plugin (~/.config/opencode/plugins/ai-ship.ts)
  --plugin-uninstall Remove the native plugin file created by --plugin-install
  --cleanup          List and remove leftover ai-ship worktrees and ai/* branches (prompts for confirmation)
  --safety-check     Scan repo/worktree diff and untracked files for leaked deployment config, secrets, keys, emails, and IDs
  -y, --yes          Skip confirmation prompt when running --cleanup
  --force            With --cleanup: also remove dirty worktrees, orphan dirs and unmerged ai/* branches
  --cf <acct> <gw> [provider]  Point ~/.config/opencode/opencode.json at Cloudflare AI Gateway
  -h, --help         Show this help
`);
}

/**
 * @param {string} accountId
 * @param {string} gatewayId
 * @param {string | undefined} targetProvider
 */
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

/** @param {string} repoDir */
function initRepo(repoDir) {
  for (const line of initRepoFiles(repoDir, path.resolve(import.meta.dirname, "..", "templates"))) {
    console.log(`[ai-ship] ${line}`);
  }
}

/** @param {string} question */
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

/**
 * @param {string} repoDir
 * @param {boolean} skipConfirm
 * @param {boolean} force
 */
async function cleanupRepo(repoDir, skipConfirm, force) {
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
        wt.dirty ? (force ? "uncommitted changes" : "uncommitted changes, kept without --force") : null,
        !wt.registered && !force ? "kept without --force" : null,
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
      console.log(`  - ${br.name} [${br.merged ? "merged" : force ? "unmerged" : "unmerged, kept without --force"}]`);
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
      force
        ? "Are you sure you want to permanently delete ALL listed worktrees and branches, including uncommitted changes and unmerged branches? [y/N] "
        : "Are you sure you want to permanently delete the listed clean worktrees and merged branches (dirty/unmerged ones are kept)? [y/N] "
    );
    if (!confirmed) {
      console.log("[ai-ship] Cleanup cancelled.");
      return;
    }
  }

  const result = removeCleanupTargets(targets, { force });
  console.log(
    `[ai-ship] Removed ${result.removedWorktrees.length} worktree(s) and ${result.removedBranches.length} branch(es).`
  );
  if (result.skippedWorktrees.length > 0) {
    console.log(`[ai-ship] Kept worktree(s) with uncommitted changes or orphan dirs: ${result.skippedWorktrees.join(", ")}`);
  }
  if (result.skippedBranches.length > 0) {
    console.log(`[ai-ship] Kept branch(es): ${result.skippedBranches.join(", ")}`);
  }
  if (!force && (result.skippedWorktrees.length > 0 || result.forceRemovableBranches.length > 0)) {
    console.log(
      "[ai-ship] Re-run with --force to remove the kept worktrees and unmerged branches too (squash-merged branches count as unmerged)."
    );
  }
}

const args = process.argv.slice(2);
if (args.includes("--mcp")) {
  startMcpServer();
} else {
  await runCli(args);
}

/** @param {string[]} args */
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
  allowConfigChange,
  doInit,
  doCleanup,
  doSafetyCheck,
  doDream,
  skipConfirm,
  force,
  notyAddress,
  notyDir,
  rawProvider,
  model,
  testerModel,
  reviewerModel,
  bughunterModel,
  serverUrl,
  contextLens,
  attach,
  positional,
} = parsed;

if (doInit) {
  initRepo(repoDir);
  process.exit(0);
}

if (parsed.routeOnly) {
  const taskText = parsed.positional.join(" ").trim();
  if (!taskText) {
    console.error("Error: --route needs a task description.");
    process.exit(1);
  }
  const r = planRouting({ config: { ...loadRepoConfig(repoDir), router: true }, task: taskText, repoDir, tags: parsed.tags });
  console.log(`Task: ${r.classification.size}/${r.classification.risk} ${r.classification.kind} — ${r.classification.reasons.join("; ")}`);
  console.log(`Budget: ${r.inputs.budget}`);
  if (!r.plan) console.log("No enabled catalog models (see ~/.config/ai-ship/models.json).");
  else for (const line of r.lines) console.log(line);
  process.exit(0);
}

if (parsed.doBudget) {
  const { catalog } = loadCatalog();
  const gbpPerUsd = 1 / catalog.fx.GBPUSD;
  const now = new Date();
  const entries = readLedger(undefined, monthStart(now));
  const budgetCfg = loadBudgetConfig(loadRepoConfig(repoDir).budget, getModelsFilePath());
  const status = computeBudgetStatus({ entries, budget: budgetCfg, gbpPerUsd, now });
  for (const line of formatBudgetReport(status, entries, gbpPerUsd, { countSubscription: budgetCfg.countSubscription })) console.log(line);
  process.exit(0);
}

if (parsed.modelsAction) {
  const { catalog, problems } = loadCatalog();
  for (const p of problems) console.log(`[ai-ship] models.json: ${p}`);
  if (parsed.modelsAction === "list") {
    for (const line of formatCatalog(catalog)) console.log(line);
  } else if (parsed.modelsAction === "opencode-config") {
    const aig = buildGatewayProvider(catalog);
    if (!aig) {
      console.error("No enabled gateway in models.json.");
      process.exit(1);
    }
    console.log(JSON.stringify({ provider: { aig } }, null, 2));
  } else {
    const results = await syncCatalog(catalog);
    for (const r of results) console.log(`${r.ok ? "✔" : "✖"} ${r.id} ${r.ms}ms ${r.detail}`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
  process.exit(0);
}

if (parsed.pluginAction === "install") {
  const file = installPlugin({ pluginEntry: path.resolve(import.meta.dirname, "..", "plugin", "v2", "index.ts") });
  console.log(`[ai-ship] Installed native plugin: ${file}\n[ai-ship] Restart OpenCode Desktop, then run /ship-doctor.`);
  process.exit(0);
}
if (parsed.pluginAction === "uninstall") {
  const file = uninstallPlugin();
  console.log(file ? `[ai-ship] Removed ${file}` : "[ai-ship] Native plugin not installed.");
  process.exit(0);
}
if (parsed.doDoctor) {
  const cli = findDesktopCli();
  const version = cli ? (spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 10_000 }).stdout ?? "").trim() : undefined;
  const res = runDoctor({ fix: parsed.doFix, ...(version ? { opencodeVersion: version } : {}) });
  console.log(formatDoctor(res));
  process.exit(res.checks.every((c) => c.ok) ? 0 : 1);
}

if (doCleanup) {
  await cleanupRepo(repoDir, skipConfirm, force);
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

const onEvent = throttleSink((e) => console.log(formatProgressEvent(e)), 1000);
/** @type {ReturnType<typeof createLazyRunner> | undefined} */
let lazy;
if (attach) {
  const svc = serverUrl ? { baseUrl: serverUrl, password: process.env.OPENCODE_SERVER_PASSWORD } : discoverDesktopService();
  if (!svc) {
    console.error("Error: --attach could not find the OpenCode Desktop service (set OPENCODE_SERVER_URL / OPENCODE_SERVER_PASSWORD).");
    process.exit(1);
  }
  console.log(`[ai-ship] Attaching to OpenCode 2.x service at ${svc.baseUrl}`);
  const api = createRestApi(svc);
  const roleModels = { implementer: model, tester: testerModel, reviewer: reviewerModel, bughunter: bughunterModel };
  lazy = createLazyRunner((dir) => createOc2Runner({ api, worktreeDir: dir, config: loadRepoConfig(repoDir), task, roleModels, onEvent }));
}

await runPipeline({ repoDir, worktreeDir, task, openPr, draft, skipTests, skipReview, skipBughunter, allowConfigChange, provider, model, testerModel, reviewerModel, bughunterModel, serverUrl: attach ? undefined : serverUrl, contextLens, onEvent, overrideBudget: parsed.overrideBudget, tags: parsed.tags, ...(lazy ? { runner: lazy.runner, onWorktree: lazy.onWorktree } : {}) });
}
