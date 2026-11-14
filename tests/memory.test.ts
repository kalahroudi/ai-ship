import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendMemory,
  buildDreamPrompt,
  forgetMemory,
  getMemoryPath,
  readMemory,
  writeConsolidatedMemory,
} from "../src/memory.ts";
import { createAiShipPlugin, resolveShipTaskInput, type ToolHelper } from "../plugin/index.ts";

function withTempMemoryDir(fn: (repoDir: string) => void | Promise<void>) {
  const prev = process.env.OPENCODE_MEMORY_DIR;
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-mem-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-repo-"));
  process.env.OPENCODE_MEMORY_DIR = memDir;
  return Promise.resolve(fn(repoDir)).finally(() => {
    if (prev === undefined) delete process.env.OPENCODE_MEMORY_DIR;
    else process.env.OPENCODE_MEMORY_DIR = prev;
    fs.rmSync(memDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });
}

test("memory helpers append, deduplicate, read, forget, and consolidate", async () => {
  await withTempMemoryDir((repoDir) => {
    assert.equal(readMemory(repoDir), "");

    const first = appendMemory(repoDir, "Always pin target.pathname in gateway.ts", "security");
    assert.equal(first.added, true);
    assert.equal(first.path, getMemoryPath(repoDir));

    const dup = appendMemory(repoDir, "Always pin target.pathname in gateway.ts", "security");
    assert.equal(dup.added, false);

    appendMemory(repoDir, "Run pnpm guard before pushing", "build");
    const content = readMemory(repoDir);
    assert.match(content, /\[security\].*gateway\.ts/);
    assert.match(content, /\[build\].*pnpm guard/);

    const forgot = forgetMemory(repoDir, "pnpm guard");
    assert.equal(forgot.removedCount, 1);
    assert.doesNotMatch(readMemory(repoDir), /pnpm guard/);

    writeConsolidatedMemory(repoDir, "# Repo Memory\n- [security] Consolidated rule");
    assert.equal(readMemory(repoDir), "# Repo Memory\n- [security] Consolidated rule");
  });
});

test("buildDreamPrompt includes current memory and transcripts", () => {
  const prompt = buildDreamPrompt("rose", "- [note] old rule", "### Session: S1\n- **user**: fix bug");
  assert.match(prompt, /repository "rose"/);
  assert.match(prompt, /old rule/);
  assert.match(prompt, /Session: S1/);
});

test("createAiShipPlugin registers commands, injects memory, and executes memory tools", async () => {
  await withTempMemoryDir(async (repoDir) => {
    const fakeSchema = () => ({ optional: () => fakeSchema(), describe: () => fakeSchema() });
    const fakeTool: ToolHelper = Object.assign((def: any) => def, {
      schema: { string: fakeSchema, boolean: fakeSchema },
    });

    const factory = createAiShipPlugin(fakeTool);
    const hooks = await factory({
      client: {} as never,
      directory: repoDir,
      worktree: repoDir,
    });

    const cfg: Record<string, any> = {};
    await hooks.config(cfg);
    assert.ok(cfg.command.ship);
    assert.ok(cfg.command.dream);
    assert.ok(cfg.command.remember);
    assert.ok(cfg.command.cleanup);
    assert.ok(cfg.command.pr);
    assert.ok(hooks.tool.open_pr);

    const cmdOut = { parts: [] as Array<{ type: string; text?: string }> };
    await hooks["command.execute.before"](
      { command: "remember", sessionID: "s1", arguments: "Pin gateway pathname" },
      cmdOut
    );
    assert.match(readMemory(repoDir), /Pin gateway pathname/);
    assert.equal(cmdOut.parts.length, 1);

    const saveMsg = await hooks.tool.memory_save.execute(
      { entry: "Use gateway.ai.cloudflare.com", category: "infra" },
      { directory: repoDir, worktree: repoDir }
    );
    assert.match(saveMsg, /Saved to repo memory/);

    const sysOut = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({}, sysOut);
    assert.equal(sysOut.system.length, 1);
    assert.match(sysOut.system[0]!, /Use gateway\.ai\.cloudflare\.com/);

    const forgetMsg = await hooks.tool.memory_forget.execute(
      { query: "cloudflare" },
      { directory: repoDir, worktree: repoDir }
    );
    assert.match(forgetMsg, /Removed 1 matching entry/);
  });
});

test("resolveShipTaskInput parses inline flags and resolves noty:// URIs", () => {
  const prevNoty = process.env.NOTY_DIR;
  const notyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-noty-plugin-"));
  const id = "D282FF5A-FCE0-4034-8DFF-5694B8A29F99";
  fs.writeFileSync(
    path.join(notyDir, "task.md"),
    `---\nid: ${id}\ntitle: H1 Host Escape\n---\nAdd test for host escape.\n`
  );
  process.env.NOTY_DIR = notyDir;
  try {
    const res = resolveShipTaskInput(`noty://item/${id} --pr --skip-review`);
    assert.equal(res.openPr, true);
    assert.equal(res.skipReview, true);
    assert.equal(res.skipTests, false);
    assert.equal(res.title, "H1 Host Escape");
    assert.match(res.task, /H1 Host Escape/);
    assert.match(res.task, /Add test for host escape/);
  } finally {
    if (prevNoty === undefined) delete process.env.NOTY_DIR;
    else process.env.NOTY_DIR = prevNoty;
    fs.rmSync(notyDir, { recursive: true, force: true });
  }
});
