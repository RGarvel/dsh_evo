/**
 * The review queue: candidates that are NOT allowed to influence any prompt
 * until a human says so.
 *
 * This is the safety spine of the automatic loop. A distilled lesson first lands
 * here (with a provenance pointer back to the session/seq it came from), and only
 * an explicit `approve` promotes it into `memory.md`, which is what actually gets
 * injected. Rejected/dropped lines stay recoverable because every rewrite backs
 * the previous queue up next to itself.
 *
 * A queue file is always paired with exactly one memory file (global pending →
 * global memory, workspace pending → that workspace's memory), so an entry needs
 * no scope field of its own — the file it sits in decides where it lands.
 *
 * On-disk line format (ours, not store.js's):
 *   `- <text> @src:<provenance> #tag #tag`
 * with the `@src:` token optional. Tags stay trailing so they remain strip-able.
 *
 * @module @garvel/dsh-reflect/pending
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalize } from "./store.js";

export const PENDING_HEADER =
  "# dsh-reflect pending\n<!-- candidates awaiting review; approve moves a line into memory.md, which is what gets injected -->\n";

/** Parse one queue line; headers/comments and plain `- ` memory lines → null. */
export function parsePendingLine(line) {
  const m = /^-\s+(.*)$/.exec(String(line).trim());
  if (!m) return null;
  let body = m[1];
  const tags = [];
  body = body.replace(/((?:\s+#[\w一-鿿.-]+)+)\s*$/g, (tail) => {
    for (const t of tail.trim().split(/\s+/)) tags.push(t.slice(1));
    return "";
  });
  let source = "";
  body = body.replace(/\s+@src:(\S+)\s*$/g, (_all, src) => {
    source = src;
    return "";
  });
  const text = body.trim();
  if (!text) return null;
  return { text, tags, ...(source ? { source } : {}) };
}

export function parsePending(content) {
  const entries = [];
  for (const line of String(content).split(/\r?\n/)) {
    const e = parsePendingLine(line);
    if (e) entries.push(e);
  }
  return entries;
}

export function formatPendingLine(entry) {
  const src = entry.source ? ` @src:${entry.source}` : "";
  const tagPart = entry.tags && entry.tags.length ? " " + entry.tags.map((t) => `#${t}`).join(" ") : "";
  return `- ${entry.text}${src}${tagPart}`;
}

export function formatPending(entries) {
  return PENDING_HEADER + (entries.length ? entries.map(formatPendingLine).join("\n") + "\n" : "");
}

/** Read the queue; a missing file is an empty queue. */
export function readPending(file) {
  if (!existsSync(file)) return [];
  return parsePending(readFileSync(file, "utf8"));
}

/** Replace the whole queue, backing the previous copy up beside itself. */
export function rewritePending(file, entries) {
  let backup;
  if (existsSync(file)) {
    backup = file + ".bak-" + new Date().toISOString().replace(/[:.]/g, "");
    copyFileSync(file, backup);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, formatPending(entries), "utf8");
  return { count: entries.length, ...(backup ? { backup } : {}) };
}

/**
 * Append one candidate unless it duplicates the queue or the already-approved list.
 *
 * @param file - queue file.
 * @param entry - `{text, tags?, source?}` (text must already be screened).
 * @param against - approved entries to dedupe against (pass `readPending` + the
 *   target memory entries; deduping here is what stops the queue refilling with
 *   lessons the model already has).
 */
export function queuePending(file, entry, against = []) {
  const clean = String(entry.text ?? "").trim().replace(/\s*\n\s*/g, " ");
  const queued = readPending(file);
  if (!clean) return { stored: false, reason: "empty", count: queued.length };
  const dupes = [...queued, ...against];
  if (dupes.some((e) => normalize(e.text) === normalize(clean))) {
    return { stored: false, reason: "duplicate", count: queued.length };
  }
  queued.push({ text: clean, tags: (entry.tags || []).map((t) => String(t).trim()).filter(Boolean), ...(entry.source ? { source: entry.source } : {}) });
  rewritePending(file, queued);
  return { stored: true, count: queued.length };
}

/** Human/model-readable one-line form, indexed from 1 as `approve`/`drop` expect. */
export function pendingPreview(entry, index) {
  const tagPart = entry.tags?.length ? " " + entry.tags.map((t) => `#${t}`).join(" ") : "";
  return `#${index} ${entry.text}${tagPart}${entry.source ? ` (src ${entry.source})` : ""}`;
}

/**
 * Resolve the queue: promote accepted lines into `targetFile`, discard the rest
 * of the touched indexes, and rewrite what remains.
 *
 * Out-of-range indexes are reported, never guessed at. `accept`/`drop` are
 * 1-based, as shown by `pendingPreview`.
 *
 * @param file - queue file.
 * @param targetFile - memory file an accepted line is recorded into.
 * @param accept - indexes to promote.
 * @param drop - indexes to discard.
 * @param record - `(file, text, tags) => result` (store.recordEntry, injected to
 *   keep this module free of the write layer it does not own).
 */
export function resolvePending(file, targetFile, accept = [], drop = [], record) {
  const queued = readPending(file);
  const wanted = (list) => (Array.isArray(list) ? list : []).map(Number).filter(Number.isInteger);
  const accepts = wanted(accept);
  const drops = wanted(drop).filter((i) => !accepts.includes(i));
  const seen = new Set();
  const moved = [];
  const discarded = [];
  const invalid = [...accepts, ...drops].filter((i) => i < 1 || i > queued.length);

  queued.forEach((entry, i) => {
    const index = i + 1;
    if (accepts.includes(index)) {
      const res = record(targetFile, entry.text, entry.tags || []);
      moved.push({ index, text: entry.text, ...(entry.source ? { source: entry.source } : {}), ...res });
      seen.add(index);
    } else if (drops.includes(index)) {
      discarded.push({ index, text: entry.text });
      seen.add(index);
    }
  });

  const remaining = queued.filter((_e, i) => !seen.has(i + 1));
  const rewritten = remaining.length === queued.length ? { count: queued.length } : rewritePending(file, remaining);
  return {
    moved,
    discarded,
    invalid,
    count: rewritten.count,
    ...(rewritten.backup ? { backup: rewritten.backup } : {}),
  };
}
