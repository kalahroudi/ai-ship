// @ts-nocheck
// Minimal OpenAI-compatible chat-completions server (streaming + non-streaming) for contract tests.
import http from "node:http";

/** @param {string | ((lastUserText: string) => string)} [replyArg] */
export function startFakeOpenAI(replyArg = "Hello from fake model.\nVERDICT: CLEAN") {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
      return;
    }
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch {}
    const lastUser = [...(parsed.messages || [])].reverse().find((m) => m.role === "user");
    const lastText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
    const reply = typeof replyArg === "function" ? replyArg(lastText) : replyArg;
    const usage = { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 };
    const model = parsed.model || "fake-model";
    const created = Math.floor(Date.now() / 1000);
    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created, model };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) });
    });
  });
}
