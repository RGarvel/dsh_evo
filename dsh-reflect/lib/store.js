/**
 * Pure file-level memory store for dsh-reflect. No dsh imports — unit-testable
 * in isolation; lib/index.js wires these onto cordis tools + the system-prompt
 * assembly seam.
 *
 * On-disk format: a markdown file, one lesson per `- ` line. Trailing `#tag`
 * tokens on a line are parsed as tags. Everything else (headers, comments) is
 * preserved verbatim by rewrite() only in its own rendering — see formatFile.
 *
 * @module @garvel/dsh-reflect/store
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FILE_HEADER = "# dsh-reflect memory\n<!-- managed by @garvel/dsh-reflect; one lesson per '- ' line, trailing #tags optional; never store secrets -->\n";

/** Normalize a lesson for dedup comparison. */
export function normalize(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, " ");
}

/** Parse one `- text #a #b` line into {text, tags}. Non-lesson lines → null. */
export function parseLine(line) {
  const m = /^-\s+(.*)$/.exec(line.trim());
  if (!m) return null;
  const body = m[1];
  const tags = [];
  const text = body
    .replace(/(?:\s+#[\w\u4e00-\u9fff.-]+)+\s*$/g, (tail) => {
      for (const t of tail.trim().split(/\s+/)) tags.push(t.slice(1));
      return "";
    })
    .trim();
  if (!text) return null;
  return { text, tags };
}

/** Parse a memory file into lesson entries (headers/comments ignored). */
export function parseFile(content) {
  const entries = [];
  for (const line of String(content).split(/\r?\n/)) {
    const e = parseLine(line);
    if (e) entries.push(e);
  }
  return entries;
}

/** Render entries back to the canonical file format. */
export function formatFile(entries) {
  const lines = entries.map((e) => {
    const tagPart = e.tags && e.tags.length ? " " + e.tags.map((t) => `#${t}`) .join(" ") : "";
    return `- ${e.text}${tagPart}`;
  });
  return FILE_HEADER + (lines.length ? lines.join("\n") + "\n" : "");
}

/** Read a memory file; missing file yields []. */
export function readEntries(file) {
  if (!existsSync(file)) return [];
  return parseFile(readFileSync(file, "utf8"));
}

/**
 * Append one lesson unless a normalized-duplicate already exists.
 * @returns {{stored: boolean, reason?: string, count: number}}
 */
export function recordEntry(file, text, tags = []) {
  const clean = String(text).trim().replace(/\s*\n\s*/g, " ");
  if (!clean) return { stored: false, reason: "empty", count: readEntries(file).length };
  const entries = readEntries(file);
  const dup = entries.find((e) => normalize(e.text) === normalize(clean));
  if (dup) return { stored: false, reason: "duplicate", count: entries.length };
  entries.push({ text: clean, tags: tags.map((t) => String(t).trim()).filter(Boolean) });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, formatFile(entries), "utf8");
  return { stored: true, count: entries.length };
}

/**
 * Replace the whole entry list of one file, backing up the previous copy.
 * @returns {{count: number, backup?: string}}
 */
export function rewriteEntries(file, entries) {
  let backup;
  if (existsSync(file)) {
    backup = file + ".bak-" + new Date().toISOString().replace(/[:.]/g, "");
    copyFileSync(file, backup);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, formatFile(entries), "utf8");
  return { count: entries.length, ...(backup ? { backup } : {}) };
}

/**
 * Render the injection section text. Truncates per-line so the total stays
 * within maxChars (dropped lines counted in the footer).
 */
export function renderInjection(globalEntries, workspaceEntries, { maxChars = 1800 } = {}) {
  const lines = ["## Persistent Memory (dsh-reflect)", ""];
  const pushGroup = (title, entries) => {
    if (!entries.length) return;
    lines.push(title + ":");
    for (const e of entries) lines.push(`- ${e.text}${e.tags?.length ? " " + e.tags.map((t) => `#${t}`).join(" ") : ""}`);
    lines.push("");
  };
  pushGroup("Global lessons", globalEntries);
  pushGroup("Workspace lessons", workspaceEntries);
  lines.push("These are durable notes captured by past sessions. Follow them unless they conflict with explicit current instructions. When you establish a new durable lesson (a decision, a pitfall, a verified command, a user preference), call reflect_record. When the list grows stale or noisy, consolidate it with reflect_consolidate (rewrite the full list; the old file is backed up). Never record secrets or credentials.");
  let out = lines.join("\n");
  if (out.length > maxChars) {
    const keep = lines.slice(0, Math.max(2, lines.length - 40));
    out = keep.join("\n").slice(0, maxChars - 40) + "\n…(memory truncated; call reflect_recall for the full list)";
  }
  return out;
}

/** Default memory file locations. */
export function defaultPaths(homeDir, workspaceDir, workspaceFileName = join(".dsh", "memory.md")) {
  return {
    global: join(homeDir, ".dsh", "reflect", "memory.md"),
    workspace: workspaceDir ? join(workspaceDir, workspaceFileName) : undefined,
  };
}
