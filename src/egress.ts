import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

/**
 * Local egress proxy in front of the Cloudflare AI Gateway. OpenCode talks to http://127.0.0.1:<port>; the
 * proxy forwards to the gateway `/compat` endpoint, adds the gateway auth header and `cf-aig-metadata`
 * (task/repo tags visible in the Cloudflare logs), streams responses through unchanged, and reports token
 * usage parsed from the response (non-streaming JSON or the final SSE chunk) via `onUsage`.
 * It is also the single place later tasks hook budget enforcement and concurrency limits into.
 */

export interface EgressUsage {
  model?: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  status: number;
}

export interface EgressProxy {
  url: string;
  close(): Promise<void>;
}

/** Extracts OpenAI-style usage from a JSON body or an SSE stream (last `usage` object wins). */
export function parseUsageFromBody(body: string): Omit<EgressUsage, "status"> | undefined {
  let found: Record<string, unknown> | undefined;
  let model: string | undefined;
  const consider = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    if (typeof o.model === "string") model = o.model;
    if (o.usage && typeof o.usage === "object") found = o.usage as Record<string, unknown>;
  };
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      consider(JSON.parse(trimmed));
    } catch {
      // not JSON
    }
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        consider(JSON.parse(data));
      } catch {
        // partial line
      }
    }
  }
  if (!found) {
    // Fallback for a JSON body larger than the captured tail: take the last `"usage":{...}` object.
    const all = [...trimmed.matchAll(/"usage"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/g)];
    const last = all[all.length - 1];
    if (last) {
      try {
        found = JSON.parse(last[1]) as Record<string, unknown>;
      } catch {
        // ignore
      }
    }
  }
  if (!found) return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const details = (found.prompt_tokens_details ?? {}) as Record<string, unknown>;
  return {
    ...(model ? { model } : {}),
    promptTokens: num(found.prompt_tokens),
    completionTokens: num(found.completion_tokens),
    cachedTokens: num(details.cached_tokens),
  };
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "host",
  "content-length",
  // ask upstream for identity encoding so usage can be parsed from the bytes we relay
  "accept-encoding",
]);
/** Usage arrives in the LAST SSE chunk: keep a rolling tail of this size for parsing. */
const TAIL_CAPTURE = 256 * 1024;
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;

/**
 * Resolves a request path against the upstream base WITHOUT letting it change host or escape the base path.
 * Returns undefined for absolute URLs, scheme-relative or backslash paths, and `..` traversal (raw or encoded).
 */
export function resolveUpstreamTarget(upstream: URL, rawPath: string | undefined): URL | undefined {
  const p = rawPath ?? "/";
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(p.split("?")[0]);
  } catch {
    return undefined;
  }
  if (decoded.split("/").some((seg) => seg === ".." || seg === ".") || decoded.includes("\\")) return undefined;
  const basePath = upstream.pathname.replace(/\/+$/, "");
  const target = new URL(upstream.origin);
  const [pathPart, query] = p.split(/\?(.*)/s, 2);
  target.pathname = `${basePath}${pathPart}`;
  if (query) target.search = `?${query}`;
  if (target.origin !== upstream.origin || !target.pathname.startsWith(`${basePath}/`)) return undefined;
  return target;
}

/** FIFO semaphore per key; `limit` undefined or ≤ 0 means unlimited. */
export function createKeyedLimiter(): { acquire(key: string, limit?: number): Promise<() => void>; active(key: string): number } {
  const state = new Map<string, { active: number; queue: Array<() => void> }>();
  const get = (k: string) => {
    let s = state.get(k);
    if (!s) state.set(k, (s = { active: 0, queue: [] }));
    return s;
  };
  return {
    active: (k) => state.get(k)?.active ?? 0,
    acquire(key, limit) {
      const s = get(key);
      const release = () => {
        s.active -= 1;
        const next = s.queue.shift();
        if (next) next();
      };
      if (!limit || limit <= 0 || s.active < limit) {
        s.active += 1;
        return Promise.resolve(release);
      }
      return new Promise((resolve) => {
        s.queue.push(() => {
          s.active += 1;
          resolve(release);
        });
      });
    },
  };
}

export async function startEgressProxy(opts: {
  upstreamBase: string;
  token?: string;
  metadata?: () => Record<string, string | number | boolean>;
  onUsage?: (u: EgressUsage) => void;
  /** Called before each upstream request; throw to reject it (e.g. budget exhausted) with HTTP 429. */
  beforeRequest?: (info: { model?: string }) => void | Promise<void>;
  /** Max concurrent upstream requests per model (from the catalog); extra requests wait in FIFO order. */
  maxConcurrency?: (model: string | undefined) => number | undefined;
}): Promise<EgressProxy> {
  const limiter = createKeyedLimiter();
  const upstream = new URL(opts.upstreamBase.replace(/\/+$/, "") + "/");
  const client = upstream.protocol === "https:" ? https : http;

  const server = http.createServer(async (req, res) => {
    const target = resolveUpstreamTarget(upstream, req.url);
    if (!target) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "ai-ship egress: invalid request path" } }));
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    try {
      for await (const c of req) {
        received += (c as Buffer).length;
        if (received > MAX_REQUEST_BYTES) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "ai-ship egress: request too large" } }));
          return;
        }
        chunks.push(c as Buffer);
      }
    } catch {
      // client aborted mid-body
      if (!res.headersSent) res.writeHead(400);
      res.end();
      return;
    }
    const body = Buffer.concat(chunks);
    let model: string | undefined;
    try {
      model = (JSON.parse(body.toString("utf8") || "{}") as { model?: string }).model;
    } catch {
      // non-JSON body
    }
    try {
      await opts.beforeRequest?.({ model });
    } catch (err) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `ai-ship egress: ${(err as Error).message}`, type: "budget" } }));
      return;
    }
    const limit = opts.maxConcurrency?.(model);
    // Watch for the client going away BEFORE waiting for a slot: a request whose client is gone must
    // neither be sent upstream (paid call) nor keep its slot.
    let clientGone = false;
    let release: (() => void) | undefined;
    let released = false;
    const done = () => {
      if (release && !released) {
        released = true;
        release();
      }
    };
    res.on("close", () => {
      clientGone = true;
      done();
    });
    release = await limiter.acquire(model ?? "(none)", limit);
    if (clientGone) {
      done();
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === "string" && k.toLowerCase() !== "authorization") headers[k] = v;
    }
    if (opts.token) headers["cf-aig-authorization"] = `Bearer ${opts.token}`;
    const meta = opts.metadata?.();
    if (meta) headers["cf-aig-metadata"] = JSON.stringify(meta);
    headers["content-length"] = String(body.length);

    const up = client.request(target, { method: req.method, headers }, (upRes) => {
      const outHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v as string | string[];
      }
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      // Rolling tail: the final SSE chunk (with usage) is always kept, however long the stream is.
      let tail = Buffer.alloc(0);
      upRes.on("data", (c: Buffer) => {
        tail = Buffer.concat([tail, c]);
        if (tail.length > TAIL_CAPTURE) tail = tail.subarray(tail.length - TAIL_CAPTURE);
        res.write(c);
      });
      // Upstream died mid-stream (after headers): end the client response instead of hanging it.
      const abortClient = () => {
        if (!upRes.complete && !res.writableEnded) res.destroy();
      };
      upRes.on("error", abortClient);
      upRes.on("close", abortClient);
      upRes.on("end", () => {
        res.end();
        const text = tail.toString("utf8");
        // If the tail was cut mid-line, drop the partial first line before parsing.
        const usage = parseUsageFromBody(text.startsWith("data:") || text.startsWith("{") ? text : text.slice(text.indexOf("\n") + 1));
        if (usage) opts.onUsage?.({ ...usage, model: usage.model ?? model, status: upRes.statusCode ?? 0 });
      });
    });
    // Stop the upstream call if the client goes away (e.g. the agent turn was interrupted).
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    up.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `ai-ship egress upstream error: ${err.message}` } }));
    });
    up.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
