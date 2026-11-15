import { spawnSync } from "node:child_process";

/**
 * Zero-token task classifier: size, risk, kind and domains from the task text, optional tags (e.g. from a
 * Noty item: `size:L`, `risk:high`) and cheap repo signals (`git grep` hits for identifiers the task names).
 * After Stage 1 `reclassifyFromDiff` corrects size/risk using the real diff.
 */

export type TaskSize = "S" | "M" | "L";
export type TaskRisk = "low" | "med" | "high";
export type TaskKind = "fix" | "feature" | "refactor" | "docs" | "test" | "chore";

export interface Classification {
  size: TaskSize;
  risk: TaskRisk;
  kind: TaskKind;
  domains: string[];
  estFiles: number;
  confidence: number;
  reasons: string[];
}

/** Strong, specific signals: these make a task high risk. */
const DOMAIN_RULES: Array<[string, RegExp]> = [
  ["auth", /\b(authenticat\w*|authoriz\w*|login|logout|sign[- ]?in|password|oauth|sso|rbac|permissions?|access control|tenant isolation|multi[- ]tenan\w*|idor|csrf|xss|sql injection|privilege\w*|jwt)\b/i],
  ["billing", /\b(billing|payments?|stripe|invoic\w*|refunds?|chargebacks?|pricing plans?)\b/i],
  ["migration", /\b(migrations?|migrate (the )?(db|database|schema|data)|backfill\w*|alter table|drop (table|column))\b/i],
  ["crypto", /\b(encrypt\w*|decrypt\w*|cryptograph\w*|hmac|key rotation|signing keys?|private keys?)\b/i],
  ["concurrency", /\b(race conditions?|concurren\w*|deadlocks?|mutex|locking)\b/i],
  ["ui", /\b(ui|css|component|react|layout|stylesheet|button|modal|status bar|footer|header)\b/i],
  ["infra", /\b(infra\w*|ci|deploy\w*|docker\w*|terraform|wrangler|kubernetes|k8s)\b/i],
];

/** Weaker signals: bump risk to med at most (e.g. "token usage", "session picker", "schema validation"). */
const WEAK_SIGNALS_RE = /\b(tokens?|sessions?|schema|sql|database|index(es)?|webhooks?|secrets?|signature|hash(ing)?|checkout|subscriptions?|queue|retry|async)\b/i;

const HIGH_RISK_DOMAINS = new Set(["auth", "billing", "migration", "crypto"]);
const SENSITIVE_PATH_RE = /(^|\/)(auth|security|billing|payments?|migrations?|crypto|\.github)\//i;

function kindOf(text: string): TaskKind {
  const t = text.toLowerCase();
  if (/^(fix|bug|hotfix|resolve|repair|patch)\b|\b(fix(es|ed)?|broken|crash(es|ing)?|regression|vulnerab\w*)\b/.test(t)) return "fix";
  if (/\b(refactor|restructure|rename|simplify|extract|clean ?up)\b/.test(t)) return "refactor";
  if (/^(docs?|document|update (the )?readme)\b|\b(readme|documentation|changelog)\b/.test(t)) return "docs";
  if (/^(add |write )?tests?\b|\b(test coverage|unit tests?|e2e tests?)\b/.test(t)) return "test";
  if (/\b(bump|upgrade|dependenc(y|ies)|chore|ci)\b/.test(t)) return "chore";
  return "feature";
}

/** Identifiers worth grepping: `backticked`, CamelCase, snake_case and path-like tokens. */
export function extractIdentifiers(text: string): string[] {
  const ids = new Set<string>();
  // Backticked tokens only when identifier-like (common words such as `config` would match half the repo).
  for (const m of text.matchAll(/`([^`\s]{3,80})`/g)) {
    if (/[A-Z_./()]|\d/.test(m[1].slice(1)) || m[1].length >= 12) ids.add(m[1]);
  }
  for (const m of text.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z0-9]+(?:_[a-z0-9]+)+|[\w-]+\/[\w./-]+\.\w+)\b/g)) ids.add(m[1]);
  return [...ids].slice(0, 12);
}

/** Number of distinct tracked files mentioning any identifier (bounded, ignores errors). */
export function countMentioningFiles(repoDir: string, ids: string[]): number {
  if (ids.length === 0) return 0;
  const files = new Set<string>();
  for (const id of ids) {
    const res = spawnSync("git", ["grep", "-l", "-F", "--", id], { cwd: repoDir, encoding: "utf8", timeout: 5000 });
    for (const f of (res.stdout ?? "").split("\n").filter(Boolean)) files.add(f);
    if (files.size > 50) break;
  }
  return files.size;
}

export function classifyTask(opts: { task: string; repoDir?: string; tags?: string[] }): Classification {
  const text = opts.task;
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  const reasons: string[] = [];
  const kind = kindOf(firstLine);
  const domains = DOMAIN_RULES.filter(([, re]) => re.test(text)).map(([d]) => d);
  const ids = extractIdentifiers(text);
  const estFiles = opts.repoDir ? countMentioningFiles(opts.repoDir, ids) : 0;

  let size: TaskSize;
  const words = text.split(/\s+/).filter(Boolean).length;
  const bullets = (text.match(/^\s*([-*]|\d+\.)\s+/gm) ?? []).length;
  if (kind === "docs") size = "S";
  else if (estFiles > 8 || bullets >= 6 || words > 250) size = "L";
  else if (estFiles > 2 || bullets >= 2 || words > 60 || domains.length >= 2) size = "M";
  else size = "S";
  reasons.push(`size ${size} (${words} words, ${bullets} bullets, ~${estFiles} files mentioned)`);

  let risk: TaskRisk = domains.some((d) => HIGH_RISK_DOMAINS.has(d))
    ? "high"
    : domains.length || WEAK_SIGNALS_RE.test(text)
      ? "med"
      : "low";
  // Documentation changes are never high risk on wording alone.
  if (kind === "docs") risk = risk === "high" ? "med" : "low";
  reasons.push(`risk ${risk}${domains.length ? ` (domains: ${domains.join(", ")})` : ""}`);

  for (const tag of opts.tags ?? []) {
    const m = tag.toLowerCase().match(/^(size|risk):(\w+)$/);
    if (!m) continue;
    if (m[1] === "size" && ["s", "m", "l"].includes(m[2])) size = m[2].toUpperCase() as TaskSize;
    if (m[1] === "risk" && ["low", "med", "high"].includes(m[2])) risk = m[2] as TaskRisk;
    reasons.push(`override from tag ${tag}`);
  }

  const confidence = Math.min(0.95, 0.5 + (ids.length ? 0.15 : 0) + (domains.length ? 0.15 : 0) + (kind !== "feature" ? 0.1 : 0));
  return { size, risk, kind, domains, estFiles, confidence, reasons };
}

/** Corrects size/risk from the real diff: changed lines, file count and sensitive paths. */
export function reclassifyFromDiff(
  c: Classification,
  stats: { files: string[]; linesChanged: number }
): Classification {
  const reasons = [...c.reasons];
  const order: TaskSize[] = ["S", "M", "L"];
  let size = c.size;
  const bySize: TaskSize = stats.linesChanged >= 400 || stats.files.length > 12 ? "L" : stats.linesChanged >= 80 || stats.files.length > 3 ? "M" : "S";
  if (order.indexOf(bySize) > order.indexOf(size)) {
    size = bySize;
    reasons.push(`diff: ${stats.files.length} files / ${stats.linesChanged} lines → size ${size}`);
  }
  let risk = c.risk;
  const sensitive = stats.files.filter((f) => SENSITIVE_PATH_RE.test(f));
  if (sensitive.length && risk !== "high") {
    risk = "high";
    reasons.push(`diff touches sensitive paths: ${sensitive.slice(0, 5).join(", ")}`);
  }
  return { ...c, size, risk, reasons };
}

/** Parses `git diff --numstat` output into file list and total changed lines. */
export function parseNumstat(numstat: string): { files: string[]; linesChanged: number } {
  const files: string[] = [];
  let lines = 0;
  for (const row of numstat.split("\n")) {
    const [a, d, f] = row.split("\t");
    if (!f) continue;
    files.push(f);
    lines += (Number(a) || 0) + (Number(d) || 0);
  }
  return { files, linesChanged: lines };
}
