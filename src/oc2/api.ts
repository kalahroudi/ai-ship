import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Minimal OpenCode 2.x API used by ai-ship, with two backends:
 * - `createCtxApi(ctx)`: inside a native 2.x plugin (`ctx.session.*`), verified against opencode-cli 2.3.0;
 * - `createRestApi({ baseUrl, password })`: an external process talking to the Desktop background service
 *   (`/api/...` routes, Basic auth `opencode:<password>`).
 * Both return the same chronological message shape.
 */

export interface Oc2ModelRef {
  providerID: string;
  id: string;
}

export interface Oc2Tokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface Oc2ContentPart {
  type: string;
  text?: string;
  name?: string;
  state?: { status?: string; input?: unknown; title?: string } | unknown;
}

export interface Oc2Message {
  id: string;
  type: "user" | "assistant" | "idle" | string;
  text?: string;
  agent?: string;
  model?: Oc2ModelRef;
  content?: Oc2ContentPart[];
  cost?: number;
  tokens?: Oc2Tokens;
  outcome?: string;
  time?: { created?: number; completed?: number };
}

export interface Oc2SessionInfo {
  id: string;
  parentID?: string;
  outcome?: string;
  cost?: number;
  tokens?: Oc2Tokens;
  time?: { busy?: number; idle?: number; created?: number; updated?: number };
}

export interface Oc2CreateSessionInput {
  title: string;
  parentID?: string;
  agent?: string;
  model?: Oc2ModelRef;
  /** Working directory; ignored by the server for child sessions (they run at the parent's location). */
  directory?: string;
}

export interface Oc2Api {
  createSession(input: Oc2CreateSessionInput): Promise<{ id: string }>;
  prompt(sessionID: string, text: string, directory?: string): Promise<{ id: string }>;
  /** Resolves once the session is idle after the latest prompt. */
  wait(sessionID: string, directory?: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<void>;
  /** Chronological messages of a session. */
  messages(sessionID: string, directory?: string): Promise<Oc2Message[]>;
  interrupt?(sessionID: string, directory?: string): Promise<void>;
  compact?(sessionID: string, directory?: string): Promise<void>;
  agents?(directory?: string): Promise<string[]>;
}

/** Shape of the subset of the 2.x plugin context used here. */
export interface Oc2PluginCtxLike {
  session: {
    create(input: Record<string, unknown>): Promise<{ id: string }>;
    prompt(input: { sessionID: string; text: string }): Promise<{ id: string }>;
    wait(input: { sessionID: string }): Promise<unknown>;
    context(input: { sessionID: string }): Promise<unknown>;
    interrupt?(input: { sessionID: string }): Promise<unknown>;
    compact?(input: { sessionID: string }): Promise<unknown>;
    /** Adds a visible message to a session; `resume: false` keeps the agent from replying. */
    synthetic?(input: { sessionID: string; text: string; resume?: boolean; description?: string }): Promise<unknown>;
  };
}

export function createCtxApi(ctx: Oc2PluginCtxLike): Oc2Api {
  return {
    async createSession(input) {
      const s = await ctx.session.create({
        title: input.title,
        ...(input.parentID ? { parentID: input.parentID } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.directory && !input.parentID ? { location: { directory: input.directory } } : {}),
      });
      return { id: s.id };
    },
    async prompt(sessionID, text) {
      const m = await ctx.session.prompt({ sessionID, text });
      return { id: m.id };
    },
    async wait(sessionID, _directory, waitOpts) {
      const timeoutMs = waitOpts?.timeoutMs ?? 30 * 60_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ctx.session.wait({ sessionID }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`OpenCode session ${sessionID} did not become idle in time`)), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async messages(sessionID) {
      const list = await ctx.session.context({ sessionID });
      return Array.isArray(list) ? (list as Oc2Message[]) : [];
    },
    async interrupt(sessionID) {
      await ctx.session.interrupt?.({ sessionID });
    },
    async compact(sessionID) {
      await ctx.session.compact?.({ sessionID });
    },
  };
}

export class Oc2HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "Oc2HttpError";
    this.status = status;
  }
}

export function createRestApi(opts: {
  baseUrl: string;
  password?: string;
  fetchImpl?: typeof fetch;
  pollMs?: number;
}): Oc2Api {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const pollMs = opts.pollMs ?? 1000;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.password) headers.authorization = `Basic ${Buffer.from(`opencode:${opts.password}`).toString("base64")}`;
  const q = (directory?: string) => (directory ? `?directory=${encodeURIComponent(directory)}` : "");
  const call = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await doFetch(`${base}${route}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Oc2HttpError(res.status, `OpenCode ${method} ${route.split("?")[0]} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (!text) return undefined as T;
    const parsed = JSON.parse(text) as { data?: T };
    return (parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed) as T;
  };
  const getSession = (id: string, directory?: string) =>
    call<Oc2SessionInfo>("GET", `/api/session/${encodeURIComponent(id)}${q(directory)}`);

  return {
    async createSession(input) {
      const s = await call<{ id: string }>("POST", `/api/session${q(input.directory)}`, {
        title: input.title,
        ...(input.parentID ? { parentID: input.parentID } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
      return { id: s.id };
    },
    async prompt(sessionID, text, directory) {
      const m = await call<{ id: string }>("POST", `/api/session/${encodeURIComponent(sessionID)}/prompt${q(directory)}`, { text });
      return { id: m.id };
    },
    async wait(sessionID, directory, waitOpts) {
      const deadline = Date.now() + (waitOpts?.timeoutMs ?? 30 * 60_000);
      // A prompt is admitted asynchronously: idle once `time.idle >= time.busy` and an outcome is recorded.
      for (;;) {
        if (waitOpts?.signal?.aborted) throw new Error("wait aborted");
        const s = await getSession(sessionID, directory);
        const busy = s.time?.busy ?? 0;
        const idle = s.time?.idle ?? 0;
        if (s.outcome && idle >= busy && busy > 0) return;
        if (Date.now() > deadline) throw new Error(`OpenCode session ${sessionID} did not become idle in time`);
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
    async messages(sessionID, directory) {
      const list = await call<Oc2Message[]>("GET", `/api/session/${encodeURIComponent(sessionID)}/message${q(directory)}`);
      // REST lists newest first; normalize to chronological like the plugin context.
      return Array.isArray(list) ? [...list].reverse() : [];
    },
    async interrupt(sessionID, directory) {
      await call("POST", `/api/session/${encodeURIComponent(sessionID)}/interrupt${q(directory)}`);
    },
    async compact(sessionID, directory) {
      await call("POST", `/api/session/${encodeURIComponent(sessionID)}/compact${q(directory)}`);
    },
    async agents(directory) {
      const list = await call<Array<{ id?: string; name?: string }>>("GET", `/api/agent${q(directory)}`);
      return Array.isArray(list) ? list.map((a) => a.id ?? a.name ?? "").filter(Boolean) : [];
    },
  };
}

/** Password of the OpenCode Desktop background service (~/.config/opencode/service.json), if present. */
export function readServicePassword(file = path.join(os.homedir(), ".config", "opencode", "service.json")): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { password?: unknown };
    return typeof parsed.password === "string" && parsed.password ? parsed.password : undefined;
  } catch {
    return undefined;
  }
}

/** Candidate paths of the Desktop-bundled `opencode-cli` (newest version first). */
export function findDesktopCli(home = os.homedir()): string | undefined {
  const root = path.join(home, "Library", "Application Support", "ai.opencode.desktop", "cli");
  try {
    const dirs = fs.readdirSync(root).sort().reverse();
    for (const d of dirs) {
      const bin = path.join(root, d, "opencode-cli");
      if (fs.existsSync(bin)) return bin;
    }
  } catch {
    // not installed
  }
  return undefined;
}

/**
 * Discovers the running Desktop background service: URL from `opencode-cli service status`
 * (or OPENCODE_SERVER_URL), password from OPENCODE_SERVER_PASSWORD or service.json.
 */
/** True for https URLs and plain-http loopback URLs (where sending the local service password is safe). */
export function isSafeForPassword(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}

export function discoverDesktopService(): { baseUrl: string; password?: string } | undefined {
  const explicit = process.env.OPENCODE_SERVER_PASSWORD;
  if (process.env.OPENCODE_SERVER_URL) {
    const baseUrl = process.env.OPENCODE_SERVER_URL;
    // Never send the local Desktop service password to a remote plain-http server.
    const password = explicit || (isSafeForPassword(baseUrl) ? readServicePassword() : undefined);
    return { baseUrl, password };
  }
  const password = explicit || readServicePassword();
  const cli = findDesktopCli();
  if (!cli) return undefined;
  const res = spawnSync(cli, ["service", "status"], { encoding: "utf8", timeout: 10_000 });
  const url = `${res.stdout ?? ""}`.match(/https?:\/\/[^\s]+/)?.[0];
  return url ? { baseUrl: url, password } : undefined;
}
