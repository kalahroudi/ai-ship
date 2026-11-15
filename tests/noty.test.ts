import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseNotyAddress, parseNotyMarkdown, resolveNotyTask } from "../src/noty.ts";

test("parseNotyAddress extracts item UUID from noty://item/ URIs", () => {
  assert.equal(
    parseNotyAddress("noty://item/11111111-2222-3333-4444-555555555555"),
    "11111111-2222-3333-4444-555555555555"
  );
  assert.equal(
    parseNotyAddress("  NOTY://item/ABCDEF12-3456-7890-ABCD-EF1234567890/ "),
    "ABCDEF12-3456-7890-ABCD-EF1234567890"
  );
  assert.equal(parseNotyAddress("Add rate limiting to login"), null);
});

test("parseNotyMarkdown parses YAML frontmatter id, title, and body", () => {
  const md = [
    "---",
    'id: "11111111-2222-3333-4444-555555555555"',
    'title: "Add healthcheck endpoint"',
    'kind: "task"',
    "---",
    "",
    "Return 200 OK on /healthz.",
  ].join("\n");

  assert.deepEqual(parseNotyMarkdown(md), {
    id: "11111111-2222-3333-4444-555555555555",
    title: "Add healthcheck endpoint",
    body: "Return 200 OK on /healthz.",
    kind: "task",
  });
});

test("resolveNotyTask finds matching markdown note in nested folders", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-noty-test-"));
  const subDir = path.join(dir, "Projects", "Demo");
  fs.mkdirSync(subDir, { recursive: true });

  fs.writeFileSync(
    path.join(subDir, "other-note.md"),
    '---\nid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"\ntitle: "Other"\n---\n\nIgnore me.\n'
  );
  const targetFile = path.join(subDir, "healthcheck-111111.md");
  fs.writeFileSync(
    targetFile,
    '---\nid: "11111111-2222-3333-4444-555555555555"\ntitle: "Add healthcheck"\n---\n\nReturn 200 OK.\n'
  );

  const note = resolveNotyTask("noty://item/11111111-2222-3333-4444-555555555555", dir);
  assert.equal(note.filePath, targetFile);
  assert.equal(note.title, "Add healthcheck");
  assert.equal(note.body, "Return 200 OK.");
  assert.equal(note.task, "Add healthcheck\n\nReturn 200 OK.");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveNotyTask throws clear error when note is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-noty-missing-"));
  assert.throws(
    () => resolveNotyTask("noty://item/00000000-0000-0000-0000-000000000000", dir),
    /Could not find Noty note/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
