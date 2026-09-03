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
import { keyOf, loadMeta, markSuperseded, metaPathFor, reconcile, saveMeta } from "./meta.js";

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
  syncMeta(file);
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
  syncMeta(file);
  return { count: entries.length, ...(backup ? { backup } : {}) };
}

/** Sync the sibling sidecar after any body write; never allowed to throw. */
function syncMeta(file) {
  try {
    reconcile(loadMeta(metaPathFor(file)), readEntries(file), metaPathFor(file));
  } catch {
    /* sidecar must never break the body write */
  }
}

/**
 * Replace one lesson at a 1-based index (merge in a distilled improvement).
 * Out-of-range or empty text is refused and reported, never guessed.
 * @returns {{ok: boolean, reason?: string, count: number}}
 */
export function mergeEntry(file, idx, text, tags = []) {
  const entries = readEntries(file);
  if (!Number.isInteger(idx) || idx < 1 || idx > entries.length) {
    return { ok: false, reason: "out-of-range", count: entries.length };
  }
  const clean = String(text).trim().replace(/\s*\n\s*/g, " ");
  if (!clean) return { ok: false, reason: "empty", count: entries.length };
  entries[idx - 1] = { text: clean, tags: tags.map((t) => String(t).trim()).filter(Boolean) };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, formatFile(entries), "utf8");
  syncMeta(file);
  return { ok: true, count: entries.length };
}

/**
 * Remove one lesson at a 1-based index (a distilled drop).
 * Soft-deletion (super-session) is step 4; this is the hard-removal primitive.
 * @returns {{ok: boolean, reason?: string, count: number}}
 */
export function removeEntry(file, idx) {
  const entries = readEntries(file);
  if (!Number.isInteger(idx) || idx < 1 || idx > entries.length) {
    return { ok: false, reason: "out-of-range", count: entries.length };
  }
  entries.splice(idx - 1, 1);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, formatFile(entries), "utf8");
  syncMeta(file);
  return { ok: true, count: entries.length };
}

/**
 * Soft-supersede (step 4): append a new lesson AND mark the lesson at `oldIdx`
 * (1-based) as superseded by it. The old entry is NOT deleted — its sidecar row
 * gets `supersededBy`, so it stops injecting while staying recoverable.
 * @returns recordEntry's result plus `superseded` (the old 1-based idx) on success.
 */
export function supersedeEntry(file, oldIdx, text, tags = []) {
  const before = readEntries(file);
  if (!Number.isInteger(oldIdx) || oldIdx < 1 || oldIdx > before.length) {
    return { stored: false, reason: "out-of-range", count: before.length };
  }
  const rec = recordEntry(file, text, tags);
  if (!rec.stored) return rec;
  try {
    const after = readEntries(file);
    const metaFile = metaPathFor(file);
    const meta = reconcile(loadMeta(metaFile), after);
    markSuperseded(meta, keyOf(after[oldIdx - 1].text), keyOf(text));
    saveMeta(metaFile, meta);
  } catch {
    /* supersede accounting must never break the approve */
  }
  return { ...rec, superseded: oldIdx };
}

/** The harness's own density heuristic (see dsh-token-meter: `ceil(len/4)`). */
export const CHARS_PER_TOKEN = 4;

const INJECTION_RULES =
  'These are durable notes captured by past sessions. Follow them unless they conflict with explicit current instructions. When you establish a new durable lesson (a decision, a pitfall, a verified command, a user preference), call reflect_record. A lesson you are unsure about goes to reflect_pending(action:"queue") — it stays out of the prompt until a human approves it. When the list grows stale or noisy, consolidate it with reflect_consolidate (rewrite the full list; the old file is backed up). Never record secrets or credentials.';

/**
 * Render the injection section text.
 *
 * Budget is in TOKENS, converted with the divisor the harness itself uses:
 * `dsh-token-meter` prices a system prompt as `ceil(length / CHARS_PER_TOKEN) + 4`
 * (`estimateSystemTokens`). Inventing a cleverer count would only make our budget
 * disagree with what the loop actually charges, so 4 chars/token IS the contract.
 * `maxChars` remains a direct override and wins when set.
 *
 * Trimming drops whole rows from the tail and says how many fell off, rather than
 * silently clipping prose. `pendingCount` contributes a COUNT-ONLY hint: queue
 * contents must never reach the prompt, which is the whole point of the gate.
 */
export function renderInjection(globalEntries, workspaceEntries, { maxChars = 0, maxTokens = 600, pendingCount = 0, rank } = {}) {
  const budget = maxChars > 0 ? maxChars : Math.max(1, maxTokens) * CHARS_PER_TOKEN;
  // Workspace lessons come FIRST in the ordered list so they survive tail-trim
  // when budget is tight — they are more immediately relevant to the current
  // session's work. Global lessons append after and are the ones dropped first
  // when the cap is hit.
  const lessons = [
    ...workspaceEntries.map((e) => ({ group: "Workspace lessons", e })),
    ...globalEntries.map((e) => ({ group: "Global lessons", e })),
  ];
  // Step 5: an optional rank reorders WITHIN each group so hot lessons survive a
  // token-budget tail-trim. Omitting rank keeps the exact current order (the
  // zero-behavior-change promise), and an all-zeros cold start is a stable no-op.
  if (typeof rank === "function") {
    const score = (e) => {
      try {
        const s = Number(rank(e));
        return Number.isFinite(s) ? s : 0;
      } catch {
        return 0;
      }
    };
    const byGroup = (group) => lessons.filter((l) => l.group === group).sort((a, b) => score(b.e) - score(a.e));
    const ws = byGroup("Workspace lessons");
    const gl = byGroup("Global lessons");
    lessons.length = 0;
    lessons.push(...ws, ...gl);
  }
  const body = (keep) => {
    const out = [];
    let current = null;
    for (const { group, e } of lessons.slice(0, keep)) {
      if (group !== current) {
        if (current !== null) out.push("");
        out.push(`${group}:`);
        current = group;
      }
      out.push(`- ${e.text}${e.tags?.length ? " " + e.tags.map((t) => `#${t}`).join(" ") : ""}`);
    }
    if (current !== null) out.push("");
    return out;
  };
  const tail = [];
  if (pendingCount > 0) {
    tail.push(`${pendingCount} 条候选在复核队列里，未批准即不注入：\`reflect_pending(action:"list")\` 或 \`/reflect-review\`。`);
  }
  tail.push(INJECTION_RULES);

  let keep = lessons.length;
  let out;
  for (;;) {
    const dropped = lessons.length - keep;
    const note = dropped > 0 ? [`…(还有 ${dropped} 条未注入，用 reflect_recall 取全表)`, ""] : [];
    out = ["## Persistent Memory (dsh-reflect)", "", ...body(keep), ...note, ...tail].join("\n");
    if (out.length <= budget || keep === 0) break;
    keep--;
  }
  if (out.length > budget) out = out.slice(0, Math.max(0, budget - 1)) + "…";
  return out;
}

/** Default memory file locations. */
export function defaultPaths(homeDir, workspaceDir, workspaceFileName = join(".dsh", "memory.md")) {
  return {
    global: join(homeDir, ".dsh", "reflect", "memory.md"),
    workspace: workspaceDir ? join(workspaceDir, workspaceFileName) : undefined,
  };
}
