import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Gate-integrity helpers: stop pipeline agents from weakening the checks that judge their own work
 * (verify config, CI, test runner config, tester-authored tests).
 */

/** package.json keys that configure test/lint runners (compared alongside `scripts`). */
export const PACKAGE_JSON_GATE_KEYS = [
  "scripts",
  "jest",
  "mocha",
  "vitest",
  "ava",
  "nyc",
  "c8",
  "eslintConfig",
  "lint-staged",
  "husky",
];

/** pyproject.toml table prefixes that configure test/lint/type-check gates. */
export const PYPROJECT_GATE_SECTIONS = ["tool.pytest", "tool.coverage", "tool.mypy", "tool.ruff", "tool.tox", "tool.hatch.envs"];

/**
 * Default protected paths (gitignore-style globs, matched against repo-relative POSIX paths).
 * Suffixes narrow the check to part of a file:
 * - `#json:k1,k2` compares only those top-level JSON keys (e.g. package.json scripts/jest config);
 * - `#toml:t1,t2` compares only TOML tables whose header starts with those prefixes.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  ".ai-ship.json",
  `**/package.json#json:${PACKAGE_JSON_GATE_KEYS.join(",")}`,
  `**/pyproject.toml#toml:${PYPROJECT_GATE_SECTIONS.join(",")}`,
  // package-manager config can replace the shell that runs every script (e.g. npm script-shell=/usr/bin/true)
  "**/.npmrc",
  "**/.yarnrc",
  "**/.yarnrc.yml",
  "**/pnpm-workspace.yaml",
  "**/bunfig.toml",
  // ignore rules could hide a new gate file from this check
  "**/.gitignore",
  "**/.gitattributes",
  // type-check / test-runner / lint configuration
  "**/tsconfig*.json",
  "**/jsconfig*.json",
  "**/vitest.config.*",
  "**/vitest.workspace.*",
  "**/vite.config.*",
  "**/jest.config.*",
  "**/jest.setup.*",
  "**/playwright.config.*",
  "**/cypress.config.*",
  "**/karma.conf.*",
  "**/.mocharc*",
  "**/.c8rc*",
  "**/.nycrc*",
  "**/eslint.config.*",
  "**/.eslintrc*",
  "**/.eslintignore",
  "**/biome.json",
  "**/biome.jsonc",
  "**/pytest.ini",
  "**/conftest.py",
  "**/tox.ini",
  "**/setup.cfg",
  "**/noxfile.py",
  "**/.coveragerc",
  "**/mypy.ini",
  "**/ruff.toml",
  "**/.ruff.toml",
  "Makefile",
  "justfile",
  "Justfile",
  // CI and static analysis
  ".github/workflows/**",
  ".github/actions/**",
  "**/.semgrep*",
  "**/.semgrep/**",
];

/**
 * Paths the adversarial tester may create or modify. Broader than the safety scanner's test-file rule so
 * Go (`x_test.go`), Python (`test_x.py`), e2e suites and fixture directories are not reverted.
 */
const TESTER_PATH_RE =
  /(^|\/)(__tests__|__mocks__|tests?|spec|specs|e2e|testdata|fixtures)\/|(\.(test|spec)\.[a-z0-9]+$)|(_test\.[a-z0-9]+$)|((^|\/)test_[^/]+\.py$)|((^|\/)[^/]+_spec\.rb$)/i;

export function isTesterPath(filePath: string): boolean {
  return TESTER_PATH_RE.test(filePath);
}

export class ProtectedPathError extends Error {
  readonly violations: string[];
  constructor(violations: string[], stage: string) {
    super(
      [
        `${stage} modified protected verification/config files:`,
        ...violations.map((v) => `- ${v}`),
        "These files define the gates that judge the agent's work, so ai-ship refuses to continue.",
        "If the change is intended, re-run with --allow-config-change.",
      ].join("\n")
    );
    this.name = "ProtectedPathError";
    this.violations = violations;
  }
}

/** Converts a gitignore-style glob (`**`, `*`, `?`) into an anchored RegExp over POSIX paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const followedBySlash = glob[i + 2] === "/";
        re += followedBySlash ? "(?:.*/)?" : ".*";
        i += followedBySlash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function git(worktreeDir: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd: worktreeDir, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return { ok: res.status === 0, stdout: res.stdout || "", stderr: (res.stderr || "").trim() };
}

function gitOrThrow(worktreeDir: string, args: string[]): string {
  const res = git(worktreeDir, args);
  if (!res.ok) throw new Error(`git ${args.join(" ")} failed in ${worktreeDir}: ${res.stderr}`);
  return res.stdout;
}

export function headRef(worktreeDir: string): string {
  return gitOrThrow(worktreeDir, ["rev-parse", "HEAD"]).trim();
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
}

/** Files changed in the working tree relative to `ref` (committed + staged + unstaged + untracked). */
export function changedFilesSince(worktreeDir: string, ref: string): ChangedFile[] {
  const out = gitOrThrow(worktreeDir, ["diff", "--name-status", "--no-renames", "-z", ref]);
  const parts = out.split("\0").filter(Boolean);
  const files = new Map<string, ChangedFile>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i][0];
    const file = parts[i + 1];
    files.set(file, { path: file, status: code === "A" ? "added" : code === "D" ? "deleted" : "modified" });
  }
  const untracked = gitOrThrow(worktreeDir, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  for (const file of untracked) files.set(file, { path: file, status: "added" });
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function digest(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Canonical form of selected top-level JSON keys (unparseable JSON compares by content hash). */
export function extractJsonKeys(text: string | undefined, keys: readonly string[]): string {
  if (text === undefined) return "null";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown> | null;
    const picked: Record<string, unknown> = {};
    for (const k of keys) picked[k] = parsed && typeof parsed === "object" ? (parsed[k] ?? null) : null;
    return JSON.stringify(picked);
  } catch {
    return `<<unparseable:${digest(text)}>>`;
  }
}

/** Text of TOML tables whose header (`[a.b]` / `[[a.b]]`) starts with one of `prefixes`. */
export function extractTomlSections(text: string | undefined, prefixes: readonly string[]): string {
  if (text === undefined) return "null";
  const out: string[] = [];
  let capturing = false;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (header) {
      const name = header[1].replace(/["']/g, "");
      capturing = prefixes.some((p) => name === p || name.startsWith(`${p}.`));
    }
    if (capturing) out.push(line.trimEnd());
  }
  return out.join("\n");
}

function showAtRef(worktreeDir: string, ref: string, file: string): string | undefined {
  const res = git(worktreeDir, ["show", `${ref}:${file}`]);
  return res.ok ? res.stdout : undefined;
}

function readWorking(worktreeDir: string, file: string): string | undefined {
  const full = path.join(worktreeDir, file);
  try {
    return fs.readFileSync(full, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Returns human-readable violations for protected paths changed since `ref`.
 * For `...package.json#scripts` patterns only a change to the `scripts` object counts.
 */
export function findProtectedPathViolations(
  worktreeDir: string,
  ref: string,
  patterns: readonly string[] = DEFAULT_PROTECTED_PATHS
): string[] {
  const compiled = compileRules(patterns);
  const violations: string[] = [];
  for (const file of changedFilesSince(worktreeDir, ref)) {
    for (const rule of compiled) {
      if (!rule.re.test(file.path)) continue;
      if (rule.section) {
        const before = extractSection(rule.section, showAtRef(worktreeDir, ref, file.path));
        const after = extractSection(rule.section, readWorking(worktreeDir, file.path));
        if (before === after) break;
        violations.push(
          `${file.path} (${rule.section.names.join("/")} ${file.status === "modified" ? "changed" : file.status})`
        );
      } else {
        violations.push(`${file.path} (${file.status})`);
      }
      break;
    }
  }
  return violations;
}

function fileDigest(p: string): string {
  try {
    return digest(fs.readFileSync(p, "utf8"));
  } catch {
    return "missing";
  }
}

/**
 * Digest of git state that can hide changes from the protected-path check: the shared `info/exclude`,
 * `core.excludesFile` (setting and content), and files flagged skip-worktree / assume-unchanged.
 */
export function excludeFileDigest(worktreeDir: string): string {
  const parts: string[] = [];
  const excl = git(worktreeDir, ["rev-parse", "--git-path", "info/exclude"]);
  parts.push(`exclude:${excl.ok ? fileDigest(path.resolve(worktreeDir, excl.stdout.trim())) : "missing"}`);
  const globalExcludes = git(worktreeDir, ["config", "--get", "core.excludesFile"]);
  const globalPath = globalExcludes.ok ? globalExcludes.stdout.trim() : "";
  parts.push(`excludesFile:${globalPath}:${globalPath ? fileDigest(globalPath.replace(/^~(?=\/)/, process.env.HOME ?? "~")) : ""}`);
  const flagged = git(worktreeDir, ["ls-files", "-v", "-z"]);
  const hidden = flagged.ok
    ? flagged.stdout
        .split("\0")
        .filter((l) => /^(S|[a-z]) /.test(l))
        .sort()
    : [];
  parts.push(`hidden:${hidden.join("|")}`);
  return digest(parts.join("\n"));
}

interface CompiledRule {
  pattern: string;
  re: RegExp;
  section?: { kind: "json" | "toml"; names: string[] };
}

function compileRules(patterns: readonly string[]): CompiledRule[] {
  return patterns.map((p) => {
    const hash = p.indexOf("#");
    const glob = hash >= 0 ? p.slice(0, hash) : p;
    const selector = hash >= 0 ? p.slice(hash + 1) : undefined;
    let section: CompiledRule["section"];
    if (selector) {
      // legacy "#scripts" == "#json:scripts"
      const m = selector.match(/^(json|toml):(.+)$/);
      section = m
        ? { kind: m[1] as "json" | "toml", names: m[2].split(",").map((n) => n.trim()).filter(Boolean) }
        : { kind: "json", names: [selector] };
    }
    return { pattern: p, re: globToRegExp(glob), section };
  });
}

function extractSection(section: NonNullable<CompiledRule["section"]>, text: string | undefined): string {
  return section.kind === "json" ? extractJsonKeys(text, section.names) : extractTomlSections(text, section.names);
}

/**
 * Ignored (untracked) files matching protected patterns, keyed to a digest of the protected content.
 * Wholly ignored directories (node_modules, dist/, .next/, .venv/ …) collapse to a single entry via
 * `--directory` and are skipped, so build output never trips the gate; individually ignored files such as
 * `.npmrc` are still tracked. For `#json:`/`#toml:` patterns only the protected section counts, and a file
 * whose protected section is empty is treated as absent.
 */
export function snapshotIgnoredProtectedFiles(
  worktreeDir: string,
  patterns: readonly string[] = DEFAULT_PROTECTED_PATHS
): FileSnapshot {
  const res = git(worktreeDir, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  const rules = compileRules(patterns);
  const snap: FileSnapshot = new Map();
  if (!res.ok) return snap;
  for (const file of res.stdout.split("\0").filter(Boolean)) {
    if (file.endsWith("/")) continue;
    const rule = rules.find((r) => r.re.test(file));
    if (!rule) continue;
    if (rule.section) {
      const extracted = extractSection(rule.section, readWorking(worktreeDir, file));
      const empty = extractSection(rule.section, rule.section.kind === "json" ? "{}" : "");
      if (extracted === empty || extracted === extractSection(rule.section, undefined)) continue;
      snap.set(file, digest(extracted));
    } else {
      snap.set(file, hashFile(worktreeDir, file));
    }
  }
  return snap;
}

function ignoredProtectedViolations(
  worktreeDir: string,
  baseline: FileSnapshot,
  patterns: readonly string[]
): string[] {
  const current = snapshotIgnoredProtectedFiles(worktreeDir, patterns);
  const out: string[] = [];
  for (const [file, h] of current) {
    if (!baseline.has(file)) out.push(`${file} (ignored file added)`);
    else if (baseline.get(file) !== h) out.push(`${file} (ignored file changed)`);
  }
  for (const file of baseline.keys()) {
    if (!current.has(file)) out.push(`${file} (ignored file deleted)`);
  }
  return out;
}

/** Throws ProtectedPathError when protected paths changed since `ref`, unless explicitly allowed. */
export function assertProtectedPathsUnchanged(opts: {
  worktreeDir: string;
  sinceRef: string;
  stage: string;
  patterns?: readonly string[];
  allow?: boolean;
  /** Digest from excludeFileDigest() at run start; a change means ignore rules or index flags were edited. */
  excludeDigest?: string;
  /** snapshotIgnoredProtectedFiles() at run start: protected files hidden by existing ignore rules. */
  ignoredBaseline?: FileSnapshot;
  log?: (line: string) => void;
}): void {
  const violations = findProtectedPathViolations(opts.worktreeDir, opts.sinceRef, opts.patterns);
  if (opts.excludeDigest !== undefined && excludeFileDigest(opts.worktreeDir) !== opts.excludeDigest) {
    violations.push("git ignore/skip-worktree state (info/exclude, core.excludesFile or index flags changed)");
  }
  if (opts.ignoredBaseline) {
    violations.push(
      ...ignoredProtectedViolations(opts.worktreeDir, opts.ignoredBaseline, opts.patterns ?? DEFAULT_PROTECTED_PATHS)
    );
  }
  if (violations.length === 0) return;
  if (opts.allow) {
    opts.log?.(`  [integrity] ${opts.stage} changed protected files (allowed by --allow-config-change): ${violations.join(", ")}`);
    return;
  }
  throw new ProtectedPathError(violations, opts.stage);
}

/**
 * Commits everything as an internal checkpoint (hooks skipped) and returns the new HEAD.
 * Returns the current HEAD unchanged when there is nothing to commit.
 */
export function createCheckpoint(worktreeDir: string, message: string): string {
  const status = gitOrThrow(worktreeDir, ["status", "--porcelain"]).trim();
  if (status) {
    gitOrThrow(worktreeDir, ["add", "-A"]);
    gitOrThrow(worktreeDir, ["commit", "--no-verify", "-q", "-m", message]);
  }
  return headRef(worktreeDir);
}

/**
 * Enforces that the tester only added or modified test files since `sinceRef`:
 * any other change (production files, deletions of existing files) is reverted.
 * Returns the reverted paths and the test files the tester owns.
 */
export function enforceTesterScope(
  worktreeDir: string,
  sinceRef: string,
  protectedPatterns: readonly string[] = DEFAULT_PROTECTED_PATHS
): { reverted: string[]; testerFiles: string[] } {
  const reverted: string[] = [];
  const testerFiles: string[] = [];
  // The tester may not touch gate config either (e.g. tests/conftest.py, tests/tsconfig.json).
  const protectedChanged = new Set(
    findProtectedPathViolations(worktreeDir, sinceRef, protectedPatterns).map((v) => v.replace(/ \(.*\)$/, ""))
  );
  for (const file of changedFilesSince(worktreeDir, sinceRef)) {
    const allowed = isTesterPath(file.path) && file.status !== "deleted" && !protectedChanged.has(file.path);
    if (allowed) {
      testerFiles.push(file.path);
      continue;
    }
    const existedAtRef = showAtRef(worktreeDir, sinceRef, file.path) !== undefined;
    if (existedAtRef) {
      gitOrThrow(worktreeDir, ["checkout", sinceRef, "--", file.path]);
    } else {
      fs.rmSync(path.join(worktreeDir, file.path), { force: true, recursive: true });
    }
    reverted.push(file.path);
  }
  return { reverted, testerFiles };
}

function hashFile(worktreeDir: string, file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(path.join(worktreeDir, file))).digest("hex");
  } catch {
    return null;
  }
}

export type FileSnapshot = Map<string, string | null>;

/** Records sha256 hashes of `files` (null for missing files). */
export function snapshotFiles(worktreeDir: string, files: readonly string[]): FileSnapshot {
  const snap: FileSnapshot = new Map();
  for (const f of files) snap.set(f, hashFile(worktreeDir, f));
  return snap;
}

/**
 * Restores any snapshotted file whose content changed (or that was deleted) back to `ref`.
 * Returns the restored paths.
 */
export function restoreTamperedFiles(worktreeDir: string, snapshot: FileSnapshot, ref: string): string[] {
  const restored: string[] = [];
  for (const [file, expected] of snapshot) {
    if (hashFile(worktreeDir, file) === expected) continue;
    if (expected === null) {
      fs.rmSync(path.join(worktreeDir, file), { force: true, recursive: true });
    } else {
      gitOrThrow(worktreeDir, ["checkout", ref, "--", file]);
    }
    restored.push(file);
  }
  return restored;
}

export const CHECKPOINT_PREFIX = "ai-ship: checkpoint";

/**
 * Returns the run's start ref, skipping trailing checkpoint commits left by an earlier run that failed
 * mid-way (so a `--worktree` re-run squashes them instead of shipping them).
 */
export function resolveRunStartRef(worktreeDir: string): string {
  let ref = headRef(worktreeDir);
  for (let i = 0; i < 50; i++) {
    const subject = gitOrThrow(worktreeDir, ["log", "-1", "--format=%s", ref]).trim();
    if (!subject.startsWith(CHECKPOINT_PREFIX)) return ref;
    const parent = git(worktreeDir, ["rev-parse", `${ref}^`]);
    if (!parent.ok) return ref;
    ref = parent.stdout.trim();
  }
  return ref;
}

/** Soft-resets internal checkpoint commits made since `startRef` so the final commit contains the whole task. */
export function squashCheckpoints(worktreeDir: string, startRef: string): void {
  if (headRef(worktreeDir) === startRef) return;
  gitOrThrow(worktreeDir, ["reset", "--soft", startRef]);
}
