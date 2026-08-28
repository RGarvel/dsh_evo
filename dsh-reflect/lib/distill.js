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

// A completed turn/end, tolerant of both the flat ({kind}) and the SessionEvent
// ({data:{reason:{kind}}}) shapes so we are not guessing which one listEvents gives.
function isCompletedTurnEnd(e) {
  if (!e || e.type !== "turn/end") return false;
  return e.kind === "completed" || e.data?.reason?.kind === "completed";
}

const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes per session
const DISTILL_TIMEOUT_MS = 60_000;
const MIN_COMPLETED_TURNS = 3; // skip short sessions
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
  { "verdict": "drop", "idx": 7 }
]
For merge: idx is 0-based into the existing-lessons list (global first, then workspace).
For drop: idx is 0-based into the existing-lessons list.
If you return only "new" items, the existing lessons are preserved unchanged.`;

// Per-session last-distill timestamp (in-memory, reset on restart).
const lastDistill = new Map();

// Spike diagnostic: log every gate the distill loop passes or bails on, so one
// restart tells us exactly why pending.md stayed empty. Strips before release.
const DEBUG_FILE = join(homedir(), ".dsh", "reflect", "distill-debug.log");
function dbg(msg) {
  try {
    writeFileSync(DEBUG_FILE, new Date().toISOString() + " " + msg + "\n", { flag: "a", encoding: "utf8" });
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
  lastDistill.set(sessionId, now);
  return { sessionId, cwd };
}

/**
 * Count completed turns since `sinceSeq` for one session.
 */
async function completedTurnCount(sessionQuery, sessionId, sinceSeq) {
  const events = await sessionQuery.listEvents(sessionId);
  if (!events.length) return 0;
  return events.filter(
    (e) => isCompletedTurnEnd(e) && (!sinceSeq || e.seq > sinceSeq),
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
      .filter((e) => isCompletedTurnEnd(e))
      .filter((e) => e.seq < event.seq);
    if (completedSince.length < MIN_COMPLETED_TURNS) { dbg(`bail: completed turns before this = ${completedSince.length} < ${MIN_COMPLETED_TURNS}`); return; }
    const sinceSeq = completedSince[completedSince.length - 1].seq;

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
    try {
      for await (const chunk of ctx.llm.stream({
        provider,
        model,
        messages,
        maxTokens: 500,
        sessionId,
        signal,
      })) {
        if (chunk.type === "text-delta" && chunk.text) response += chunk.text;
      }
    } catch (e) {
      dbg(`bail: LLM stream failed (${e?.name}: ${e?.message})`);
      ctx.logger?.warn?.(`dsh-reflect distill: LLM call failed (${e.message})`);
      return;
    }
    dbg(`streamed response chars=${response.length} head=${JSON.stringify(response.slice(0, 80))}`);

    // Parse output and queue candidates.
    const trimmed = response.trim();
    if (!trimmed.startsWith("[")) { dbg(`bail: response not JSON array (head=${JSON.stringify(trimmed.slice(0, 40))})`); return; } // not JSON
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      dbg("bail: invalid JSON from LLM");
      ctx.logger?.warn?.("dsh-reflect distill: LLM did not return valid JSON");
      return;
    }
    if (!Array.isArray(parsed)) { dbg("bail: parsed JSON not an array"); return; }

    // Queue new entries; skip merge/drop for now (manual review only).
    const { queuePending } = await import("./pending.js");
    const { screen } = await import("./redact.js");
    let queued = 0;
    for (const item of parsed) {
      if (item.verdict !== "new" || !item.text) continue;
      const screenResult = screen(item.text);
      if (!screenResult.allowed) { dbg(`skip candidate blocked by redaction: ${JSON.stringify(item.text.slice(0, 40))}`); continue; }
      const tagStr = (item.tags || []).join(" ");
      queuePending(pendingFile, `- ${item.text}${tagStr ? " #" + tagStr : ""} @src:${sessionId}@distill`, "spike-auto-distill");
      queued++;
    }
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
