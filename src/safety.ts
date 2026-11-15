import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface SafetyFinding {
  file: string;
  line: number;
  rule: string;
  message: string;
  preview: string;
}

export interface SafetyScanResult {
  ok: boolean;
  findings: SafetyFinding[];
}

export interface SafetyScanOptions {
  baseBranch?: string;
  allowlist?: string[];
}

const BLOCKED_FILE_PATTERNS: Array<{ pattern: RegExp; rule: string; message: string }> = [
  {
    pattern: /(^|\/)\.env(\.(?!example$|sample$|template$|schema$|dist$).+)?$/i,
    rule: "blocked-env-file",
    message: "Environment file (.env*) must never be committed; use .env.example with placeholders.",
  },
  {
    pattern: /(^|\/)\.dev\.vars(\.(?!example$|sample$|template$).+)?$/i,
    rule: "blocked-wrangler-dev-vars",
    message: "Wrangler local secrets file (.dev.vars*) must never be committed.",
  },
  {
    pattern: /(^|\/)\.wrangler(\/|$)/i,
    rule: "blocked-wrangler-dir",
    message: "Wrangler local state directory (.wrangler/) must never be committed.",
  },
  {
    pattern: /\.(pem|key|p12|pfx|jks|keystore)$/i,
    rule: "blocked-private-key-file",
    message: "Private key or keystore file must never be committed.",
  },
  {
    pattern: /(^|\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i,
    rule: "blocked-ssh-key-file",
    message: "SSH private key file must never be committed.",
  },
  {
    pattern: /(^|\/)(credentials\.json|service-account[^/]*\.json|[^/]*firebase-adminsdk[^/]*\.json|\.npmrc|\.pypirc|\.netrc|terraform\.tfvars)$/i,
    rule: "blocked-credentials-file",
    message: "Credentials or secrets configuration file must never be committed.",
  },
  {
    pattern: /\.tfstate(\..+)?$/i,
    rule: "blocked-tfstate-file",
    message: "Terraform state file (*.tfstate) contains sensitive infrastructure IDs/secrets and must never be committed.",
  },
];

const SAFE_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "test.com",
  "test.org",
  "test.net",
  "test.local",
  "localhost",
  "invalid",
  "placeholder.com",
  "acme.com",
  "domain.com",
  "yourdomain.com",
  "company.com",
  "noreply.github.com",
  "users.noreply.github.com",
]);

const NON_EMAIL_TLDS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico",
  "css", "scss", "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "json", "jsonc", "toml", "yaml", "yml", "md", "txt", "lock",
]);

const DEPLOYMENT_CONFIG_FILE_RE =
  /(^|\/)(wrangler(\.[^/]+)?\.(toml|jsonc?)|fly\.toml|vercel\.json|netlify\.toml|terraform\.tfvars)$/i;

const TEST_FILE_RE =
  /(^|\/)(__tests__|tests?|spec)\/|(\.(test|spec)\.[a-z0-9]+)$/i;

const ENV_OR_TEMPLATE_VALUE_RE =
  /^(\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\{\{[^}]+\}\}|process\.env\.|import\.meta\.env\.|env\.|c\.env\.|os\.environ)/i;

const PLACEHOLDER_VALUE_RE =
  /^(<[^>]+>|\[[^\]]+\]|your[_-]|replace[_-]|todo|changeme|placeholder|example|sample|dummy|fake|mock|test[_-]|dev[_-]|local[_-]|xxx+|0{8}-0{4}-0{4}-0{4}-0{12}|0{24,}|1{8}-1{4}-1{4}-1{4}-1{12})$/i;

export function redactValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

function isPlaceholderOrRef(value: string): boolean {
  const v = value.trim().replace(/^["'`]|["'`]$/g, "");
  if (!v) return true;
  if (ENV_OR_TEMPLATE_VALUE_RE.test(v)) return true;
  if (PLACEHOLDER_VALUE_RE.test(v)) return true;
  if (/^<.*>$/.test(v)) return true;
  if (/^(x|_|\*|-)+$/i.test(v)) return true;
  if (/^(your|my|replace|insert|enter|add)[_-]/i.test(v)) return true;
  return false;
}

function isDeploymentConfigFile(filePath: string): boolean {
  return DEPLOYMENT_CONFIG_FILE_RE.test(filePath);
}

export function isTestFile(filePath: string): boolean {
  return TEST_FILE_RE.test(filePath);
}

function isWranglerFile(filePath: string): boolean {
  return /(^|\/)wrangler(\.[^/]+)?\.(toml|jsonc?)$/i.test(filePath);
}

function compileAllowlist(allowlist?: string[]): RegExp[] {
  if (!allowlist?.length) return [];
  return allowlist.map((entry) => {
    const regexMatch = entry.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexMatch) {
      return new RegExp(regexMatch[1], regexMatch[2]);
    }
    const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i");
  });
}

function isAllowlisted(
  allowlist: RegExp[],
  file: string,
  lineText: string,
  matchedValue?: string
): boolean {
  if (allowlist.length === 0) return false;
  return allowlist.some(
    (re) => re.test(file) || re.test(lineText) || (matchedValue ? re.test(matchedValue) : false)
  );
}

const SECRET_TOKEN_RULES: Array<{ rule: string; regex: RegExp; message: string }> = [
  {
    rule: "private-key-block",
    regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|PGP\s+|ENCRYPTED\s+)?PRIVATE KEY-----/,
    message: "Private key material detected.",
  },
  {
    rule: "aws-access-key",
    regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
    message: "AWS access key ID detected.",
  },
  {
    rule: "aws-arn-account-id",
    regex: /\barn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/,
    message: "AWS ARN containing a 12-digit account ID detected.",
  },
  {
    rule: "github-token",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
    message: "GitHub personal access or app token detected.",
  },
  {
    rule: "anthropic-api-key",
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
    message: "Anthropic API key detected.",
  },
  {
    rule: "openrouter-api-key",
    regex: /\bsk-or-v1-[A-Za-z0-9]{20,}\b/,
    message: "OpenRouter API key detected.",
  },
  {
    rule: "openai-api-key",
    regex: /\bsk-(?!ant-|or-v1-)(?:proj-)?[A-Za-z0-9_-]{24,}\b/,
    message: "OpenAI API key detected.",
  },
  {
    rule: "stripe-live-key",
    regex: /\b(?:sk_live|rk_live)_[A-Za-z0-9]{16,}\b|\bwhsec_[A-Za-z0-9]{24,}\b/,
    message: "Stripe live API key or webhook secret detected.",
  },
  {
    rule: "slack-token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    message: "Slack API token detected.",
  },
  {
    rule: "google-api-key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/,
    message: "Google API key detected.",
  },
  {
    rule: "sendgrid-api-key",
    regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
    message: "SendGrid API key detected.",
  },
  {
    rule: "resend-api-key",
    regex: /\bre_[A-Za-z0-9_]{20,}\b/,
    message: "Resend API key detected.",
  },
  {
    rule: "npm-or-pypi-token",
    regex: /\b(?:npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{20,})\b/,
    message: "Package registry token (npm/PyPI) detected.",
  },
];

const DEPLOYMENT_ID_KEY_RE =
  /["']?(account_id|accountId|CF_ACCOUNT_ID|CLOUDFLARE_ACCOUNT_ID|zone_id|zoneId|CF_ZONE_ID|CLOUDFLARE_ZONE_ID|database_id|databaseId|preview_database_id|previewDatabaseId|gateway_id|gatewayId|CF_GATEWAY_ID|preview_id|previewId|namespace_id|namespaceId)["']?\s*[:=]\s*["']([^"'\s]+)["']/g;

const WRANGLER_RESOURCE_ID_RE =
  /(?:^|[\s,{])["']?(id)["']?\s*[:=]\s*["']([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']/gi;

const CF_GATEWAY_URL_RE =
  /https:\/\/gateway\.ai\.cloudflare\.com\/v1\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/gi;

const GENERIC_SECRET_ASSIGN_RE =
  /["']?(api_key|apiKey|apikey|secret_key|secretKey|access_token|accessToken|auth_token|authToken|private_key|privateKey|client_secret|clientSecret|webhook_secret|webhookSecret|signing_secret|signingSecret|jwt_secret|jwtSecret|session_secret|sessionSecret|encryption_key|encryptionKey|db_password|dbPassword|CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CF_API_KEY|CLOUDFLARE_API_KEY)["']?\s*[:=]\s*["']([^"']{12,})["']/g;

const AUTH_HEADER_RE =
  /\bAuthorization\s*[:=]\s*["']?(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{16,})["']?/gi;

const DB_CONN_URI_RE =
  /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/([^:\s/]+):([^@\s]+)@([^\s"'`]+)/gi;

const SENSITIVE_ENTITY_ID_RE =
  /["']?(org_id|orgId|tenant_id|tenantId|project_id|projectId|client_id|clientId|subscription_id|subscriptionId|customer_id|customerId|installation_id|installationId|app_id|appId)["']?\s*[:=]\s*["']([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:acct|cus|sub|org|usr|prj)_[A-Za-z0-9]{12,})["']/gi;

const EMAIL_RE = /(?:^|[^A-Za-z0-9._%+-/])([A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.([A-Za-z]{2,})))\b/g;

export function scanLineForLeaks(
  file: string,
  lineNumber: number,
  lineText: string,
  allowlist: Array<RegExp | string> = []
): SafetyFinding[] {
  const compiledAllowlist = allowlist.flatMap((entry) =>
    entry instanceof RegExp ? [entry] : compileAllowlist([entry])
  );
  const findings: SafetyFinding[] = [];
  const trimmed = lineText.trim();
  if (!trimmed) return findings;

  const pushFinding = (rule: string, message: string, matchedValue: string) => {
    if (isAllowlisted(compiledAllowlist, file, lineText, matchedValue)) return;
    findings.push({
      file,
      line: lineNumber,
      rule,
      message,
      preview: redactValue(matchedValue),
    });
  };

  // 1. High-signal token & private key patterns
  for (const rule of SECRET_TOKEN_RULES) {
    const m = lineText.match(rule.regex);
    if (m && !isPlaceholderOrRef(m[0])) {
      pushFinding(rule.rule, rule.message, m[0]);
    }
  }

  // 2. Deployment & Wrangler config IDs (account_id, database_id, zone_id, etc.)
  for (const m of lineText.matchAll(DEPLOYMENT_ID_KEY_RE)) {
    const key = m[1];
    const val = m[2];
    if (!isPlaceholderOrRef(val)) {
      pushFinding(
        "deployment-config-id",
        `Hardcoded deployment config "${key}" detected; use environment variables or placeholders instead.`,
        `${key}=${val}`
      );
    }
  }

  // 3. Wrangler resource IDs (KV/D1/R2/Queues id = "<hex/uuid>")
  if (isWranglerFile(file)) {
    for (const m of lineText.matchAll(WRANGLER_RESOURCE_ID_RE)) {
      const val = m[2];
      if (!isPlaceholderOrRef(val)) {
        pushFinding(
          "wrangler-resource-id",
          `Hardcoded Wrangler resource "id" detected in ${path.basename(file)}; do not commit real deployment IDs.`,
          `id=${val}`
        );
      }
    }
  }

  // 4. Cloudflare AI Gateway URLs with real account/gateway IDs
  for (const m of lineText.matchAll(CF_GATEWAY_URL_RE)) {
    const acct = m[1];
    const gw = m[2];
    if (!isPlaceholderOrRef(acct) && !isPlaceholderOrRef(gw) && !/^(account|acct|gateway|gw)$/i.test(acct)) {
      pushFinding(
        "cloudflare-gateway-url",
        "Hardcoded Cloudflare AI Gateway URL with account/gateway IDs detected.",
        m[0]
      );
    }
  }

  // 5. Generic secret/token/password assignments
  for (const m of lineText.matchAll(GENERIC_SECRET_ASSIGN_RE)) {
    const key = m[1];
    const val = m[2];
    if (!isPlaceholderOrRef(val)) {
      pushFinding(
        "hardcoded-secret",
        `Hardcoded secret value for "${key}" detected.`,
        `${key}=${val}`
      );
    }
  }

  // 6. Hardcoded Authorization headers
  for (const m of lineText.matchAll(AUTH_HEADER_RE)) {
    const token = m[1];
    if (!isPlaceholderOrRef(token)) {
      pushFinding(
        "hardcoded-auth-header",
        "Hardcoded Authorization header token detected.",
        token
      );
    }
  }

  // 7. Database / service connection strings with credentials
  for (const m of lineText.matchAll(DB_CONN_URI_RE)) {
    const password = m[3];
    const host = m[4];
    const isLocalHost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|postgres|db|redis)(:|\/|$)/i.test(host);
    if (!isPlaceholderOrRef(password) && !(isLocalHost && isTestFile(file))) {
      pushFinding(
        "database-credentials-uri",
        "Connection string with embedded credentials detected.",
        `${m[1]}://${m[2]}:${password}@${host}`
      );
    }
  }

  // 8. Sensitive entity/account/tenant IDs in non-test files or deployment configs
  if (!isTestFile(file) || isDeploymentConfigFile(file)) {
    for (const m of lineText.matchAll(SENSITIVE_ENTITY_ID_RE)) {
      const key = m[1];
      const val = m[2];
      if (!isPlaceholderOrRef(val)) {
        pushFinding(
          "hardcoded-entity-id",
          `Hardcoded sensitive ID "${key}" detected.`,
          `${key}=${val}`
        );
      }
    }
  }

  // 9. Email addresses (excluding safe placeholder/example domains and asset suffixes)
  for (const m of lineText.matchAll(EMAIL_RE)) {
    const email = m[1];
    const domain = m[2].toLowerCase();
    const tld = m[3].toLowerCase();
    if (NON_EMAIL_TLDS.has(tld)) continue;
    if (SAFE_EMAIL_DOMAINS.has(domain)) continue;
    if (domain.endsWith(".example.com") || domain.endsWith(".test.local")) continue;
    pushFinding(
      "email-address",
      `Email address detected (${redactValue(email)}); use @example.com placeholders in code/config.`,
      email
    );
  }

  return findings;
}

function checkBlockedFilename(file: string, allowlist: RegExp[]): SafetyFinding | null {
  for (const rule of BLOCKED_FILE_PATTERNS) {
    if (rule.pattern.test(file)) {
      if (isAllowlisted(allowlist, file, file, file)) return null;
      return {
        file,
        line: 0,
        rule: rule.rule,
        message: rule.message,
        preview: file,
      };
    }
  }
  return null;
}

function resolveMergeBase(worktreeDir: string, baseBranch?: string): string | null {
  if (!baseBranch) return null;
  for (const ref of [baseBranch, `origin/${baseBranch}`]) {
    const res = spawnSync("git", ["merge-base", ref, "HEAD"], {
      cwd: worktreeDir,
      encoding: "utf8",
    });
    if (res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }
  }
  return null;
}

function getDiffText(worktreeDir: string, baseBranch?: string): string {
  const mergeBase = resolveMergeBase(worktreeDir, baseBranch);
  const args = mergeBase
    ? ["diff", "--unified=0", "--no-color", mergeBase]
    : ["diff", "--unified=0", "--no-color", "HEAD"];
  const res = spawnSync("git", args, {
    cwd: worktreeDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (res.status === 0) return res.stdout || "";

  // Fallback for repos with no commits yet
  const cached = spawnSync("git", ["diff", "--unified=0", "--no-color", "--cached"], {
    cwd: worktreeDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return cached.status === 0 ? cached.stdout || "" : "";
}

function getUntrackedFiles(worktreeDir: string): string[] {
  const res = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: worktreeDir,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (res.status !== 0) return [];
  return (res.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isLikelyTextFile(absPath: string): boolean {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return false;
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(Math.min(8192, stat.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return !buf.includes(0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function scanWorktreeSafety(
  worktreeDir: string,
  opts: SafetyScanOptions = {}
): SafetyScanResult {
  const allowlist = compileAllowlist(opts.allowlist);
  const findings: SafetyFinding[] = [];
  const checkedFiles = new Set<string>();

  // 1. Scan tracked diff (committed since baseBranch + staged + unstaged)
  const diff = getDiffText(worktreeDir, opts.baseBranch);
  let currentFile = "";
  let currentLine = 0;

  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith("+++ b/")) {
      currentFile = rawLine.slice(6).trim();
      if (!checkedFiles.has(currentFile)) {
        checkedFiles.add(currentFile);
        const blocked = checkBlockedFilename(currentFile, allowlist);
        if (blocked) findings.push(blocked);
      }
      continue;
    }
    if (rawLine.startsWith("+++ /dev/null")) {
      currentFile = "";
      continue;
    }
    if (rawLine.startsWith("@@ ")) {
      const hunkMatch = rawLine.match(/\+(\d+)/);
      currentLine = hunkMatch ? Number(hunkMatch[1]) : 1;
      continue;
    }
    if (!currentFile) continue;

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      const lineContent = rawLine.slice(1);
      findings.push(...scanLineForLeaks(currentFile, currentLine, lineContent, allowlist));
      currentLine += 1;
    }
  }

  // 2. Scan untracked non-ignored files
  for (const relFile of getUntrackedFiles(worktreeDir)) {
    if (!checkedFiles.has(relFile)) {
      checkedFiles.add(relFile);
      const blocked = checkBlockedFilename(relFile, allowlist);
      if (blocked) findings.push(blocked);
    }

    const absPath = path.join(worktreeDir, relFile);
    if (!isLikelyTextFile(absPath)) continue;

    const content = fs.readFileSync(absPath, "utf8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      findings.push(...scanLineForLeaks(relFile, i + 1, lines[i], allowlist));
    }
  }

  return {
    ok: findings.length === 0,
    findings,
  };
}

export function formatSafetyFindings(findings: SafetyFinding[]): string {
  if (findings.length === 0) return "Safety check passed: no secrets, deployment config IDs, keys, or emails detected.";
  const lines = [
    `Safety check FAILED (${findings.length} potential leak${findings.length === 1 ? "" : "s"} detected):`,
    ...findings.map((f) => {
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      return `- [${f.rule}] ${loc} — ${f.message} (matched: ${f.preview})`;
    }),
  ];
  return lines.join("\n");
}

export function assertWorktreeSafe(worktreeDir: string, opts: SafetyScanOptions = {}): void {
  const res = scanWorktreeSafety(worktreeDir, opts);
  if (!res.ok) {
    throw new Error(formatSafetyFindings(res.findings));
  }
}
