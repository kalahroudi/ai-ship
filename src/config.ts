import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface ProviderConfig {
  npm?: string;
  name?: string;
  baseURL?: string;
  options?: {
    baseURL?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    [key: string]: unknown;
  };
  models?: Record<string, unknown>;
}

export interface ModelRef {
  providerID: string;
  id: string;
}

export interface ContextLimits {
  testDiffMaxChars: number;
  reviewDiffMaxChars: number;
  verifyOutputMaxChars: number;
  memoryMaxLines: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  testDiffMaxChars: 40_000,
  reviewDiffMaxChars: 60_000,
  verifyOutputMaxChars: 6_000,
  memoryMaxLines: 120,
};

export const DEFAULT_CONTEXT_LENS_URL = "http://localhost:4040";

export interface RepoConfig {
  baseBranch: string;
  verify: string[];
  testCommand: string | null;
  implementerModel?: ModelRef;
  testerModel?: ModelRef;
  reviewerModel?: ModelRef;
  bughunterModel?: ModelRef;
  implementerFallbackModel?: ModelRef;
  testerFallbackModel?: ModelRef;
  reviewerFallbackModel?: ModelRef;
  bughunterFallbackModel?: ModelRef;
  reviewerLensModels?: Record<string, ModelRef>;
  /** Per-role models for the claude-code runner (aliases like "opus"/"sonnet"/"haiku" or full ids). */
  claudeModels?: Partial<Record<"implementer" | "tester" | "reviewer" | "bughunter", string>>;
  /** Max milliseconds one agent turn may run on a 2.x server before it is interrupted (default 30 min). */
  agentTimeoutMs?: number;
  /** OpenCode 2.x agent per role when running on a 2.x server (e.g. { "reviewer": "plan" }). */
  oc2Agents?: Partial<Record<"implementer" | "tester" | "reviewer" | "bughunter", string>>;
  /** Fail when tester/reviewer/bughunter share the implementer's model (default true). */
  strictIndependence?: boolean;
  reviewConcurrency?: number;
  reviewStaggerMs?: number;
  providers?: Record<string, ProviderConfig>;
  defaultProvider?: string;
  maxFixRetries: number;
  maxReviewRounds: number;
  maxTaskCostUsd?: number;
  maxTaskTokens?: number;
  /** Per-model USD-per-million-token prices (`provider/model` keys), merged over ~/.config/ai-ship/models.json. */
  pricing?: Record<string, { in: number; out: number; cacheRead?: number; cacheWrite?: number; checked?: string }>;
  /** Run the verify commands concurrently (opt-in; only for commands that do not share outputs). */
  verifyParallel?: boolean;
  /** Route role models from the catalog by task size/risk and budget state (opt-in). */
  router?: boolean;
  /** Monthly budget governor (GBP); merged over `budget` in ~/.config/ai-ship/models.json. */
  budget?: { monthlyGBP?: number; reserveGBP?: number; perTaskMaxGBP?: number; softPct?: number };
  /** Fail before any model call if a role's model has no known price (default false: warn). */
  requirePricing?: boolean;
  contextLimits?: Partial<ContextLimits>;
  /** Compact the implementer session once its accumulated input reaches this many tokens (0 disables; default 120000). */
  compactAfterTokens?: number;
  securityScan: boolean;
  safetyCheck: boolean;
  safetyAllowlist?: string[];
  /** Globs of verify/config files agents may not change (default: DEFAULT_PROTECTED_PATHS in integrity.ts). */
  protectedPaths?: string[];
  bughunter?: boolean;
  contextLens?: boolean | string;
  /** Provider whose requests go through Context Lens (default: the implementer's provider). */
  contextLensProvider?: string;
}

export const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    npm: "@ai-sdk/openai-compatible",
    name: "DeepSeek Direct",
    options: {
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "{env:DEEPSEEK_API_KEY}",
    },
  },
  parasail: {
    npm: "@ai-sdk/openai-compatible",
    name: "Parasail.io",
    options: {
      baseURL: "https://api.parasail.io/v1",
      apiKey: "{env:PARASAIL_API_KEY}",
    },
  },
};

const DEFAULT_CONFIG: RepoConfig = {
  baseBranch: "main",
  verify: [],
  testCommand: null,
  implementerModel: { providerID: "deepseek", id: "deepseek-chat" },
  testerModel: { providerID: "parasail", id: "Qwen/Qwen2.5-Coder-32B-Instruct" },
  reviewerModel: { providerID: "deepseek", id: "deepseek-reasoner" },
  bughunterModel: { providerID: "deepseek", id: "deepseek-reasoner" },
  providers: DEFAULT_PROVIDERS,
  defaultProvider: "deepseek",
  maxFixRetries: 3,
  maxReviewRounds: 2,
  maxTaskCostUsd: 5,
  maxTaskTokens: 2_000_000,
  contextLimits: { ...DEFAULT_CONTEXT_LIMITS },
  securityScan: true,
  safetyCheck: true,
  bughunter: true,
};

function mergeProviders(
  base: Record<string, ProviderConfig>,
  overrides?: Record<string, ProviderConfig>
): Record<string, ProviderConfig> {
  const merged: Record<string, ProviderConfig> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(overrides ?? {})]);
  for (const key of keys) {
    const baseCfg = base[key] ?? {};
    const userCfg = overrides?.[key] ?? {};
    const userOptions = {
      ...(userCfg.baseURL ? { baseURL: userCfg.baseURL } : {}),
      ...(userCfg.options ?? {}),
    };
    const baseOptions = {
      ...(baseCfg.baseURL ? { baseURL: baseCfg.baseURL } : {}),
      ...(baseCfg.options ?? {}),
    };
    const { baseURL: _b, ...baseRest } = baseCfg;
    const { baseURL: _u, ...userRest } = userCfg;
    merged[key] = {
      ...baseRest,
      ...userRest,
      options: {
        ...baseOptions,
        ...userOptions,
      },
    };
  }
  return merged;
}

function hasCommand(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function detectPackageManager(repoDir: string): "pnpm" | "bun" | "yarn" | "npm" {
  if (
    fs.existsSync(path.join(repoDir, "pnpm-lock.yaml")) ||
    fs.existsSync(path.join(repoDir, "pnpm-workspace.yaml"))
  ) {
    return "pnpm";
  }
  if (fs.existsSync(path.join(repoDir, "bun.lockb")) || fs.existsSync(path.join(repoDir, "bun.lock"))) return "bun";
  if (fs.existsSync(path.join(repoDir, "yarn.lock"))) return "yarn";
  return "npm";
}

export function detectDefaultBaseBranch(repoDir: string): string {
  try {
    const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parts = ref.split("/");
    return parts[parts.length - 1] || "main";
  } catch {
    try {
      return execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: repoDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "main";
    } catch {
      return "main";
    }
  }
}

export function loadRepoConfig(repoDir: string): RepoConfig {
  const filePath = path.join(repoDir, ".ai-ship.json");
  let userConfig: Partial<RepoConfig> = {};
  if (fs.existsSync(filePath)) {
    userConfig = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<RepoConfig>;
  }

  const baseBranch = userConfig.baseBranch ?? detectDefaultBaseBranch(repoDir);
  const verify = [...(userConfig.verify ?? [])];
  let testCommand = userConfig.testCommand ?? null;

  if (verify.length === 0) {
    const pkgPath = path.join(repoDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const pm = detectPackageManager(repoDir);
      const run = pm === "npm" ? "npm run" : pm;
      const scripts = pkg.scripts ?? {};
      if (scripts.verify) {
        verify.push(`${run} verify`);
      } else {
        for (const name of ["typecheck", "lint", "build", "test"]) {
          if (scripts[name]) verify.push(`${run} ${name}`);
        }
      }
      if (scripts.pentest && !(scripts.verify ?? "").includes("pentest")) {
        verify.push(`${run} pentest`);
      }
      if (!testCommand && scripts.test) testCommand = `${run} test`;
    } else if (fs.existsSync(path.join(repoDir, "Package.swift"))) {
      verify.push("swift test");
      if (!testCommand) testCommand = "swift test";
    } else if (fs.existsSync(path.join(repoDir, "Cargo.toml"))) {
      verify.push("cargo test");
      if (!testCommand) testCommand = "cargo test";
    } else if (fs.existsSync(path.join(repoDir, "go.mod"))) {
      verify.push("go test ./...");
      if (!testCommand) testCommand = "go test ./...";
    } else if (fs.existsSync(path.join(repoDir, "pyproject.toml"))) {
      verify.push("pytest");
      if (!testCommand) testCommand = "pytest";
    }
  }

  const securityScan = userConfig.securityScan ?? DEFAULT_CONFIG.securityScan;
  const safetyCheck = userConfig.safetyCheck ?? DEFAULT_CONFIG.safetyCheck;
  const bughunter = userConfig.bughunter ?? DEFAULT_CONFIG.bughunter;
  const resolveBudgetLimit = (override: number | null | undefined, fallback: number | undefined): number | undefined => {
    if (override === null) return undefined;
    if (typeof override === "number") return override > 0 ? override : undefined;
    return fallback;
  };
  const maxTaskCostUsd = resolveBudgetLimit(userConfig.maxTaskCostUsd, DEFAULT_CONFIG.maxTaskCostUsd);
  const maxTaskTokens = resolveBudgetLimit(userConfig.maxTaskTokens, DEFAULT_CONFIG.maxTaskTokens);
  const resolvePositiveInt = (override: number | undefined, fallback: number): number =>
    typeof override === "number" && Number.isFinite(override) && override > 0
      ? Math.floor(override)
      : fallback;
  const contextLimits: ContextLimits = {
    testDiffMaxChars: resolvePositiveInt(
      userConfig.contextLimits?.testDiffMaxChars,
      DEFAULT_CONTEXT_LIMITS.testDiffMaxChars
    ),
    reviewDiffMaxChars: resolvePositiveInt(
      userConfig.contextLimits?.reviewDiffMaxChars,
      DEFAULT_CONTEXT_LIMITS.reviewDiffMaxChars
    ),
    verifyOutputMaxChars: resolvePositiveInt(
      userConfig.contextLimits?.verifyOutputMaxChars,
      DEFAULT_CONTEXT_LIMITS.verifyOutputMaxChars
    ),
    memoryMaxLines: resolvePositiveInt(
      userConfig.contextLimits?.memoryMaxLines,
      DEFAULT_CONTEXT_LIMITS.memoryMaxLines
    ),
  };
  if (securityScan && hasCommand("semgrep") && !verify.some((c) => c.startsWith("semgrep"))) {
    verify.push("semgrep --error --config p/security-audit --quiet .");
  }

  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    baseBranch,
    verify,
    testCommand,
    providers: mergeProviders(DEFAULT_PROVIDERS, userConfig.providers),
    maxTaskCostUsd,
    maxTaskTokens,
    contextLimits,
    securityScan,
    safetyCheck,
    bughunter,
  };
}

export interface ParsedCliArgs {
  help: boolean;
  repoDir: string;
  openPr: boolean;
  draft: boolean;
  worktreeDir?: string;
  skipTests: boolean;
  skipReview: boolean;
  skipBughunter: boolean;
  allowConfigChange: boolean;
  doInit: boolean;
  doDoctor: boolean;
  doBudget: boolean;
  doReport: boolean;
  routeOnly: boolean;
  tags: string[];
  overrideBudget: boolean;
  modelsAction?: "list" | "sync" | "opencode-config";
  doFix: boolean;
  pluginAction?: "install" | "uninstall";
  doCleanup: boolean;
  doSafetyCheck: boolean;
  doDream: boolean;
  skipConfirm: boolean;
  force: boolean;
  notyAddress?: string;
  notyDir?: string;
  /** Write each task's result back into its Noty note (and mark it done on commit). */
  notyWriteBack?: boolean;
  /** Category runs: how many tasks run at once (1–4, default 1). */
  queueParallel?: number;
  /** Category runs: keep going after a failed task. */
  continueOnFailure?: boolean;
  /** Category runs: only tasks carrying this tag. */
  onlyTag?: string;
  rawProvider?: string;
  model?: string;
  testerModel?: string;
  reviewerModel?: string;
  bughunterModel?: string;
  serverUrl?: string;
  contextLens?: boolean | string;
  /** Attach to the OpenCode Desktop 2.x background service (agents show up as live subagent sessions). */
  attach?: boolean;
  cfArgs?: { accountId: string; gatewayId: string; provider?: string };
  positional: string[];
  unknownOption?: string;
}

/** Provider path segments Cloudflare AI Gateway understands (plus the OpenAI-compatible `compat` endpoint). */
export const KNOWN_CF_PROVIDERS = new Set([
  "deepseek",
  "openrouter",
  "openai",
  "anthropic",
  "groq",
  "mistral",
  "perplexity-ai",
  "google-ai-studio",
  "google-vertex-ai",
  "workers-ai",
  "azure-openai",
  "aws-bedrock",
  "huggingface",
  "cohere",
  "replicate",
  "grok",
  "cerebras",
  "compat",
  "parasail",
  "telnyx",
]);

/** Parses `ai-ship` CLI arguments into a structured options object. */
export function parseCliArgs(args: string[], cwd = process.cwd()): ParsedCliArgs {
  const result: ParsedCliArgs = {
    help: args.length === 0,
    repoDir: cwd,
    openPr: false,
    draft: false,
    skipTests: false,
    skipReview: false,
    skipBughunter: false,
    allowConfigChange: false,
    doInit: false,
    doDoctor: false,
    doBudget: false,
    doReport: false,
    routeOnly: false,
    tags: [],
    overrideBudget: false,
    doFix: false,
    doCleanup: false,
    doSafetyCheck: false,
    doDream: false,
    skipConfirm: false,
    force: false,
    positional: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      result.help = true;
    } else if (arg === "--repo" && args[i + 1]) {
      result.repoDir = path.resolve(cwd, args[++i]);
    } else if (arg.startsWith("--repo=")) {
      result.repoDir = path.resolve(cwd, arg.slice("--repo=".length));
    } else if (arg === "--noty" && args[i + 1]) {
      result.notyAddress = args[++i];
    } else if (arg.startsWith("--noty=")) {
      result.notyAddress = arg.slice("--noty=".length);
    } else if (arg === "--noty-dir" && args[i + 1]) {
      result.notyDir = path.resolve(cwd, args[++i]);
    } else if (arg.startsWith("--noty-dir=")) {
      result.notyDir = path.resolve(cwd, arg.slice("--noty-dir=".length));
    } else if (arg === "--provider" && args[i + 1]) {
      result.rawProvider = args[++i];
    } else if (arg.startsWith("--provider=")) {
      result.rawProvider = arg.slice("--provider=".length);
    } else if (arg === "--model" && args[i + 1]) {
      result.model = args[++i];
    } else if (arg.startsWith("--model=")) {
      result.model = arg.slice("--model=".length);
    } else if (arg === "--tester-model" && args[i + 1]) {
      result.testerModel = args[++i];
    } else if (arg.startsWith("--tester-model=")) {
      result.testerModel = arg.slice("--tester-model=".length);
    } else if (arg === "--reviewer-model" && args[i + 1]) {
      result.reviewerModel = args[++i];
    } else if (arg.startsWith("--reviewer-model=")) {
      result.reviewerModel = arg.slice("--reviewer-model=".length);
    } else if (arg === "--bughunter-model" && args[i + 1]) {
      result.bughunterModel = args[++i];
    } else if (arg.startsWith("--bughunter-model=")) {
      result.bughunterModel = arg.slice("--bughunter-model=".length);
    } else if (arg === "--server" && args[i + 1]) {
      result.serverUrl = args[++i];
    } else if (arg.startsWith("--server=")) {
      result.serverUrl = arg.slice("--server=".length);
    } else if (arg === "--context-lens") {
      if (args[i + 1] && /^https?:\/\//i.test(args[i + 1])) {
        result.contextLens = args[++i];
      } else {
        result.contextLens = true;
      }
    } else if (arg.startsWith("--context-lens=")) {
      const val = arg.slice("--context-lens=".length).trim();
      result.contextLens = val || true;
    } else if (arg === "--attach") {
      result.attach = true;
    } else if (arg === "--dream") {
      result.doDream = true;
    } else if (arg === "--pr") {
      result.openPr = true;
    } else if (arg === "--draft") {
      result.draft = true;
      result.openPr = true;
    } else if (arg === "--worktree" && args[i + 1]) {
      result.worktreeDir = path.resolve(cwd, args[++i]);
    } else if (arg.startsWith("--worktree=")) {
      result.worktreeDir = path.resolve(cwd, arg.slice("--worktree=".length));
    } else if (arg === "--skip-tests") {
      result.skipTests = true;
    } else if (arg === "--skip-review") {
      result.skipReview = true;
    } else if (arg === "--skip-bughunter") {
      result.skipBughunter = true;
    } else if (arg === "--allow-config-change") {
      result.allowConfigChange = true;
    } else if (arg === "--models") {
      result.modelsAction = "list";
    } else if (arg === "--models-sync") {
      result.modelsAction = "sync";
    } else if (arg === "--models-opencode-config") {
      result.modelsAction = "opencode-config";
    } else if (arg === "--route") {
      result.routeOnly = true;
    } else if (arg === "--noty-writeback") {
      result.notyWriteBack = true;
    } else if (arg === "--continue-on-failure") {
      result.continueOnFailure = true;
    } else if (arg === "--parallel" && args[i + 1]) {
      result.queueParallel = Number(args[++i]);
    } else if (arg === "--only-tag" && args[i + 1]) {
      result.onlyTag = args[++i];
    } else if (arg === "--tag" && args[i + 1]) {
      result.tags.push(args[++i]);
    } else if (arg.startsWith("--tag=")) {
      result.tags.push(arg.slice("--tag=".length));
    } else if (arg === "--report") {
      result.doReport = true;
    } else if (arg === "--budget") {
      result.doBudget = true;
    } else if (arg === "--override-budget") {
      result.overrideBudget = true;
    } else if (arg === "--doctor") {
      result.doDoctor = true;
    } else if (arg === "--fix") {
      result.doFix = true;
    } else if (arg === "--plugin-install") {
      result.pluginAction = "install";
    } else if (arg === "--plugin-uninstall") {
      result.pluginAction = "uninstall";
    } else if (arg === "--init") {
      result.doInit = true;
    } else if (arg === "--cleanup") {
      result.doCleanup = true;
    } else if (arg === "--safety-check") {
      result.doSafetyCheck = true;
    } else if (arg === "--force") {
      result.force = true;
    } else if (arg === "--yes" || arg === "-y") {
      result.skipConfirm = true;
    } else if ((arg === "--cf" || arg === "-cf") && args[i + 1] && args[i + 2]) {
      const accountId = args[++i];
      const gatewayId = args[++i];
      // Only consume a third argument when it names a known gateway provider, so a task text is never eaten.
      const cfProvider = args[i + 1] && KNOWN_CF_PROVIDERS.has(args[i + 1].toLowerCase()) ? args[++i] : undefined;
      result.cfArgs = { accountId, gatewayId, provider: cfProvider };
    } else if (arg.startsWith("-")) {
      result.unknownOption = arg;
      return result;
    } else {
      result.positional.push(arg);
    }
  }

  return result;
}
