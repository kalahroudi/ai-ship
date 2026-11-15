import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface NotyNote {
  id: string;
  title: string;
  body: string;
  filePath: string;
  task: string;
  kind?: string;
  done?: boolean;
  tags?: string[];
}

export function parseNotyAddress(input: string): string | null {
  const match = input.trim().match(/^noty:\/\/item\/([0-9a-zA-Z-]+)\/?$/i);
  return match ? match[1] : null;
}

export function resolveNotySearchDirs(customDir?: string): string[] {
  const home = os.homedir();
  const candidates = customDir
    ? [customDir]
    : [
        process.env.NOTY_DIR,
        path.join(home, "noty-data", "Noty"),
        path.join(home, "noty-data"),
        path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Noty"),
      ].filter((d): d is string => Boolean(d));

  const seen = new Set<string>();
  const existing: string[] = [];
  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      existing.push(resolved);
    }
  }
  return existing;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseNotyMarkdown(content: string): {
  id?: string;
  title?: string;
  body: string;
  kind?: string;
  done?: boolean;
  tags?: string[];
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { body: content.trim() };
  }

  const frontmatter = match[1];
  const body = match[2].trim();
  let id: string | undefined;
  let title: string | undefined;
  let kind: string | undefined;
  let done: boolean | undefined;
  let tags: string[] | undefined;

  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    if (key === "id") id = unquote(rawVal);
    if (key === "title") title = unquote(rawVal);
    if (key === "kind") kind = unquote(rawVal);
    if (key === "done") done = rawVal.trim() === "true";
    if (key === "tags") {
      try {
        const v = JSON.parse(rawVal) as unknown;
        if (Array.isArray(v)) tags = v.filter((t): t is string => typeof t === "string");
      } catch {
        // non-JSON tag list: ignore
      }
    }
  }

  return { id, title, body, ...(kind ? { kind } : {}), ...(done !== undefined ? { done } : {}), ...(tags ? { tags } : {}) };
}

function walkMarkdownFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function formatTask(title: string, body: string): string {
  if (title && body) return `${title}\n\n${body}`;
  return body || title;
}

function tryReadMatchingNote(filePath: string, targetIdLower: string): NotyNote | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = parseNotyMarkdown(raw);
    if (!parsed.id || parsed.id.toLowerCase() !== targetIdLower) return null;
    const title = parsed.title ?? "";
    const task = formatTask(title, parsed.body);
    if (!task) return null;
    return {
      id: parsed.id,
      title,
      body: parsed.body,
      filePath,
      task,
    };
  } catch {
    return null;
  }
}

export function resolveNotyTask(addressOrId: string, customDir?: string): NotyNote {
  const id = parseNotyAddress(addressOrId) ?? addressOrId.trim();
  const targetIdLower = id.toLowerCase();
  const searchDirs = resolveNotySearchDirs(customDir);

  for (const dir of searchDirs) {
    const files = walkMarkdownFiles(dir);
    for (const filePath of files) {
      const note = tryReadMatchingNote(filePath, targetIdLower);
      if (note) return note;
    }
  }

  if (!customDir && process.platform === "darwin") {
    const res = spawnSync("mdfind", [id], { encoding: "utf8" });
    if (res.status === 0) {
      const candidates = res.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((p) => p.endsWith(".md"));
      for (const filePath of candidates) {
        const note = tryReadMatchingNote(filePath, targetIdLower);
        if (note) return note;
      }
    }
  }

  throw new Error(
    `Could not find Noty note for "${addressOrId}". ` +
      `Searched: ${searchDirs.length ? searchDirs.join(", ") : "(no Noty directories found)"}. ` +
      `Set NOTY_DIR or pass --noty-dir <dir> if your Noty markdown folder is elsewhere.`
  );
}

/** `noty://category/<path>` → `<path>` (e.g. "Projects/ai-ship"); null when not a category address. */
export function parseNotyCategoryAddress(input: string): string | null {
  const m = input.trim().match(/^noty:\/\/category\/(.+?)\/?$/i);
  if (!m) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(m[1]);
  } catch {
    return null; // malformed %-escape
  }
  // Stay inside the Noty store.
  if (rel.split("/").some((seg) => seg === ".." || seg === "") || path.isAbsolute(rel)) return null;
  return rel;
}

/** Sort key from an `order-NN[-M...]` tag (e.g. order-05-1 → [5, 1]); untagged notes sort last. */
export function notyOrderKey(tags: string[] | undefined): number[] {
  const t = (tags ?? []).find((x) => /^order-\d+(?:[-.]\d+)*$/i.test(x));
  return t ? t.slice(6).split(/[-.]/).map(Number) : [Number.POSITIVE_INFINITY];
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Open tasks directly inside a Noty category folder, in `order-NN` tag order (then file name). Skips notes
 * that are done, not `kind: task`, or tagged `deferred`/`skip`. Optional `onlyTag` keeps notes with that tag.
 */
export function listNotyCategoryTasks(category: string, opts: { customDir?: string; onlyTag?: string } = {}): NotyNote[] {
  for (const base of resolveNotySearchDirs(opts.customDir)) {
    const dir = path.resolve(base, category);
    if (!dir.startsWith(base + path.sep) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const notes: NotyNote[] = [];
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
      const filePath = path.join(dir, name);
      let parsed: ReturnType<typeof parseNotyMarkdown>;
      try {
        parsed = parseNotyMarkdown(fs.readFileSync(filePath, "utf8"));
      } catch {
        continue;
      }
      if (!parsed.id || parsed.kind !== "task" || parsed.done) continue;
      const tags = parsed.tags ?? [];
      if (tags.some((t) => t === "deferred" || t === "skip")) continue;
      if (opts.onlyTag && !tags.includes(opts.onlyTag)) continue;
      const title = parsed.title ?? "";
      const task = formatTask(title, parsed.body);
      if (!task) continue;
      notes.push({ id: parsed.id, title, body: parsed.body, filePath, task, kind: parsed.kind, done: false, tags });
    }
    return notes.sort((a, b) => compareKeys(notyOrderKey(a.tags), notyOrderKey(b.tags)));
  }
  throw new Error(`Noty category "${category}" not found (set NOTY_DIR or pass --noty-dir).`);
}

/**
 * Writes a pipeline result back into the Noty note (opt-in): appends an "ai-ship result" section and, when
 * the task committed, marks it `done: true`. Atomic (temp file + rename); refuses if the note's id changed.
 */
export function writeNotyResult(note: Pick<NotyNote, "id" | "filePath">, result: { ok: boolean; summary: string; now?: Date }): void {
  const raw = fs.readFileSync(note.filePath, "utf8");
  const parsed = parseNotyMarkdown(raw);
  if (!parsed.id || parsed.id.toLowerCase() !== note.id.toLowerCase()) {
    throw new Error(`Noty note ${note.filePath} no longer has id ${note.id}; not writing the result.`);
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  // Edit `done:` only inside the frontmatter block (never a body line), on a single line.
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fm) throw new Error(`Noty note ${note.filePath} has no frontmatter; not writing the result.`);
  let front = fm[1];
  if (result.ok) {
    front = /^done:[ \t]*.*$/m.test(front) ? front.replace(/^done:[ \t]*.*$/m, "done: true") : `${front}${eol}done: true`;
  }
  const body = raw.slice(fm[0].length);
  const stamp = (result.now ?? new Date()).toISOString().slice(0, 16).replace("T", " ");
  const summary = result.summary.replace(/\r/g, "").slice(0, 4000).split("\n").join(eol);
  let out = `---${eol}${front}${eol}---${eol}${body}`;
  out = `${out.replace(/\s*$/, "")}${eol}${eol}## ai-ship result (${stamp})${eol}${eol}${result.ok ? "✅" : "❌"} ${summary}${eol}`;
  const tmp = `${note.filePath}.ai-ship-${process.pid}.tmp`;
  fs.writeFileSync(tmp, out, "utf8");
  fs.renameSync(tmp, note.filePath);
}
