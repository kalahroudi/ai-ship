import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getModelsFilePath, loadPricingTable } from "./pricing.ts";

/** Supported OpenCode server range for the native plugin. */
export const SUPPORTED_OPENCODE = { minMajor: 2, minMinor: 3, maxMajorExclusive: 3 };

export function isSupportedOpencodeVersion(version: string | undefined): boolean {
  const m = (version ?? "").match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < SUPPORTED_OPENCODE.minMajor || major >= SUPPORTED_OPENCODE.maxMajorExclusive) return false;
  return major > SUPPORTED_OPENCODE.minMajor || minor >= SUPPORTED_OPENCODE.minMinor;
}

export function getOpencodeConfigDir(): string {
  return process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
    : path.join(os.homedir(), ".config", "opencode");
}

/** The ai-ship MCP server entry in an OpenCode config (2.x and 1.x shapes), if any. */
export function findAiShipMcpEntry(cfg: unknown): { container: Record<string, unknown>; key: string } | undefined {
  if (!cfg || typeof cfg !== "object") return undefined;
  const mcp = (cfg as { mcp?: unknown }).mcp;
  if (!mcp || typeof mcp !== "object") return undefined;
  const containers: Array<Record<string, unknown>> = [mcp as Record<string, unknown>];
  const servers = (mcp as { servers?: unknown }).servers;
  if (servers && typeof servers === "object") containers.unshift(servers as Record<string, unknown>);
  for (const container of containers) {
    for (const [key, value] of Object.entries(container)) {
      if (key === "servers") continue;
      const cmd = JSON.stringify((value as { command?: unknown })?.command ?? "");
      // The server key, or a command that runs ai-ship's own CLI entry point with --mcp.
      if (key === "ai-ship" || (/ai-ship(\.mjs|\/bin\/ai-ship)/.test(cmd) && cmd.includes("--mcp"))) return { container, key };
    }
  }
  return undefined;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fixable?: boolean;
}

export interface DoctorOptions {
  opencodeVersion?: string;
  configDir?: string;
  fix?: boolean;
  hasCommand?: (cmd: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

const defaultHasCommand = (cmd: string) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

/**
 * Checks the local setup for the native OpenCode 2.x integration. With `fix`, removes a duplicate ai-ship MCP
 * server entry from opencode.json (after writing a timestamped backup); it never changes anything else.
 */
export function runDoctor(opts: DoctorOptions = {}): { checks: DoctorCheck[]; fixed: string[] } {
  const configDir = opts.configDir ?? getOpencodeConfigDir();
  const env = opts.env ?? process.env;
  const has = opts.hasCommand ?? defaultHasCommand;
  const checks: DoctorCheck[] = [];
  const fixed: string[] = [];

  if (opts.opencodeVersion !== undefined) {
    const ok = isSupportedOpencodeVersion(opts.opencodeVersion);
    checks.push({
      name: "OpenCode version",
      ok,
      detail: ok ? `${opts.opencodeVersion} (supported)` : `${opts.opencodeVersion} — native plugin supports >=2.3 <3`,
    });
  }

  const pluginsDir = path.join(configDir, "plugins");
  const pluginFile = path.join(pluginsDir, "ai-ship.ts");
  const installed = fs.existsSync(pluginFile);
  checks.push({
    name: "Native plugin installed",
    ok: installed,
    detail: installed ? pluginFile : "missing — run `ai-ship --plugin-install`",
  });

  const cfgPath = path.join(configDir, "opencode.json");
  const jsoncPath = path.join(configDir, "opencode.jsonc");
  let cfg: unknown;
  let parseProblem: string | undefined;
  if (fs.existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch (err) {
      parseProblem = `${cfgPath} is not plain JSON (${(err as Error).message}); check its "mcp" section manually`;
    }
  }
  if (fs.existsSync(jsoncPath)) {
    const text = fs.readFileSync(jsoncPath, "utf8");
    if (/ai-ship(\.mjs|\/bin\/ai-ship)|"ai-ship"\s*:/.test(text)) {
      parseProblem = `${jsoncPath} appears to configure the ai-ship MCP server; remove it manually (JSONC files are never rewritten)`;
    }
  }
  if (parseProblem) {
    checks.push({ name: "No duplicate ai-ship MCP server", ok: false, detail: parseProblem });
  }
  const dup = parseProblem ? undefined : findAiShipMcpEntry(cfg);
  if (dup && opts.fix) {
    const backup = `${cfgPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(cfgPath, backup);
    delete dup.container[dup.key];
    const tmp = `${cfgPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, cfgPath); // atomic replace
    fixed.push(`removed MCP server "${dup.key}" from ${cfgPath} (backup: ${backup})`);
  }
  if (!parseProblem) checks.push({
    name: "No duplicate ai-ship MCP server",
    ok: !dup || Boolean(opts.fix),
    detail: dup
      ? opts.fix
        ? `removed "${dup.key}"`
        : `"${dup.key}" is configured in ${cfgPath}; the native plugin replaces it inside OpenCode (run with --fix to remove; MCP stays available for other clients)`
      : "none",
    fixable: Boolean(dup) && !opts.fix,
  });

  for (const cmd of ["git", "gh"]) {
    const ok = has(cmd);
    checks.push({ name: `${cmd} available`, ok, detail: ok ? "yes" : `${cmd} not found on PATH` });
  }

  const pricing = loadPricingTable();
  const priced = Object.keys(pricing).length;
  checks.push({
    name: "Model pricing",
    ok: priced > 0,
    detail: priced > 0 ? `${priced} priced model(s) in ${getModelsFilePath()}` : `no prices in ${getModelsFilePath()} (cost limits may be blind)`,
  });

  const token = env.CF_AIG_TOKEN || env.CF_API_TOKEN;
  checks.push({
    name: "Cloudflare AI Gateway token",
    ok: Boolean(token),
    detail: token ? "set" : "CF_AIG_TOKEN not set (needed once gateway routing is enabled)",
  });

  return { checks, fixed };
}

export function formatDoctor(res: { checks: DoctorCheck[]; fixed: string[] }): string {
  const lines = res.checks.map((c) => `${c.ok ? "✔" : "✖"} ${c.name}: ${c.detail}`);
  if (res.fixed.length) lines.push("", "Fixed:", ...res.fixed.map((f) => `- ${f}`));
  return lines.join("\n");
}

const PLUGIN_MARKER = "// ai-ship native plugin (generated by `ai-ship --plugin-install`)";
/** Prefix shared by every marker version, so files from older installs are still recognised. */
const PLUGIN_MARKER_PREFIX = "// ai-ship native plugin (generated by";

/** Writes ~/.config/opencode/plugins/ai-ship.ts re-exporting this checkout's native plugin. */
export function installPlugin(opts: { configDir?: string; pluginEntry: string }): string {
  const dir = path.join(opts.configDir ?? getOpencodeConfigDir(), "plugins");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ai-ship.ts");
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes(PLUGIN_MARKER_PREFIX)) {
    throw new Error(`${file} exists and was not created by ai-ship; remove it first.`);
  }
  fs.writeFileSync(file, `${PLUGIN_MARKER}\nexport { default } from ${JSON.stringify(opts.pluginEntry)};\n`, "utf8");
  return file;
}

/** Removes the plugin file written by installPlugin (never touches files it did not create). */
export function uninstallPlugin(opts: { configDir?: string } = {}): string | undefined {
  const file = path.join(opts.configDir ?? getOpencodeConfigDir(), "plugins", "ai-ship.ts");
  if (!fs.existsSync(file)) return undefined;
  if (!fs.readFileSync(file, "utf8").includes(PLUGIN_MARKER_PREFIX)) {
    throw new Error(`${file} was not created by ai-ship; not removing it.`);
  }
  fs.rmSync(file);
  return file;
}

/** Copies AGENTS.md and .ai-ship.json templates into a repo without overwriting. */
export function initRepo(repoDir: string, templatesDir: string): string[] {
  const out: string[] = [];
  for (const file of ["AGENTS.md", ".ai-ship.json"]) {
    const dest = path.join(repoDir, file);
    if (fs.existsSync(dest)) out.push(`Skipping ${file} (already exists at ${dest})`);
    else {
      fs.copyFileSync(path.join(templatesDir, file), dest);
      out.push(`Created ${dest}`);
    }
  }
  return out;
}
