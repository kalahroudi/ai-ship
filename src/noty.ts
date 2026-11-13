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

export function parseNotyMarkdown(content: string): { id?: string; title?: string; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { body: content.trim() };
  }

  const frontmatter = match[1];
  const body = match[2].trim();
  let id: string | undefined;
  let title: string | undefined;

  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    if (key === "id") id = unquote(rawVal);
    if (key === "title") title = unquote(rawVal);
  }

  return { id, title, body };
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
