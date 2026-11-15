import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import zlib from "node:zlib";
import net from "node:net";
import { parseUsageFromBody, resolveUpstreamTarget, startEgressProxy, type EgressUsage } from "../src/egress.ts";

test("parseUsageFromBody: JSON, SSE last usage wins, cached tokens, none", () => {
  const j = parseUsageFromBody(
    JSON.stringify({ model: "m", usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } })
  );
  assert.deepEqual(j, { model: "m", promptTokens: 10, completionTokens: 5, cachedTokens: 4 });
  const sse = [
    'data: {"model":"m","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    "",
    'data: {"usage":{"prompt_tokens":7,"completion_tokens":9}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  assert.deepEqual(parseUsageFromBody(sse), { model: "m", promptTokens: 7, completionTokens: 9, cachedTokens: 0 });
  assert.equal(parseUsageFromBody('data: {"choices":[]}\n\ndata: [DONE]\n'), undefined);
  assert.equal(parseUsageFromBody("garbage"), undefined);
});

async function fakeUpstream(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1/acc/gw/compat`, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

test("egress proxy: streams SSE unchanged, rewrites headers, reports usage", async () => {
  const seen: { url?: string; headers?: http.IncomingHttpHeaders; body?: string } = {};
  const sse =
    'data: {"model":"x/y","choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}}\n\n' +
    "data: [DONE]\n\n";
  const up = await fakeUpstream(async (req, res) => {
    seen.url = req.url;
    seen.headers = req.headers;
    const c: Buffer[] = [];
    for await (const x of req) c.push(x as Buffer);
    seen.body = Buffer.concat(c).toString();
    res.writeHead(200, { "content-type": "text/event-stream" });
    const mid = Math.floor(sse.length / 2);
    res.write(sse.slice(0, mid));
    setTimeout(() => res.end(sse.slice(mid)), 20);
  });
  const usages: EgressUsage[] = [];
  const proxy = await startEgressProxy({
    upstreamBase: up.url,
    token: "TOK",
    metadata: () => ({ task: "t1" }),
    onUsage: (u) => usages.push(u),
  });
  try {
    const body = JSON.stringify({ model: "x/y", stream: true });
    const res = await fetch(`${proxy.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer CLIENT-SECRET", "x-keep": "1" },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), sse);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(seen.url, "/v1/acc/gw/compat/chat/completions");
    assert.equal(seen.body, body);
    assert.equal(seen.headers?.authorization, undefined);
    assert.equal(seen.headers?.["cf-aig-authorization"], "Bearer TOK");
    assert.deepEqual(JSON.parse(String(seen.headers?.["cf-aig-metadata"])), { task: "t1" });
    assert.equal(seen.headers?.["x-keep"], "1");
    assert.equal(usages.length, 1);
    assert.deepEqual(usages[0], { model: "x/y", promptTokens: 11, completionTokens: 3, cachedTokens: 2, status: 200 });
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("egress proxy: non-streaming JSON usage is reported", async () => {
  const up = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "m", usage: { prompt_tokens: 2, completion_tokens: 4 } }));
  });
  const usages: EgressUsage[] = [];
  const proxy = await startEgressProxy({ upstreamBase: up.url + "/", onUsage: (u) => usages.push(u) });
  try {
    const res = await fetch(`${proxy.url}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m" }) });
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(usages[0].completionTokens, 4);
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("egress proxy: beforeRequest throwing gives 429 without hitting upstream", async () => {
  let hits = 0;
  const up = await fakeUpstream((_q, res) => { hits++; res.end("{}"); });
  let model: string | undefined;
  const proxy = await startEgressProxy({
    upstreamBase: up.url,
    beforeRequest: (i) => { model = i.model; throw new Error("budget exhausted"); },
  });
  try {
    const res = await fetch(`${proxy.url}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "a/b" }) });
    assert.equal(res.status, 429);
    assert.match(await res.text(), /budget exhausted/);
    assert.equal(hits, 0);
    assert.equal(model, "a/b");
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("egress proxy: unreachable upstream gives 502", async () => {
  const dead = await fakeUpstream((_q, res) => res.end());
  const base = dead.url;
  await dead.close();
  const proxy = await startEgressProxy({ upstreamBase: base });
  try {
    const res = await fetch(`${proxy.url}/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(res.status, 502);
    assert.match(await res.text(), /upstream error/);
  } finally {
    await proxy.close();
  }
});

test("resolveUpstreamTarget: keeps path+query under base, rejects escapes", () => {
  const base = new URL("http://127.0.0.1:9/v1/acc/gw/compat/");
  const ok = resolveUpstreamTarget(base, "/chat/completions?a=1");
  assert.equal(ok?.href, "http://127.0.0.1:9/v1/acc/gw/compat/chat/completions?a=1");
  for (const bad of ["http://127.0.0.1:9/abs", "/\\127.0.0.1:9/x", "//evil.com/x", "/../../x", "/%2e%2e/x", "/a/./b"]) {
    assert.equal(resolveUpstreamTarget(base, bad), undefined, bad);
  }
});

test("egress proxy: absolute-URL path gets 400 and nothing reaches another server", async () => {
  let otherHits = 0;
  const other = await fakeUpstream((_q, res) => { otherHits++; res.end("{}"); });
  const up = await fakeUpstream((_q, res) => res.end("{}"));
  const proxy = await startEgressProxy({ upstreamBase: up.url, token: "SECRET" });
  try {
    const port = new URL(proxy.url).port;
    const otherUrl = other.url.replace("/v1/acc/gw/compat", "/x");
    const raw = await new Promise<string>((resolve) => {
      const s = net.connect(Number(port), "127.0.0.1", () =>
        s.write(`POST ${otherUrl} HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`));
      let d = "";
      s.on("data", (c: Buffer) => (d += c));
      s.on("close", () => resolve(d));
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
    assert.equal(otherHits, 0);
  } finally {
    await proxy.close();
    await up.close();
    await other.close();
  }
});

test("egress proxy: accept-encoding not forwarded; usage reported with gzip-if-asked upstream", async () => {
  let ae: string | string[] | undefined;
  const payload = JSON.stringify({ model: "m", usage: { prompt_tokens: 3, completion_tokens: 6 } });
  const up = await fakeUpstream((req, res) => {
    ae = req.headers["accept-encoding"];
    if (String(ae ?? "").includes("gzip")) {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(zlib.gzipSync(payload));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    }
  });
  const usages: EgressUsage[] = [];
  const proxy = await startEgressProxy({ upstreamBase: up.url, onUsage: (u) => usages.push(u) });
  try {
    await new Promise<void>((resolve, reject) => {
      const r = http.request(`${proxy.url}/chat/completions`, { method: "POST", headers: { "accept-encoding": "gzip" } }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      r.on("error", reject);
      r.end("{}");
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!String(ae ?? "").includes("gzip"));
    assert.equal(usages[0]?.completionTokens, 6);
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("egress proxy: usage in final chunk of a >256KB stream is still reported", async () => {
  const filler = `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(1000) } }] })}\n\n`;
  const last = 'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":8}}\n\ndata: [DONE]\n\n';
  const up = await fakeUpstream((_q, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < 600; i++) res.write(filler);
    res.end(last);
  });
  const usages: EgressUsage[] = [];
  const proxy = await startEgressProxy({ upstreamBase: up.url, onUsage: (u) => usages.push(u) });
  try {
    const res = await fetch(`${proxy.url}/chat/completions`, { method: "POST", body: "{}" });
    const text = await res.text();
    assert.ok(text.length > 600 * 1000);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(usages[0]?.completionTokens, 8);
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("egress proxy: >20MB body gets 413; client abort mid-body does not crash", async () => {
  let hits = 0;
  const up = await fakeUpstream((_q, res) => { hits++; res.end("{}"); });
  const proxy = await startEgressProxy({ upstreamBase: up.url });
  try {
    const port = Number(new URL(proxy.url).port);
    const status = await new Promise<number>((resolve) => {
      const r = http.request({ host: "127.0.0.1", port, path: "/chat/completions", method: "POST" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        r.destroy();
      });
      r.on("error", () => {});
      const chunk = Buffer.alloc(1024 * 1024, 97);
      let n = 0;
      const write = () => {
        while (n < 30 && !r.destroyed) { n++; if (!r.write(chunk)) { r.once("drain", write); return; } }
        r.end();
      };
      write();
    });
    assert.equal(status, 413);
    assert.equal(hits, 0);
    // abort mid-body
    await new Promise<void>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.write("POST /chat/completions HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nabc");
        setTimeout(() => { s.destroy(); resolve(); }, 20);
      });
      s.on("error", () => {});
    });
    await new Promise((r) => setTimeout(r, 30));
    const ok = await fetch(`${proxy.url}/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(ok.status, 200);
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("parseUsageFromBody: truncated JSON tail still yields usage", () => {
  const tail = `ng content that was cut off","finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":1}}}`;
  const u = parseUsageFromBody(tail);
  assert.equal(u?.promptTokens, 5);
  assert.equal(u?.completionTokens, 2);
  assert.equal(u?.cachedTokens, 1);
});

test("egress proxy: upstream socket destroyed mid-stream terminates the client response", async () => {
  const up = await fakeUpstream((_q, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    setTimeout(() => res.socket?.destroy(), 20);
  });
  const proxy = await startEgressProxy({ upstreamBase: up.url });
  try {
    const outcome = await Promise.race([
      fetch(`${proxy.url}/chat/completions`, { method: "POST", body: "{}" })
        .then((r) => r.text())
        .then(() => "ended", () => "errored"),
      new Promise<string>((r) => setTimeout(() => r("hung"), 3000)),
    ]);
    assert.notEqual(outcome, "hung");
  } finally {
    await proxy.close();
    await up.close();
  }
});
