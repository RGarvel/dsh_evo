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
import { join } from "node:path";

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

/**
 * Decide whether one session qualifies for a distillation pass.
 * Returns { qualified: true, cwd, sessionId } or null.
 */
function selectCandidate(event, agent, allSessions) {
  if (event.type !== "turn/end") return null;
  if (event.reason !== "completed") return null;
  const sessionId = agent.session.id;
  const now = Date.now();
  const last = lastDistill.get(sessionId) ?? 0;
  if (now - last < DEBOUNCE_MS) return null;
  // Need cwd to decide global vs workspace.
  const cwd = agent.session.header?.cwd;
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
    (e) =>
      e.type === "turn/end" &&
      e.kind === "completed" &&
      (!sinceSeq || e.seq > sinceSeq),
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
export async function tryDistill(ctx, event, agent) {
  try {
    const sessionQuery = ctx.get("sessionQuery");
    if (!sessionQuery) return;

    const candidate = selectCandidate(event, agent, null);
    if (!candidate) return;

    const { sessionId, cwd } = candidate;
    const isWorkspace = cwd !== undefined;
    const memoryFile = isWorkspace ? join(cwd, ".dsh", "memory.md") : null;
    const pendingFile = isWorkspace
      ? join(cwd, ".dsh", "memory-pending.md")
      : join(process.env.HOME || "", ".dsh", "reflect", "pending.md");

    // Check completed-turn count — skip short sessions.
    // We need the seq of the last completed turn before this one.
    const allEvents = await sessionQuery.listEvents(sessionId);
    const completedSince = allEvents
      .filter((e) => e.type === "turn/end" && e.kind === "completed")
      .filter((e) => e.seq < event.seq);
    if (completedSince.length < MIN_COMPLETED_TURNS) return;
    const sinceSeq = completedSince[completedSince.length - 1].seq;

    // Fetch message content.
    const content = await fetchTurnContent(sessionQuery, sessionId, sinceSeq, 100);
    if (!content.trim()) return;

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

    // Get provider/model from session header config.
    let provider = null;
    let model = null;
    try {
      const header = agent.session.requestHeader?.();
      if (header?.config) {
        provider = header.config.provider;
        model = header.config.model;
      }
    } catch {
      /* requestHeader may not be available — fall through to agent.options */
    }
    if (!provider || !model) {
      try {
        const opts = agent.options;
        if (opts?.provider) provider = opts.provider;
        if (opts?.model) model = opts.model;
      } catch {
        /* ignore */
      }
    }
    if (!provider || !model) return; // no LLM route available

    // Assemble LLM call.
    const messages = [
      { role: "user", content: [{ type: "text", text: PROMPT }] },
      { role: "user", content: [{ type: "text", text: `EXISTING LESSONS:\n${existingLessons || "(none)"}` }] },
      { role: "user", content: [{ type: "text", text: `CONVERSATION:\n${content}` }] },
    ];

    const signal = AbortSignal.timeout(DISTILL_TIMEOUT_MS);
    let response = "";
    try {
      for await (const chunk of ctx.llm.stream({
        provider,
        model,
        messages,
        maxTokens: 500,
        purpose: "distill",
        sessionId: agent.session.id,
        signal,
      })) {
        if (chunk.type === "text-delta" && chunk.text) response += chunk.text;
      }
    } catch (e) {
      ctx.logger?.warn?.(`dsh-reflect distill: LLM call failed (${e.message})`);
      return;
    }

    // Parse output and queue candidates.
    const trimmed = response.trim();
    if (!trimmed.startsWith("[")) return; // not JSON
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      ctx.logger?.warn?.("dsh-reflect distill: LLM did not return valid JSON");
      return;
    }
    if (!Array.isArray(parsed)) return;

    // Queue new entries; skip merge/drop for now (manual review only).
    const { queuePending } = await import("./pending.js");
    const { screen } = await import("./redact.js");
    for (const item of parsed) {
      if (item.verdict !== "new" || !item.text) continue;
      const screenResult = screen(item.text);
      if (!screenResult.allowed) continue;
      const tagStr = (item.tags || []).join(" ");
      queuePending(pendingFile, `- ${item.text}${tagStr ? " #" + tagStr : ""} @src:${sessionId}@distill`, "spike-auto-distill");
    }
    if (parsed.filter((i) => i.verdict === "new" && i.text).length > 0) {
      ctx.logger?.info?.(`dsh-reflect distill: queued ${parsed.filter((i) => i.verdict === "new").length} candidate(s) for ${sessionId}`);
    }
  } catch (e) {
    ctx.logger?.warn?.(`dsh-reflect distill: unexpected error (${e.message})`);
  }
}

export function getDebounceStatus() {
  return Array.from(lastDistill.entries()).map(([id, ts]) => ({ id, lastDistillAt: new Date(ts).toISOString() }));
}
