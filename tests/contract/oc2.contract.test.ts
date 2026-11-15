import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createRestApi } from "../../src/oc2/api.ts";
import { startFakeOpenAI } from "../fixtures/fake-openai.mjs";

function findCli(): string | undefined {
  if (process.env.OPENCODE_CLI && fs.existsSync(process.env.OPENCODE_CLI)) return process.env.OPENCODE_CLI;
  const root = path.join(os.homedir(), "Library", "Application Support", "ai.opencode.desktop", "cli");
  try {
    for (const d of fs.readdirSync(root).sort().reverse()) {
      const bin = path.join(root, d, "opencode-cli");
      if (fs.existsSync(bin)) return bin;
    }
  } catch {}
  return undefined;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });

const cli = findCli();

test("contract: real opencode-cli 2.x REST api (fake model)", { skip: cli ? false : "opencode-cli 2.x not installed", timeout: 60_000 }, async () => {
  const fake = await startFakeOpenAI((last: string) => (last.includes("second-prompt") ? "ECHO-TWO" : last.includes("first-prompt") ? "ECHO-ONE" : "Hello from fake model."));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-contract-"));
  const xdg = (n: string) => {
    const d = path.join(scratch, n);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const config = xdg("config");
  const workdir = xdg("work");
  fs.mkdirSync(path.join(config, "opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(config, "opencode", "opencode.json"),
    JSON.stringify({
      model: "fake/fake-model",
      provider: {
        fake: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fake",
          options: { baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: "x" },
          models: { "fake-model": { name: "Fake Model" } },
        },
      },
    })
  );
  const port = await freePort();
  let proc: ChildProcess | undefined;
  try {
    proc = spawn(cli as string, ["serve", "--port", String(port)], {
      cwd: workdir,
      env: { ...process.env, XDG_CONFIG_HOME: config, XDG_DATA_HOME: xdg("data"), XDG_STATE_HOME: xdg("state"), XDG_CACHE_HOME: xdg("cache") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const password = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no password in output:\n${out}`)), 30_000);
      const onData = (b: Buffer) => {
        out += b.toString();
        const m = out.match(/server password\s+(\S+)/);
        if (m) {
          clearTimeout(t);
          resolve(m[1]);
        }
      };
      proc!.stdout!.on("data", onData);
      proc!.stderr!.on("data", onData);
      proc!.on("exit", () => reject(new Error(`server exited early:\n${out}`)));
    });

    const api = createRestApi({ baseUrl: `http://127.0.0.1:${port}`, password, pollMs: 200 });
    const model = { providerID: "fake", id: "fake-model" };
    const parent = await api.createSession({ title: "ship: contract", directory: workdir, model });
    assert.ok(parent.id);
    await api.prompt(parent.id, "first-prompt", workdir);
    await api.wait(parent.id, workdir, { timeoutMs: 40_000 });
    const msgs = await api.messages(parent.id, workdir);
    const text = JSON.stringify(msgs);
    assert.ok(text.includes("ECHO-ONE"), `fake reply in messages: ${text.slice(0, 500)}`);

    // A second prompt on the same session must not resolve on the stale idle of the first turn.
    const before = await api.messages(parent.id, workdir);
    assert.ok(JSON.stringify(before).includes("ECHO-ONE"));
    const second = await api.prompt(parent.id, "second-prompt", workdir);
    await api.wait(parent.id, workdir, { timeoutMs: 40_000 });
    const all = await api.messages(parent.id, workdir);
    const idx = all.findIndex((m) => m.id === second.id);
    assert.ok(idx >= 0, "second user message present");
    assert.ok(JSON.stringify(all.slice(idx + 1)).includes("ECHO-TWO"), "second reply present after wait");

    const child = await api.createSession({ title: "child", parentID: parent.id, model, directory: workdir });
    const res = await fetch(`http://127.0.0.1:${port}/api/session/${child.id}`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    });
    const body = (await res.json()) as { data?: { parentID?: string }; parentID?: string };
    assert.equal((body.data ?? body).parentID, parent.id);
  } finally {
    proc?.kill("SIGTERM");
    setTimeout(() => proc?.kill("SIGKILL"), 2000).unref();
    await fake.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
