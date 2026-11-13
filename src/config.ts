import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface RepoConfig {
  baseBranch: string;
  verify: string[];
  testCommand: string | null;
  implementerModel?: { providerID: string; id: string };
  testerModel?: { providerID: string; id: string };
  reviewerModel?: { providerID: string; id: string };
  maxFixRetries: number;
  maxReviewRounds: number;
  securityScan: boolean;
}

const DEFAULT_CONFIG: RepoConfig = {
  baseBranch: "main",
  verify: [],
  testCommand: null,
  implementerModel: { providerID: "openrouter", id: "anthropic/claude-sonnet-4" },
  testerModel: { providerID: "openrouter", id: "openai/gpt-4.1" },
  reviewerModel: { providerID: "openrouter", id: "google/gemini-2.5-pro" },
  maxFixRetries: 3,
  maxReviewRounds: 2,
  securityScan: true,
};

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
  if (securityScan && hasCommand("semgrep") && !verify.some((c) => c.startsWith("semgrep"))) {
    verify.push("semgrep --error --config p/security-audit --quiet .");
  }

  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    baseBranch,
    verify,
    testCommand,
    securityScan,
  };
}
