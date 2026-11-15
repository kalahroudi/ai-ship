import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listNotyCategoryTasks, notyOrderKey, parseNotyCategoryAddress, writeNotyResult } from "../src/noty.ts";

test("parseNotyCategoryAddress: valid, trailing slash, url-encoded", () => {
  assert.equal(parseNotyCategoryAddress("noty://category/Projects/ai-ship"), "Projects/ai-ship");
  assert.equal(parseNotyCategoryAddress("  noty://category/Projects/ai-ship/ "), "Projects/ai-ship");
  assert.equal(parseNotyCategoryAddress("noty://category/My%20Proj/a%2Fb"), "My Proj/a/b");
  assert.equal(parseNotyCategoryAddress("noty://item/abc"), null);
});

test("parseNotyCategoryAddress rejects traversal, empty segments, absolute", () => {
  for (const bad of [
    "noty://category/..",
    "noty://category/a/../b",
    "noty://category/a/%2e%2e/b".replace("%2e%2e", ".."),
    "noty://category/a//b",
    "noty://category/%2Fetc",
    "noty://category/a%2F..%2Fb",
    "noty://category/",
  ]) assert.equal(parseNotyCategoryAddress(bad), null, bad);
});

test("notyOrderKey", () => {
  assert.deepEqual(notyOrderKey(["x", "order-05"]), [5]);
  assert.deepEqual(notyOrderKey(["order-05-1"]), [5, 1]);
  assert.deepEqual(notyOrderKey(["ORDER-2"]), [2]);
  assert.deepEqual(notyOrderKey(["order-x", "foo"]), [Infinity]);
  assert.deepEqual(notyOrderKey(undefined), [Infinity]);
});

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "noty-cat-"));
  const dir = path.join(root, "Projects", "ai-ship");
  fs.mkdirSync(dir, { recursive: true });
  const put = (name: string, fm: Record<string, string>, body = "body", sub = dir) => {
    const head = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
    fs.writeFileSync(path.join(sub, name), `---\n${head}\n---\n${body}\n`);
  };
  return { root, dir, put };
}

test("listNotyCategoryTasks: ordering, filtering, non-recursive", () => {
  const { root, dir, put } = store();
  try {
    put("a.md", { id: "untagged", kind: "task", title: "U" });
    put("b.md", { id: "o10", kind: "task", title: "T10", tags: '["order-10"]' });
    put("c.md", { id: "o2", kind: "task", title: "T2", tags: '["order-02"]' });
    put("d.md", { id: "o2-1", kind: "task", title: "T2-1", tags: '["order-02-1"]' });
    put("e.md", { id: "o2-10", kind: "task", title: "T2-10", tags: '["order-02-10"]' });
    put("f.md", { id: "done", kind: "task", title: "D", done: "true", tags: '["order-01"]' });
    put("g.md", { id: "note", kind: "note", title: "N", tags: '["order-01"]' });
    put("h.md", { id: "def", kind: "task", title: "H", tags: '["deferred","order-01"]' });
    put("i.md", { id: "skp", kind: "task", title: "I", tags: '["order-01","skip"]' });
    put("j.md", { kind: "task", title: "no id" });
    fs.mkdirSync(path.join(dir, "sub"));
    put("k.md", { id: "nested", kind: "task", title: "K", tags: '["order-00"]' }, "b", path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "readme.txt"), "x");

    const ids = listNotyCategoryTasks("Projects/ai-ship", { customDir: root }).map((n) => n.id);
    assert.deepEqual(ids, ["o2", "o2-1", "o2-10", "o10", "untagged"]);

    const only = listNotyCategoryTasks("Projects/ai-ship", { customDir: root, onlyTag: "order-10" });
    assert.deepEqual(only.map((n) => n.id), ["o10"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("listNotyCategoryTasks throws when category missing or escapes the store", () => {
  const { root } = store();
  try {
    assert.throws(() => listNotyCategoryTasks("Nope", { customDir: root }), /not found/);
    assert.throws(() => listNotyCategoryTasks("..", { customDir: root }), /not found/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("writeNotyResult: ok appends section, sets done, preserves frontmatter", () => {
  const { root, dir, put } = store();
  try {
    put("a.md", { id: "X1", kind: "task", title: "T", tags: '["order-01"]' }, "do it");
    const fp = path.join(dir, "a.md");
    writeNotyResult({ id: "x1", filePath: fp }, { ok: true, summary: "committed abc", now: new Date("2026-01-02T03:04:05Z") });
    const out = fs.readFileSync(fp, "utf8");
    // done: true is added inside the frontmatter block (appended to it when absent).
    assert.match(out, /^---\n[^]*\ndone: true\n---\n/);
    for (const l of ["id: X1", "kind: task", "title: T", 'tags: ["order-01"]']) assert.ok(out.includes(l), l);
    assert.match(out, /do it\n\n## ai-ship result \(2026-01-02 03:04\)\n\n✅ committed abc\n$/);
    assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("writeNotyResult: ok replaces existing done: false; failure leaves done untouched", () => {
  const { root, dir, put } = store();
  try {
    put("a.md", { id: "A", kind: "task", done: "false" });
    put("b.md", { id: "B", kind: "task", done: "false" });
    writeNotyResult({ id: "A", filePath: path.join(dir, "a.md") }, { ok: true, summary: "s" });
    assert.match(fs.readFileSync(path.join(dir, "a.md"), "utf8"), /^done: true$/m);
    writeNotyResult({ id: "B", filePath: path.join(dir, "b.md") }, { ok: false, summary: "failed: x" });
    const b = fs.readFileSync(path.join(dir, "b.md"), "utf8");
    assert.match(b, /^done: false$/m);
    assert.match(b, /❌ failed: x/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("writeNotyResult refuses when id mismatched and leaves file untouched", () => {
  const { root, dir, put } = store();
  try {
    put("a.md", { id: "REAL", kind: "task" });
    const fp = path.join(dir, "a.md");
    const before = fs.readFileSync(fp, "utf8");
    assert.throws(() => writeNotyResult({ id: "OTHER", filePath: fp }, { ok: true, summary: "s" }), /no longer has id/);
    assert.equal(fs.readFileSync(fp, "utf8"), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("writeNotyResult: edits only frontmatter, keeps CRLF, no key swallowing", () => {
  const { root, dir } = store();
  try {
    const fp = path.join(dir, "c.md");
    fs.writeFileSync(fp, "---\r\nid: C\r\ndone:\r\ntitle: Keep\r\n---\r\ndone: body line\r\n");
    writeNotyResult({ id: "C", filePath: fp }, { ok: true, summary: "ok" });
    const out = fs.readFileSync(fp, "utf8");
    assert.ok(out.includes("done: true\r\ntitle: Keep\r\n---"), out);
    assert.ok(out.includes("\r\ndone: body line\r\n"), "body untouched");
    assert.ok(!/[^\r]\n/.test(out), "CRLF only");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("parseNotyCategoryAddress returns null on a malformed escape", () => {
  assert.equal(parseNotyCategoryAddress("noty://category/100%"), null);
});
