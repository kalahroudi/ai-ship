import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAiShipMcpEntry, initRepo, installPlugin, isSupportedOpencodeVersion, runDoctor, uninstallPlugin } from "../src/doctor.ts";
import { loadRepoConfig, parseCliArgs } from "../src/config.ts";
import { createOc2Runner } from "../src/oc2/runner.ts";
import { execSync } from "node:child_process";
import { runPipeline } from "../src/pipeline.ts";
import type { PipelineRunner } from "../src/runner.ts";
import { createAiShipV2Plugin } from "../plugin/v2/index.ts";
import type { Oc2Api } from "../src/oc2/api.ts";

const prevModelsFile = process.env.AI_SHIP_MODELS_FILE;
process.env.AI_SHIP_MODELS_FILE = path.join(os.tmpdir(), `ai-ship-no-models-doctor-${process.pid}.json`);
process.on("exit", () => {
  if (prevModelsFile === undefined) delete process.env.AI_SHIP_MODELS_FILE;
  else process.env.AI_SHIP_MODELS_FILE = prevModelsFile;
});

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-doctor-")));
const noCmd = () => true;

test("isSupportedOpencodeVersion: >=2.3 <3", () => {
  const table: Array<[string | undefined, boolean]> = [
    ["2.3.0", true],
    ["2.3", true],
    ["2.10.1", true],
    ["v2.4.0", true],
    ["2.2.9", false],
    ["2.0.0", false],
    ["1.9.0", false],
    ["3.0.0", false],
    ["3.1.0", false],
    ["", false],
    [undefined, false],
    ["garbage", false],
  ];
  for (const [v, want] of table) assert.equal(isSupportedOpencodeVersion(v), want, String(v));
});

test("findAiShipMcpEntry: 2.x servers shape, flat shape, foreign servers", () => {
  const two = { mcp: { servers: { "ai-ship": { command: ["x"] }, noty: { command: ["noty"] } } } };
  const f2 = findAiShipMcpEntry(two)!;
  assert.equal(f2.key, "ai-ship");
  assert.equal(f2.container, two.mcp.servers);

  const flat = { mcp: { foo: { type: "local", command: ["node", "/x/ai-ship.mjs", "--mcp"] } } };
  const ff = findAiShipMcpEntry(flat)!;
  assert.equal(ff.key, "foo");
  assert.equal(ff.container, flat.mcp);

  assert.equal(findAiShipMcpEntry({ mcp: { servers: { noty: { command: ["noty", "--mcp"] } } } }), undefined);
  assert.equal(findAiShipMcpEntry({ mcp: { other: { command: ["ai-ship", "run"] } } }), undefined);
  assert.equal(findAiShipMcpEntry({}), undefined);
  assert.equal(findAiShipMcpEntry(null), undefined);
});

function writeCfg() {
  const dir = tmp();
  const cfg = {
    theme: "dark",
    mcp: {
      servers: {
        "ai-ship": { type: "local", command: ["node", "ai-ship.mjs", "--mcp"] },
        noty: { type: "local", command: ["noty-mcp"] },
      },
    },
  };
  const file = path.join(dir, "opencode.json");
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return { dir, file, original: fs.readFileSync(file, "utf8") };
}

test("runDoctor --fix removes only the ai-ship MCP entry and writes a backup", () => {
  const { dir, file, original } = writeCfg();
  try {
    const res = runDoctor({ configDir: dir, fix: true, opencodeVersion: "2.3.1", hasCommand: noCmd, env: {} });
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.mcp.servers["ai-ship"], undefined);
    assert.deepEqual(after.mcp.servers.noty, { type: "local", command: ["noty-mcp"] });
    assert.equal(after.theme, "dark");
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith("opencode.json.bak-"));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), original);
    assert.equal(res.fixed.length, 1);
    assert.ok(res.checks.find((c) => c.name === "No duplicate ai-ship MCP server")!.ok);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor without --fix changes nothing and fails with a hint", () => {
  const { dir, file, original } = writeCfg();
  try {
    const res = runDoctor({ configDir: dir, opencodeVersion: "1.9.0", hasCommand: noCmd, env: {} });
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.deepEqual(fs.readdirSync(dir), ["opencode.json"]);
    assert.deepEqual(res.fixed, []);
    const dup = res.checks.find((c) => c.name === "No duplicate ai-ship MCP server")!;
    assert.equal(dup.ok, false);
    assert.match(dup.detail, /--fix/);
    assert.equal(res.checks.find((c) => c.name === "OpenCode version")!.ok, false);
    assert.equal(res.checks.find((c) => c.name === "Cloudflare AI Gateway token")!.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor: missing config is fine; missing command is reported", () => {
  const dir = tmp();
  try {
    const res = runDoctor({ configDir: dir, hasCommand: (c) => c !== "gh", env: { CF_AIG_TOKEN: "t" } });
    assert.ok(res.checks.find((c) => c.name === "No duplicate ai-ship MCP server")!.ok);
    assert.equal(res.checks.find((c) => c.name === "gh available")!.ok, false);
    assert.ok(res.checks.find((c) => c.name === "git available")!.ok);
    assert.ok(res.checks.find((c) => c.name === "Cloudflare AI Gateway token")!.ok);
    assert.equal(res.checks.find((c) => c.name === "Native plugin installed")!.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("install/uninstall plugin: marker, foreign-file refusal, idempotent", () => {
  const dir = tmp();
  try {
    const file = installPlugin({ configDir: dir, pluginEntry: "/x/plugin/v2/index.ts" });
    assert.equal(file, path.join(dir, "plugins", "ai-ship.ts"));
    assert.match(fs.readFileSync(file, "utf8"), /ai-ship native plugin/);
    assert.match(fs.readFileSync(file, "utf8"), /\/x\/plugin\/v2\/index\.ts/);
    installPlugin({ configDir: dir, pluginEntry: "/y/index.ts" });
    assert.match(fs.readFileSync(file, "utf8"), /\/y\/index\.ts/);
    assert.equal(uninstallPlugin({ configDir: dir }), file);
    assert.ok(!fs.existsSync(file));
    assert.equal(uninstallPlugin({ configDir: dir }), undefined);

    fs.writeFileSync(file, "// mine\n");
    assert.throws(() => installPlugin({ configDir: dir, pluginEntry: "/x" }), /not created by ai-ship/);
    assert.throws(() => uninstallPlugin({ configDir: dir }), /not created by ai-ship/);
    assert.equal(fs.readFileSync(file, "utf8"), "// mine\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("initRepo never overwrites existing files", () => {
  const repo = tmp();
  const templates = tmp();
  try {
    fs.writeFileSync(path.join(templates, "AGENTS.md"), "T-AGENTS");
    fs.writeFileSync(path.join(templates, ".ai-ship.json"), "{}");
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "MINE");
    const out = initRepo(repo, templates);
    assert.equal(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"), "MINE");
    assert.equal(fs.readFileSync(path.join(repo, ".ai-ship.json"), "utf8"), "{}");
    assert.match(out[0], /Skipping AGENTS\.md/);
    assert.match(out[1], /Created/);
    assert.ok(initRepo(repo, templates).every((l) => /Skipping/.test(l)));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(templates, { recursive: true, force: true });
  }
});

test("parseCliArgs: doctor / fix / plugin flags", () => {
  const base = parseCliArgs([]);
  assert.equal(base.doDoctor, false);
  assert.equal(base.doFix, false);
  assert.equal(base.pluginAction, undefined);
  const d = parseCliArgs(["--doctor", "--fix"]);
  assert.equal(d.doDoctor, true);
  assert.equal(d.doFix, true);
  assert.equal(parseCliArgs(["--plugin-install"]).pluginAction, "install");
  assert.equal(parseCliArgs(["--plugin-uninstall"]).pluginAction, "uninstall");
});

test("oc2 runner cancel: interrupts real sessions, later prompts reject", async () => {
  let n = 0;
  const interrupted: string[] = [];
  const api: Oc2Api = {
    async createSession() { return { id: `ses_${++n}` }; },
    async prompt() { return { id: "u_1" }; },
    async wait() {},
    async messages() {
      return [
        { id: "u_1", type: "user" },
        { id: "a1", type: "assistant", content: [{ type: "text", text: "ok" }] },
        { id: "i1", type: "idle", outcome: "succeeded" },
      ];
    },
    async interrupt(id: string) { interrupted.push(id); },
  } as Oc2Api;
  const d = tmp();
  const config = loadRepoConfig(d);
  fs.rmSync(d, { recursive: true, force: true });
  const runner = createOc2Runner({ api, worktreeDir: "/wt", config, task: "t", pollMs: 1 });
  const s1 = await runner.createSession("Impl");
  const s2 = await runner.createSession("Never used");
  await runner.prompt(s1, "implementer", "go");
  assert.equal(runner.isCancelled(), false);
  await runner.cancel();
  assert.equal(runner.isCancelled(), true);
  assert.ok(interrupted.length >= 1);
  assert.ok(interrupted.includes("ses_2"), "child session interrupted");
  assert.ok(interrupted.every((id) => /^ses_\d+$/.test(id)), "only real ids, never local ids");
  await assert.rejects(runner.prompt(s2, "implementer", "again"), /cancelled/);
});

type Cmd = { name: string; execute: (i: { sessionID: string; prompt: { text: string } }) => Promise<string> };

async function loadPlugin(runPipelineFake: unknown, version?: string) {
  const commands = new Map<string, Cmd>();
  const ctx = {
    location: { directory: tmp() },
    app: version ? { version } : undefined,
    session: {
      async create() { return { id: "x" }; },
      async prompt() { return { id: "u" }; },
      async wait() {},
      async context() { return []; },
      async synthetic() {},
    },
    command: { transform(fn: (reg: { add(c: Cmd): void }) => void) { fn({ add: (c) => commands.set(c.name, c) }); } },
  };
  const plugin = createAiShipV2Plugin({ runPipeline: runPipelineFake as never, now: () => 1000 });
  await plugin.setup(ctx as never);
  return { commands, plugin };
}

test("plugin: /ship-cancel calls the job's cancel and reports", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fake = async () => {
    await gate;
    return { repoDir: "/r", worktreeDir: "/wt", branch: "b", baseBranch: "main", provider: "opencode", committed: false, verifyCommands: [], reviewVerdicts: [], usageLog: [] };
  };
  const { commands, plugin } = await loadPlugin(fake);
  for (const n of ["ship-cancel", "ship-init", "ship-doctor"]) assert.ok(commands.has(n), n);
  assert.match(await commands.get("ship-cancel")!.execute({ sessionID: "S", prompt: { text: "" } }), /no running job/);

  await commands.get("ship")!.execute({ sessionID: "S", prompt: { text: '"Do thing"' } });
  const job = plugin.jobs.get("job-1")!;
  let cancelled = 0;
  job.cancel = async () => { cancelled++; };
  const msg = await commands.get("ship-cancel")!.execute({ sessionID: "S", prompt: { text: "" } });
  assert.equal(cancelled, 1);
  assert.match(msg, /job-1.*cancel requested/);
  const byId = await commands.get("ship-cancel")!.execute({ sessionID: "S", prompt: { text: "job-1" } });
  assert.equal(cancelled, 2);
  assert.match(byId, /job-1/);
  release();
  for (let i = 0; i < 50 && job.status === "running"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.match(await commands.get("ship-cancel")!.execute({ sessionID: "S", prompt: { text: "job-1" } }), /already/);
});

test("plugin: /ship-doctor reports OpenCode version (temp XDG_CONFIG_HOME)", async () => {
  const xdg = tmp();
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const { commands } = await loadPlugin(async () => ({}), "2.3.4");
    const out = await commands.get("ship-doctor")!.execute({ sessionID: "S", prompt: { text: "" } });
    assert.match(out, /OpenCode version/);
    assert.match(out, /2\.3\.4/);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(xdg, { recursive: true, force: true });
  }
});

test("runDoctor: commented opencode.json is not rewritten", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "opencode.json");
    const text = '{\n  // my servers\n  "mcp": { "servers": { "ai-ship": { "command": ["ai-ship.mjs", "--mcp"] } } }\n}\n';
    fs.writeFileSync(file, text);
    const res = runDoctor({ configDir: dir, fix: true, hasCommand: noCmd, env: {} });
    const dup = res.checks.find((c) => c.name === "No duplicate ai-ship MCP server")!;
    assert.equal(dup.ok, false);
    assert.match(dup.detail, /not plain JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), text);
    assert.deepEqual(fs.readdirSync(dir), ["opencode.json"]);
    assert.deepEqual(res.fixed, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor: opencode.jsonc mentioning ai-ship is flagged, never touched", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "opencode.jsonc");
    const text = '{ // c\n "mcp": { "servers": { "ai-ship": { "command": ["node", "ai-ship.mjs", "--mcp"] } } } }\n';
    fs.writeFileSync(file, text);
    const res = runDoctor({ configDir: dir, fix: true, hasCommand: noCmd, env: {} });
    const dup = res.checks.find((c) => c.name === "No duplicate ai-ship MCP server")!;
    assert.equal(dup.ok, false);
    assert.match(dup.detail, /remove it manually/);
    assert.equal(fs.readFileSync(file, "utf8"), text);
    assert.deepEqual(fs.readdirSync(dir), ["opencode.jsonc"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findAiShipMcpEntry: requires an ai-ship entrypoint, not any ai-ship-named path", () => {
  assert.equal(findAiShipMcpEntry({ mcp: { h: { command: ["/opt/tools/ai-ship-helper/run", "--mcp"] } } }), undefined);
  assert.equal(findAiShipMcpEntry({ mcp: { h: { command: ["/x/ai-ship/bin/ai-ship.mjs", "--mcp"] } } })?.key, "h");
});

test("runDoctor --fix writes atomically (no temp file left) and hints at --plugin-install", () => {
  const { dir } = writeCfg();
  try {
    const res = runDoctor({ configDir: dir, fix: true, hasCommand: noCmd, env: {} });
    assert.ok(!fs.readdirSync(dir).some((f) => f.includes(".tmp-")));
    assert.match(res.checks.find((c) => c.name === "Native plugin installed")!.detail, /ai-ship --plugin-install/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function pipelineRepo() {
  const dir = tmp();
  const sh = (c: string) => execSync(c, { cwd: dir, stdio: "ignore" });
  sh("git init -b main");
  sh('git config user.email "t@example.com"');
  sh('git config user.name "T"');
  fs.writeFileSync(path.join(dir, "README.md"), "# t\n");
  fs.writeFileSync(
    path.join(dir, ".ai-ship.json"),
    JSON.stringify({ baseBranch: "main", verify: ['node -e "process.exit(0)"'], maxFixRetries: 1, reviewStaggerMs: 0, securityScan: false, safetyCheck: false, bughunter: false })
  );
  sh("git add -A && git commit -m init");
  return dir;
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const o = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = o;
  }
}

test("pipeline: isCancelled true up front rejects before any implementer prompt", async () => {
  const dir = pipelineRepo();
  try {
    let prompts = 0;
    const runner: PipelineRunner = { async createSession() { return "s"; }, async prompt() { prompts++; return { text: "x", usageSummary: "" }; }, close() {} };
    await quiet(async () =>
      assert.rejects(runPipeline({ repoDir: dir, task: "Add feature", openPr: false, skipTests: true, skipReview: true, runner, isCancelled: () => true }), /cancelled/)
    );
    assert.equal(prompts, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: cancel after stage 1 stops before commit", async () => {
  const dir = pipelineRepo();
  try {
    let cancelled = false;
    let wt = "";
    const runner: PipelineRunner = {
      async createSession() { return "s"; },
      async prompt() {
        fs.writeFileSync(path.join(wt, "f.ts"), "export const f = 1;\n");
        cancelled = true;
        return { text: "done", usageSummary: "" };
      },
      close() {},
    };
    await quiet(async () =>
      assert.rejects(
        runPipeline({ repoDir: dir, task: "Add feature", openPr: false, skipTests: true, skipReview: true, runner, isCancelled: () => cancelled, onWorktree: (d) => (wt = d) }),
        /cancelled/
      )
    );
    const log = execSync("git log --format=%s main..HEAD", { cwd: wt, encoding: "utf8" });
    assert.ok(!/add feature/i.test(log), `no final commit, got: ${log}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin: /ship-cancel before the runner exists marks the job cancelled", async () => {
  const fake = async (opts: { isCancelled?: () => boolean }) => {
    for (let i = 0; i < 200 && !opts.isCancelled?.(); i++) await new Promise((r) => setTimeout(r, 5));
    if (opts.isCancelled?.()) throw new Error("ai-ship run was cancelled");
    return {};
  };
  const { commands, plugin } = await loadPlugin(fake);
  await commands.get("ship")!.execute({ sessionID: "S", prompt: { text: '"Do thing"' } });
  const job = plugin.jobs.get("job-1")!;
  await commands.get("ship-cancel")!.execute({ sessionID: "S", prompt: { text: "" } });
  assert.equal(job.cancelled, true);
  for (let i = 0; i < 50 && job.status === "running"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(job.status, "cancelled");
});

test("oc2 runner: cancel during session creation rejects the prompt without calling api.prompt", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let prompted = 0;
  const api = {
    async createSession() { await gate; return { id: "ses_1" }; },
    async prompt() { prompted++; return { id: "u_1" }; },
    async wait() {},
    async messages() { return []; },
    async interrupt() {},
  } as Oc2Api;
  const d = tmp();
  const config = loadRepoConfig(d);
  fs.rmSync(d, { recursive: true, force: true });
  const runner = createOc2Runner({ api, worktreeDir: "/wt", config, task: "t", pollMs: 1 });
  const sid = await runner.createSession("Impl");
  const p = runner.prompt(sid, "implementer", "go");
  const settled = assert.rejects(p, /cancelled/);
  await new Promise((r) => setTimeout(r, 10));
  await runner.cancel();
  release();
  await settled;
  assert.equal(prompted, 0);
});
