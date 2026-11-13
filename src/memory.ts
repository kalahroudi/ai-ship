import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_LINES = 120;

/** Returns the persistent per-repo memory file path outside the git working tree. */
export function getMemoryPath(repoDir: string): string {
  const baseDir = process.env.OPENCODE_MEMORY_DIR || path.join(os.homedir(), ".local", "share", "opencode", "memory");
  const resolved = path.resolve(repoDir);
  const name = path.basename(resolved).toLowerCase().replace(/[^a-z0-9-_]+/g, "-") || "repo";
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return path.join(baseDir, `${name}-${hash}.md`);
}

/** Reads the repo's memory file, truncated to `maxLines` so prompt context stays lean. */
export function readMemory(repoDir: string, maxLines = DEFAULT_MAX_LINES): string {
  const memPath = getMemoryPath(repoDir);
  if (!fs.existsSync(memPath)) return "";
  const raw = fs.readFileSync(memPath, "utf8").trim();
  if (!raw) return "";
  const lines = raw.split("\n");
  return lines.slice(0, maxLines).join("\n");
}

/** Appends a concise, deduplicated memory bullet for a repository. */
export function appendMemory(repoDir: string, entry: string, category = "note"): { path: string; added: boolean } {
  const memPath = getMemoryPath(repoDir);
  fs.mkdirSync(path.dirname(memPath), { recursive: true });

  const cleanEntry = entry.replace(/\s+/g, " ").trim();
  if (!cleanEntry) return { path: memPath, added: false };

  const existing = fs.existsSync(memPath) ? fs.readFileSync(memPath, "utf8") : "";
  const normalizedExisting = existing.toLowerCase();
  if (normalizedExisting.includes(cleanEntry.toLowerCase())) {
    return { path: memPath, added: false };
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const bullet = `- [${category}] (${stamp}) ${cleanEntry}`;
  const header = existing.trim() ? existing.trimEnd() + "\n" : `# Repo Memory (${path.basename(path.resolve(repoDir))})\n\n`;
  fs.writeFileSync(memPath, `${header}${bullet}\n`, "utf8");
  return { path: memPath, added: true };
}

/** Removes any memory bullet lines matching `query` (case-insensitive substring). */
export function forgetMemory(repoDir: string, query: string): { path: string; removedCount: number } {
  const memPath = getMemoryPath(repoDir);
  if (!fs.existsSync(memPath)) return { path: memPath, removedCount: 0 };

  const needle = query.trim().toLowerCase();
  if (!needle) return { path: memPath, removedCount: 0 };

  const lines = fs.readFileSync(memPath, "utf8").split("\n");
  const kept: string[] = [];
  let removedCount = 0;
  for (const line of lines) {
    if (line.startsWith("- ") && line.toLowerCase().includes(needle)) {
      removedCount++;
      continue;
    }
    kept.push(line);
  }

  if (removedCount > 0) {
    fs.writeFileSync(memPath, kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n", "utf8");
  }
  return { path: memPath, removedCount };
}

/** Overwrites the repo's memory file with consolidated content from a dream pass. */
export function writeConsolidatedMemory(repoDir: string, content: string): string {
  const memPath = getMemoryPath(repoDir);
  fs.mkdirSync(path.dirname(memPath), { recursive: true });
  const normalized = content.trim();
  fs.writeFileSync(memPath, normalized ? `${normalized}\n` : "", "utf8");
  return memPath;
}

/** Builds the offline "dream" consolidation prompt from current memory and recent session transcripts. */
export function buildDreamPrompt(repoName: string, currentMemory: string, transcriptsText: string): string {
  return [
    `You are performing offline memory consolidation ("dreaming") for repository "${repoName}".`,
    "",
    "Review the current memory store alongside recent session transcripts and output a clean, consolidated markdown memory file.",
    "Rules:",
    "1. Merge duplicate or overlapping entries into a single crisp bullet.",
    "2. Remove stale, temporary, or contradicted notes (cross-check against what actually succeeded/failed in the transcripts).",
    "3. Keep only durable, high-signal operational knowledge: architecture invariants, test/build quirks, security rules, and recurring pitfalls.",
    "4. Keep the output concise (under 100 lines), formatted as:",
    `   # Repo Memory (${repoName})`,
    "   - [category] (YYYY-MM-DD) concise rule or fact",
    "5. Output ONLY the markdown memory file contents, with no surrounding code fences or commentary.",
    "",
    "## Current Memory",
    currentMemory.trim() || "(empty)",
    "",
    "## Recent Session Transcripts",
    transcriptsText.trim() || "(no recent transcripts)",
  ].join("\n");
}
