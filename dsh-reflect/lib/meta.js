/**
 * Sidecar metadata store for dsh-reflect memory entries.
 *
 * The body (memory.md) is the single source of truth: auditable, diffable,
 * hand-editable. This module keeps machine-usable state (confidence, hit
 * counters, supersession edges) in a sibling `*.meta.json` that is ALWAYS
 * rebuildable from the body. Losing the sidecar only degrades back to v0
 * behavior — the body still has every lesson.
 *
 * Rebuild is via reconcile(): it walks the current body entries, keeps or
 * creates a meta row per entry key, and moves keys that vanished from the body
 * into a tombstone map so a later merge/consolidate can explain what replaced
 * what.
 *
 * This module is a pure leaf: it imports only node:fs / node:path, and nothing
 * from dsh or from store.js. store.js imports THIS module (one-way), so there
 * is no import cycle to deadlock a bundle-mounted plugin.
 *
 * @module @garvel/dsh-reflect/meta
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const META_VERSION = 1;

/** Sibling path for a memory body: "memory.md" -> "memory.meta.json". */
export function metaPathFor(memoryFile) {
  return String(memoryFile).replace(/\.md$/i, "") + ".meta.json";
}

/**
 * Entry key. MUST stay byte-for-byte identical to store.js `normalize` — the
 * dedup there guarantees a single body file has unique normalize()d texts,
 * which is exactly the invariant reconcile relies on as its row identity.
 */
export function keyOf(text) {
  return String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Default row for a freshly seen entry (never share this object). */
export function emptyRow() {
  return {
    confidence: "confirmed",
    firstHitAt: null,
    lastHitAt: null,
    hitCount: 0,
    supersedes: [],
    supersededBy: null,
    keywords: [],
  };
}

/** Parse a meta file; a missing file or corrupt JSON degrades to an empty meta. */
export function loadMeta(file) {
  const empty = () => ({ v: META_VERSION, entries: {}, tombstones: {} });
  if (!existsSync(file)) return empty();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") {
      return {
        v: META_VERSION,
        entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {},
        tombstones: parsed.tombstones && typeof parsed.tombstones === "object" ? parsed.tombstones : {},
      };
    }
  } catch {
    /* corrupt meta must never break a write; start fresh */
  }
  return empty();
}

export function saveMeta(file, meta) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ v: META_VERSION, entries: meta.entries || {}, tombstones: meta.tombstones || {} }, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Align the sidecar to the current body entries. Idempotent.
 *
 * - an entry still in the body keeps its row (existing counters are copied,
 *   never clobbered; a brand-new key starts from emptyRow());
 * - a row whose key is gone from the body moves to tombstones{key: {at}}.
 *
 * @param meta  - result of loadMeta() (owned; mutated copies are returned).
 * @param entries - body entries from store.readEntries().
 * @param metaFile - path to persist through saveMeta(); omit to only compute.
 * @returns the reconciled meta object.
 */
export function reconcile(meta, entries, metaFile) {
  const next = { v: META_VERSION, entries: {}, tombstones: { ...(meta.tombstones || {}) } };
  const seen = new Set();
  for (const e of entries) {
    const key = keyOf(e.text);
    if (!key || seen.has(key)) continue; // body is deduped; guard anyway
    seen.add(key);
    const prev = meta.entries?.[key];
    next.entries[key] = prev && typeof prev === "object" ? { ...prev } : emptyRow();
    delete next.tombstones[key]; // a resurrected key leaves the graveyard
  }
  for (const key of Object.keys(meta.entries || {})) {
    if (!seen.has(key)) {
      // Keep an existing tombstone's fields if present; otherwise a fresh one.
      next.tombstones[key] = meta.tombstones?.[key] || { replacedBy: null, at: new Date().toISOString() };
    }
  }
  if (metaFile) saveMeta(metaFile, next);
  return next;
}

/**
 * Record one hit for an entry (the model actively pulled it via reflect_recall).
 *
 * Deliberately NOT callable from the injection section: "being injected" is
 * exposure, not a hit — counting exposure would let hot lessons stay hot and
 * cold lessons never surface (self-amplification). Only a reflect_recall that
 * actually returns this entry should call touchHit.
 *
 * Mutates and returns the same meta for chaining; no-op when the key is absent.
 */
export function touchHit(meta, key, now = new Date().toISOString()) {
  const row = meta?.entries?.[key];
  if (!row) return meta;
  row.hitCount = (Number(row.hitCount) || 0) + 1;
  if (!row.firstHitAt) row.firstHitAt = now;
  row.lastHitAt = now;
  return meta;
}

/**
 * Mark an existing lesson as superseded by a newer one (soft-delete).
 * The old entry stays in the body (auditable, recoverable) but stops injecting
 * because its row now carries `supersededBy`; the new entry records the reverse
 * edge in `supersedes`. No-op when either key is absent or they are equal.
 */
export function markSuperseded(meta, oldKey, newKey) {
  const oldRow = meta?.entries?.[oldKey];
  const newRow = meta?.entries?.[newKey];
  if (!oldRow || !newRow || oldKey === newKey) return meta;
  oldRow.supersededBy = newKey;
  if (!Array.isArray(newRow.supersedes)) newRow.supersedes = [];
  if (!newRow.supersedes.includes(oldKey)) newRow.supersedes.push(oldKey);
  return meta;
}

/** Keys that still inject — i.e. whose row is not soft-superseded. */
export function activeKeys(meta) {
  const out = new Set();
  for (const [key, row] of Object.entries(meta?.entries || {})) {
    if (!row || !row.supersededBy) out.add(key);
  }
  return out;
}