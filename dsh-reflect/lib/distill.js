/**
 * Auto-distillation: turn/end → candidate lessons → pending.md.
 *
 * Called from the session/event listener; the call itself is fire-and-forget
 * with a 60 s timeout so a broken LLM call never stalls a turn.
 *
 * Design notes:
 *  - {global:true} session/event is verified live (events.jsonl probe, spike.8):
 *    the listener sees ALL sessions' events, not just the current one.
 *  - searchEvents is NOT available on this machine (SESSION_QUERY_SEARCH_DISABLED,
 *    no SQLite index in ~/.dsh). Selection uses listSessions + filterEvents instead.
 *  - Default: OFF. Toggle via DSH_REFLECT_AUTO_DISTILL=on env (kept behind an
 *    opt-in; no prod behaviour change without explicit consent).
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

// A turn/end boundary. listEvents returns SessionEventRecord ({sessionId,seq,type,
// time,surface}) which carries NO `data`, so we can only key on `type` here. That is
// safe: tryDistill is only ever entered from the listener after it verified the live
// event's data.reason.kind === "completed", so the current turn is completed and
// counting prior turn/end records as "completed turns" is a sound proxy.
function isTurnEnd(e) {
  return !!e && e.type === "turn/end";
}

const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes per session
const DISTILL_TIMEOUT_MS = 120_000; // reasoning models need >60s to finish thinking + emit text
// Verification tuning: dropped from 3 to 1 so the loop fires on the 2nd completed
// turn of a fresh session (a real release would want 3+). env-overridable.
const MIN_COMPLETED_TURNS = Number(process.env.REFLECT_MIN_TURNS || 1); // skip short sessions
const PROMPT = `You are a lessons-extraction assistant for a coding agent.
Given a recent conversation's user turns and assistant replies, extract durable,
actionable lessons suitable for future sessions.

RULES:
- Each lesson is ONE self-contained imperative line, 15–60 chars if possible.
- Prefer concrete decisions, pitfalls, command shapes, or verified workarounds.
- Never repeat what is already in the existing lessons below.
- Never encode secrets, keys, tokens, or credential-like strings.
- End each lesson with one or two #tags describing the domain.

EXISTING LESSONS (global + workspace):
${"_".repeat(60)}

CONVERSATION (user turns + assistant replies, newest last):
${"_".repeat(60)}

OUTPUT format — one JSON array of objects, nothing else:
[
  { "verdict": "new", "text": "<lesson>", "tags": ["tag1","tag2"] },
  { "verdict": "merge", "idx": 3, "text": "<improved version>" },
  { "verdict": "supersede", "idx": 5, "text": "<new lesson that replaces lesson #5>" },
  { "verdict": "drop", "idx": 7 }
]
For merge: idx is 0-based into the existing-lessons list (global first, then workspace).
For supersede: like merge, but the old lesson stays in the body (soft-retired: it stops injecting) while the new lesson is appended on top.
For drop: idx is 0-based into the existing-lessons list.
If you return only "new" items, the existing lessons are preserved unchanged.`;

// Per-session last-distill timestamp (in-memory, reset on restart).
const lastDistill = new Map();

// Spike diagnostic: log every gate the distill loop passes or bails on, so one
// restart tells us exactly why pending.md stayed empty. Strips before release.
const DEBUG_FILE = join(homedir(), ".dsh", "reflect", "distill-debug.log");
function dbg(msg) {
  try {
    writeFileSync(DEBUG_FILE, new Date().toISOString() + ` pid=${process?.pid ?? "?"} ` + msg + "\n", { flag: "a", encoding: "utf8" });
  } catch {
    /* diagnostics must never break distill */
  }
}

/**
 * Decide whether one session qualifies for a distillation pass.
 * `session` is the Session instance the `session/event` listener receives as its
 * subject (NOT an agent — dsh-agent-loop's own listener keys on `subject === session`).
 * Returns { sessionId, cwd } or null.
 */
function selectCandidate(event, session) {
  if (event.type !== "turn/end") return null;
  if (event.data?.reason?.kind !== "completed") return null;
  const sessionId = session?.id;
  if (!sessionId) return null;
  const now = Date.now();
  const last = lastDistill.get(sessionId) ?? 0;
  if (now - last < DEBOUNCE_MS) return null;
  // Need cwd to decide global vs workspace.
  const cwd = session.header?.cwd;
  if (!cwd) return null;
  // NOTE: the debounce timer is armed by the CALLER only once we commit to a
  // distillation pass — arming it here would let a turn that bails on the
  // completed-turn count silently block the very next (qualifying) turn.
  return { sessionId, cwd };
}

/**
 * Count completed turns since `sinceSeq` for one session.
 */
async function completedTurnCount(sessionQuery, sessionId, sinceSeq) {
  const events = await sessionQuery.listEvents(sessionId);
  if (!events.length) return 0;
  return events.filter(
    (e) => isTurnEnd(e) && (!sinceSeq || e.seq > sinceSeq),
  ).length;
}

/**
 * Fetch user/assistant message texts for a session (limited window).
 */
async function fetchTurnContent(sessionQuery, sessionId, sinceSeq, maxEvents = 200) {
  const docs = await sessionQuery.filterEvents(sessionId, [
    { kind: "type", values: ["user/message", "assistant/message"] },
  ]);
  const relevant = docs.filter((d) => !sinceSeq || d.seq > sinceSeq);
  // Keep last maxEvents to bound prompt size.
  const recent = relevant.slice(-maxEvents);
  return recent.map((d) => d.text).join("\n");
}

/**
 * Core distillation: sessionQuery + llm + pending.
 * Fire-and-forget; errors are caught and logged.
 */
export async function tryDistill(ctx, event, session) {
  try {
    const sessionQuery = ctx.get("sessionQuery");
    if (!sessionQuery) { dbg("bail: no sessionQuery service"); return; }

    // llm is read optionally (never injected — injecting it deadlocks this
    // bundle-mounted plugin in waiting). ctx.get resolves it at call time.
    const llm = ctx.get("llm");
    if (!llm) { dbg("bail: no llm service via ctx.get"); return; }

    const candidate = selectCandidate(event, session);
    if (!candidate) { dbg(`bail: not selected (seq=${event?.seq} type=${event?.type} reason=${event?.data?.reason?.kind} id=${session?.id} cwd=${session?.header?.cwd} inDebounce=${(Date.now() - (lastDistill.get(session?.id) ?? 0)) < DEBOUNCE_MS})`); return; }

    const { sessionId, cwd } = candidate;
    const isWorkspace = cwd !== undefined;
    const memoryFile = isWorkspace ? join(cwd, ".dsh", "memory.md") : null;
    const pendingFile = isWorkspace
      ? join(cwd, ".dsh", "memory-pending.md")
      : join(homedir(), ".dsh", "reflect", "pending.md");
    dbg(`selected session=${sessionId} cwd=${cwd} pendingFile=${pendingFile}`);

    // Check completed-turn count — skip short sessions.
    // We need the seq of the last completed turn before this one.
    const allEvents = await sessionQuery.listEvents(sessionId);
    const completedSince = allEvents
      .filter((e) => isTurnEnd(e))
      .filter((e) => e.seq < event.seq);
    if (completedSince.length < MIN_COMPLETED_TURNS) { dbg(`bail: completed turns before this = ${completedSince.length} < ${MIN_COMPLETED_TURNS}`); return; }
    const sinceSeq = completedSince[completedSince.length - 1].seq;
    // Committed to a distillation pass — arm the per-session debounce now, so a
    // turn that only bailed on the count (above) never suppresses the next one.
    lastDistill.set(sessionId, Date.now());

    // Fetch message content.
    const content = await fetchTurnContent(sessionQuery, sessionId, sinceSeq, 100);
    if (!content.trim()) { dbg("bail: empty content window"); return; }
    dbg(`content chars=${content.length}`);

    // Read existing lessons for the prompt.
    let existingLessons = "";
    if (memoryFile) {
      try {
        const { readEntries } = await import("./store.js");
        existingLessons = readEntries(memoryFile)
          .map((e) => e.text)
          .join("\n");
      } catch {
        /* file may not exist yet */
      }
    }

    // Resolve the LLM route from the Session's own folded request events.
    // `requestContext()` is the resolved provider+model; `requestHeader().config`
    // is the call config (also carries provider+model). Both are Session methods.
    let provider = null;
    let model = null;
    try {
      const rc = session.requestContext?.();
      if (rc?.provider && rc?.model) {
        provider = rc.provider;
        model = rc.model;
      }
    } catch {
      /* requestContext may be absent before the first request */
    }
    if (!provider || !model) {
      try {
        const header = session.requestHeader?.();
        if (header?.config?.provider) provider = header.config.provider;
        if (header?.config?.model) model = header.config.model;
      } catch {
        /* ignore */
      }
    }
    if (!provider || !model) { dbg(`bail: no LLM route (provider=${provider} model=${model})`); return; }
    dbg(`route provider=${provider} model=${model}`);

    // Assemble LLM call. One user message with three text blocks: a hand-built
    // one-shot must still carry id + source (Message contract), and consecutive
    // same-role turns can trip role-alternation on some providers.
    const messages = [
      createUserMessage({
        source: { kind: "user" },
        content: [
          { type: "text", text: PROMPT },
          { type: "text", text: `EXISTING LESSONS:\n${existingLessons || "(none)"}` },
          { type: "text", text: `CONVERSATION:\n${content}` },
        ],
      }),
    ];

    let signal;
    try {
      signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(DISTILL_TIMEOUT_MS) : undefined;
    } catch {
      signal = undefined;
    }
    dbg(`streaming: provider=${provider} model=${model} timeoutSignal=${signal ? "on" : "unavailable"}`);
    let response = "";
    let reasoning = "";
    // Diagnostic: what does the stream ACTUALLY yield for this model? Chunk-type
    // tallies + a sample from each delta kind, so one observation is conclusive.
    const typeCounts = {};
    const samples = {};
    let finishReason = null;
    try {
      for await (const chunk of llm.stream({
        provider,
        model,
        messages,
        maxTokens: 4000,
        sessionId,
        signal,
      })) {
        const t = chunk?.type ?? "?";
        typeCounts[t] = (typeCounts[t] ?? 0) + 1;
        if (t === "text-delta" && chunk.text) {
          response += chunk.text;
          if (!samples["text-delta"]) samples["text-delta"] = chunk.text.slice(0, 60);
        } else if (t === "reasoning-delta" && chunk.text) {
          reasoning += chunk.text;
          if (!samples["reasoning-delta"]) samples["reasoning-delta"] = chunk.text.slice(0, 60);
        } else if (t === "finish") {
          finishReason = chunk.reason;
        } else if (t === "block-start" && !samples["block-start"]) {
          samples["block-start"] = `blockType=${chunk.blockType}`;
        }
      }
    } catch (e) {
      dbg(`bail: LLM stream failed (${e?.name}: ${e?.message})`);
      ctx.logger?.warn?.(`dsh-reflect distill: LLM call failed (${e.message})`);
      return;
    }
    dbg(`chunk types=${JSON.stringify(typeCounts)} finish=${typeof finishReason === "object" ? JSON.stringify(finishReason) : finishReason} samples=${JSON.stringify(samples)}`);
    dbg(`streamed text chars=${response.length} reasoning chars=${reasoning.length} textHead=${JSON.stringify(response.slice(0, 80))}`);

    // Parse output and queue candidates. Prefer the model's visible answer; if the
    // thinking model was cut off before emitting one, fall back to its reasoning
    // text. Extraction slices the outermost JSON array so markdown fences or a
    // prose lead-in/out don't defeat the parse (models rarely return pure JSON).
    function extractArray(src) {
      const start = src.indexOf("[");
      const end = src.lastIndexOf("]");
      if (start === -1 || end === -1 || end <= start) return null;
      try {
        const obj = JSON.parse(src.slice(start, end + 1));
        return Array.isArray(obj) ? obj : null;
      } catch {
        return null;
      }
    }
    let parsed = extractArray(response);
    let usedSource = "text";
    if (!parsed) { parsed = extractArray(reasoning); usedSource = "reasoning"; }
    if (!parsed) { dbg(`bail: no JSON array in text(chars=${response.length}) or reasoning(chars=${reasoning.length})`); return; }
    dbg(`parsed array from=${usedSource} items=${parsed.length}`);

    // Queue new entries; skip merge/drop for now (manual review only).
    const { queuePending } = await import("./pending.js");
    const { screen } = await import("./redact.js");
    const { readEntries } = await import("./store.js");
    const queued = processCandidates(parsed, {
      screen,
      queuePending,
      readEntries,
      pendingFile,
      memoryFile,
      sessionId,
      dbg,
    });
    dbg(`done: parsed=${parsed.length} queued=${queued}`);
    if (queued > 0) {
      ctx.logger?.info?.(`dsh-reflect distill: queued ${queued} candidate(s) for ${sessionId}`);
    }
  } catch (e) {
    dbg(`bail: unexpected error (${e?.name}: ${e?.message})`);
    ctx.logger?.warn?.(`dsh-reflect distill: unexpected error (${e.message})`);
  }
}

export function getDebounceStatus() {
  return Array.from(lastDistill.entries()).map(([id, ts]) => ({ id, lastDistillAt: new Date(ts).toISOString() }));
}

/**
 * Turn distilled JSON items into pending-queue entries.
 *
 * Extracted from tryDistill so the two wiring bugs this function fixes can be
 * regression-tested directly:
 *  1. `screen()` returns `{ text, hits, truncated }` — there is NO `allowed`
 *     flag. spike.22 tested `!screenResult.allowed`, which is always true, so
 *     every candidate was silently dropped (distill-debug.log showed parsed>0
 *     yet queued=0). A safe entry is `hits.length === 0`.
 *  2. `queuePending(file, entry, against)` wants `entry` as an OBJECT
 *     `{ text, tags, source }` and `against` as the existing-entries list.
 *     spike.22 passed a markdown string and a string label, so even a survivor
 *     of (1) queued as `reason: "empty"`.
 *
 * @param parsed - decoded `{verdict,text,tags}[]` from the LLM JSON answer.
 * @param deps    - injected to keep this pure of LLM/session plumbing.
 * @returns number of entries actually stored (redaction/dup/empty all excluded).
 */
export function processCandidates(
  parsed,
  { screen, queuePending, readEntries, pendingFile, memoryFile, sessionId, dbg = () => {} },
) {
  const existing = memoryFile ? readEntries(memoryFile) : [];
  let queued = 0;
  const tagsOf = (t) => (Array.isArray(t) ? t.map((s) => String(s).trim()).filter(Boolean) : []);
  const src = `${sessionId}@distill`;
  const validIdx = (raw) => Number.isInteger(Number(raw)) && Number(raw) >= 0 && Number(raw) < existing.length;
  for (const item of parsed) {
    if (!item || !item.verdict) continue;
    const verdict = item.verdict;

    if (verdict === "new") {
      if (!item.text) continue;
      const sr = screen(item.text);
      if (sr.hits.length) {
        dbg(`skip new blocked by redaction: ${JSON.stringify(item.text.slice(0, 40))}`);
        continue;
      }
      const res = queuePending(pendingFile, { text: sr.text, tags: tagsOf(item.tags), source: src }, existing);
      if (res && res.stored) queued++;
    } else if (verdict === "merge") {
      if (!validIdx(item.idx)) {
        dbg(`skip merge with out-of-range idx ${item.idx}`);
        continue;
      }
      if (!item.text) continue;
      const sr = screen(item.text);
      if (sr.hits.length) {
        dbg(`skip merge blocked by redaction: ${JSON.stringify(item.text.slice(0, 40))}`);
        continue;
      }
      const res = queuePending(
        pendingFile,
        // distill's idx is 0-based into the existing list; store/pending use 1-based
        { kind: "merge", idx: Number(item.idx) + 1, text: sr.text, tags: tagsOf(item.tags), source: src },
        existing,
      );
      if (res && res.stored) queued++;
    } else if (verdict === "drop") {
      if (!validIdx(item.idx)) {
        dbg(`skip drop with out-of-range idx ${item.idx}`);
        continue;
      }
      const res = queuePending(pendingFile, { kind: "drop", idx: Number(item.idx) + 1, source: src }, existing);
      if (res && res.stored) queued++;
    } else if (verdict === "supersede") {
      if (!validIdx(item.idx)) {
        dbg(`skip supersede with out-of-range idx ${item.idx}`);
        continue;
      }
      if (!item.text) continue;
      const sr = screen(item.text);
      if (sr.hits.length) {
        dbg(`skip supersede blocked by redaction: ${JSON.stringify(item.text.slice(0, 40))}`);
        continue;
      }
      const res = queuePending(
        pendingFile,
        { kind: "supersede", idx: Number(item.idx) + 1, text: sr.text, tags: tagsOf(item.tags), source: src },
        existing,
      );
      if (res && res.stored) queued++;
    }
  }
  return queued;
}
