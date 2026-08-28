/**
 * dsh-reflect: file-level self-learning prototype for DeepSeek Harness.
 *
 * Three model-facing tools over a markdown memory file, plus one injection
 * seam:
 *  - reflect_record      append one durable lesson (dedup on normalized text)
 *  - reflect_recall      read the current memory (global and/or workspace)
 *  - reflect_consolidate model-driven rewrite of the full list (auto-backup)
 *  - `system-prompt/assemble` listener injects the global list + usage rules
 *    as a prompt section, so every session starts aware of its notes.
 *
 * Memory lives in plain files — auditable and human-editable:
 *  - global:    ~/.dsh/reflect/memory.md
 *  - workspace: <cwd>/.dsh/memory.md
 *
 * @module @garvel/dsh-reflect
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  CHARS_PER_TOKEN,
  parseLine,
  recordEntry,
  readEntries,
  renderInjection,
  rewriteEntries,
} from "./store.js";
import { blockReason, screen } from "./redact.js";
import { pendingPreview, queuePending, readPending, resolvePending } from "./pending.js";
import { tryDistill } from "./distill.js";

const name = "tool-reflect";
const inject = ["tools", "systemPrompt"];

const SECTION_NAME = "dsh-reflect-memory";
const GLOBAL_FILE = process.env.DSH_REFLECT_GLOBAL_FILE || join(homedir(), ".dsh", "reflect", "memory.md");
const GLOBAL_PENDING = process.env.DSH_REFLECT_GLOBAL_PENDING || join(homedir(), ".dsh", "reflect", "pending.md");
const WORKSPACE_REL = join(".dsh", "memory.md");
const WORKSPACE_PENDING_REL = join(".dsh", "memory-pending.md");
// Budget in tokens at the harness's own 4 chars/token density (see store.js).
const INJECT_MAX_TOKENS = Number(process.env.DSH_REFLECT_INJECT_MAX_TOKENS || 600);
// Legacy direct override in characters; when set it wins over the token budget.
const INJECT_MAX_CHARS = Number(process.env.DSH_REFLECT_INJECT_MAX_CHARS || 0);
// Spike probe: write every session/event to events.jsonl so we can verify
// {global:true} listeners see ALL sessions' turns, not just the current one.
const EVENT_LOG = (() => {
  const raw = process.env.DSH_REFLECT_EVENT_LOG;
  if (raw === "off") return "";
  return raw ? raw : join(homedir(), ".dsh", "reflect", "events.jsonl");
})();
const MAX_ENTRIES = 500;

/**
 * Self-observation for the injection face.
 *
 * "Warn once" is not enough to debug a silently dropped layer: what matters is
 * WHICH LINK of `context.agent?.session?.header?.cwd` came up empty on the turn
 * where it happened. So each assembly overwrites a tiny state file. It is a spike
 * diagnostic (a 200-byte sync write per model request), goes before any real
 * release, and `DSH_REFLECT_ASSEMBLY_FILE=off` disables it. Failing to write it
 * must never fail the request, hence the inner catch.
 */
const ASSEMBLY_FILE = (() => {
  const raw = process.env.DSH_REFLECT_ASSEMBLY_FILE;
  if (raw === "off") return "";
  return raw ? raw : join(homedir(), ".dsh", "reflect", "assembly.json");
})();
let assemblies = 0;

function reportShape(state) {
  if (!ASSEMBLY_FILE) return;
  try {
    assemblies++;
    writeFileSync(ASSEMBLY_FILE, JSON.stringify({ ...state, assemblies, at: new Date().toISOString() }, null, 2), "utf8");
  } catch {
    /* diagnostics are never allowed to cost a turn */
  }
}

/** Which link of the cwd chain broke — the answer the whole probe exists for. */
function cwdStage(agent) {
  if (agent === void 0) return "no-agent";
  if (agent.session === void 0) return "no-session";
  if (agent.session.header === void 0) return "no-header";
  if (agent.session.header.cwd === void 0) return "no-cwd";
  return "ok";
}

/** Resolve which file a scoped call operates on. */
function targetFile(scope, workspaceDir) {
  if (scope === "global") return GLOBAL_FILE;
  if (!workspaceDir) {
    throw new HarnessError("reflect: workspace scope needs workspace_dir (pass your current working directory)", "invalid_request");
  }
  return join(workspaceDir, WORKSPACE_REL);
}

/**
 * The queue paired with a memory file. Each queue belongs to exactly one memory
 * file, so an approval never has to guess where a candidate should land.
 */
function pendingFile(scope, workspaceDir) {
  if (scope === "global") return GLOBAL_PENDING;
  if (!workspaceDir) {
    throw new HarnessError("reflect: workspace scope needs workspace_dir (pass your current working directory)", "invalid_request");
  }
  return join(workspaceDir, WORKSPACE_PENDING_REL);
}

// Harness contract (`render(args, value)` — see dsh-tool-fs): parameter ONE is
// the call's arguments, the validated return value is parameter TWO. Binding the
// value as the first parameter makes the tool echo its own input to the model
// while the side effect still happens — silent, so it needs an explicit test.
const render = (_args, value) => [{ type: "text", text: JSON.stringify(value) }];

function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "reflect_record",
    description:
      "Record one durable lesson into persistent memory so future sessions can see it. " +
      "Good entries: decisions with rationale, verified commands/workarounds, pitfalls, user preferences. " +
      "One entry per call, self-contained sentence, optional #tags. Duplicates are dropped. " +
      "Every line passes a credential screen: if it looks like a key/token/blob the call refuses and you must rephrase to describe the value's shape or location instead.",
    parameters: {
      text: { type: "string", required: true, description: "The lesson, one self-contained line." },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags, e.g. npm, plugin." },
      scope: { type: "string", enum: ["workspace", "global"], description: "Defaults to workspace (lives with the project)." },
      workspace_dir: { type: "string", description: "Absolute working directory of the project (required for workspace scope)." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: { stored: { type: "boolean", required: true }, count: { type: "number", required: true }, file: { type: "string", required: true }, reason: { type: "string" }, truncated: { type: "boolean" } }
      },
      render
    },
    async execute(args) {
      const scope = args.scope || "workspace";
      const file = targetFile(scope, args.workspace_dir);
      const checked = screen(args.text);
      if (checked.hits.length) {
        return { file, stored: false, count: readEntries(file).length, reason: blockReason(checked.hits) };
      }
      const res = recordEntry(file, checked.text, args.tags || []);
      return { file, ...res, ...(checked.truncated ? { truncated: true } : {}) };
    }
  }));

  ctx.tools.register(defineTool({
    name: "reflect_recall",
    description:
      "Read persistent memory (global notes and/or this workspace's notes). Call it at the start of substantial work in a project that may have history.",
    parameters: {
      scope: { type: "string", enum: ["all", "workspace", "global"], description: "Defaults to all." },
      workspace_dir: { type: "string", description: "Absolute working directory (needed only when scope includes workspace)." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          global: { type: "object", required: true, additionalProperties: true },
          workspace: { type: "object", required: true, additionalProperties: true }
        }
      },
      render
    },
    async execute(args) {
      const scope = args.scope || "all";
      const grab = (file) => {
        const entries = readEntries(file);
        return { file, count: entries.length, entries };
      };
      let workspace = { count: 0, skipped: true };
      if (scope !== "global") {
        workspace = args.workspace_dir ? grab(join(args.workspace_dir, WORKSPACE_REL)) : { count: 0, note: "workspace_dir not provided" };
      }
      return {
        global: scope !== "workspace" ? grab(GLOBAL_FILE) : { file: GLOBAL_FILE, count: 0, skipped: true },
        workspace,
      };
    }
  }));

  ctx.tools.register(defineTool({
    name: "reflect_consolidate",
    description:
      "Rewrite an entire memory file with a distilled list (merge duplicates, drop stale trivia, keep what still changes behavior). " +
      "The previous file is backed up automatically, so aggressive condensing is safe. Supply the COMPLETE new list.",
    parameters: {
      entries: { type: "array", items: { type: "string" }, required: true, description: "Full replacement lesson list; each item may carry trailing #tags." },
      scope: { type: "string", enum: ["workspace", "global"], description: "Defaults to workspace." },
      workspace_dir: { type: "string", description: "Absolute working directory (required for workspace scope)." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: { count: { type: "number", required: true }, file: { type: "string", required: true }, backup: { type: "string" }, blocked: { type: "number" } }
      },
      render
    },
    async execute(args) {
      const scope = args.scope || "workspace";
      const file = targetFile(scope, args.workspace_dir);
      if (!Array.isArray(args.entries)) throw new HarnessError("reflect_consolidate: entries must be an array of strings", "invalid_request");
      const parsed = [];
      let blocked = 0;
      for (const raw of args.entries.slice(0, MAX_ENTRIES)) {
        const e = parseLine(`- ${String(raw).replace(/^-\s*/, "")}`);
        if (!e) continue;
        // A rewrite is the last chance to sanitize: drop the credential-shaped
        // lines and keep consolidating, rather than failing the whole call.
        const checked = screen(e.text);
        if (checked.hits.length) {
          blocked++;
          continue;
        }
        parsed.push({ ...e, text: checked.text });
      }
      if (!parsed.length && args.entries.length) {
        throw new HarnessError("reflect_consolidate: no parseable entries", "invalid_request");
      }
      return { file, ...rewriteEntries(file, parsed), ...(blocked ? { blocked } : {}) };
    }
  }));

  // ---- the review queue: candidates never reach the prompt without approval ----
  ctx.tools.register(defineTool({
    name: "reflect_pending",
    description:
      "Review queue for durable memory. Candidates land here (not in memory.md) and are injected into NO prompt until approved. " +
      "action=list shows the numbered queue; action=queue adds one screened candidate (use it for lessons you are not sure deserve the memory file yet, e.g. auto-distilled ones); " +
      "action=approve / action=drop take 1-based indexes from the latest list. Never auto-approve your own candidates.",
    parameters: {
      action: { type: "string", enum: ["list", "queue", "approve", "drop"], required: true, description: "What to do with the queue." },
      scope: { type: "string", enum: ["workspace", "global"], description: "Which queue/memory pair. Defaults to workspace." },
      workspace_dir: { type: "string", description: "Absolute working directory (required for workspace scope)." },
      text: { type: "string", description: "Candidate lesson line (action=queue)." },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags (action=queue)." },
      source: { type: "string", description: "Provenance pointer, e.g. session-abc123@42. Keep it: it is how a bad lesson gets traced back." },
      ids: { type: "array", items: { type: "number" }, description: "1-based indexes from the latest list (action=approve/drop)." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          action: { type: "string", required: true }, count: { type: "number", required: true }, file: { type: "string", required: true },
          preview: { type: "array", items: { type: "string" } },
          moved: { type: "number" }, discarded: { type: "number" }, invalid: { type: "array", items: { type: "number" } },
          stored: { type: "boolean" }, reason: { type: "string" }, backup: { type: "string" }
        }
      },
      render
    },
    async execute(args) {
      const scope = args.scope || "workspace";
      const action = args.action;
      const queue = pendingFile(scope, args.workspace_dir);
      const memory = targetFile(scope, args.workspace_dir);
      const queued = readPending(queue);
      const previewOf = () => queued.map((e, i) => pendingPreview(e, i + 1));

      if (action === "list") {
        return { action, file: queue, count: queued.length, preview: previewOf() };
      }
      if (action === "queue") {
        const checked = screen(args.text || "");
        if (!checked.text) throw new HarnessError("reflect_pending: action=queue needs a non-empty text", "invalid_request");
        if (checked.hits.length) {
          return { action, file: queue, count: queued.length, stored: false, reason: blockReason(checked.hits) };
        }
        const res = queuePending(queue, { text: checked.text, tags: args.tags || [], source: args.source }, readEntries(memory));
        return { action, file: queue, count: res.count, stored: res.stored, ...(res.reason ? { reason: res.reason } : {}), ...(checked.truncated ? { truncated: true } : {}) };
      }
      if (action === "approve" || action === "drop") {
        const ids = Array.isArray(args.ids) ? args.ids : [];
        if (!ids.length) throw new HarnessError(`reflect_pending: action=${action} needs ids from a prior list`, "invalid_request");
        const res = action === "approve"
          ? resolvePending(queue, memory, ids, [], (file, text, tags) => recordEntry(file, text, tags))
          : resolvePending(queue, memory, [], ids, () => ({ stored: false }));
        return {
          action, file: queue, count: res.count,
          moved: res.moved.length, discarded: res.discarded.length,
          preview: [...res.moved.map((m) => `approved #${m.index} ${m.text}`), ...res.discarded.map((d) => `dropped #${d.index} ${d.text}`)],
          ...(res.invalid.length ? { invalid: res.invalid } : {}),
          ...(res.backup ? { backup: res.backup } : {}),
        };
      }
      throw new HarnessError(`reflect_pending: unknown action ${action}`, "invalid_request");
    }
  }));

  // Slash command over the same store: a human reviewing the queue should not
  // need the model's cooperation. Absent `commands` (a preset without the command
  // plane) simply means no command — the tools still work.
  const commands = ctx.get("commands");
  if (commands !== undefined) {
    commands.register({
      name: "reflect-review",
      description: "List / approve / drop candidates in the dsh-reflect review queue.",
      input: { hint: "[global] [approve 1,3 | drop 2 | clear]" },
      async handler({ rawInput, agent }) {
        const parts = String(rawInput || "").trim().split(/\s+/).filter(Boolean);
        const scope = parts[0] === "global" || parts[0] === "workspace" ? parts.shift() : "workspace";
        const cwd = agent?.session?.header?.cwd;
        if (scope !== "global" && !cwd) {
          return { kind: "error", text: "reflect-review: 该会话没有工作区，请用 `/reflect-review global …`" };
        }
        const queue = pendingFile(scope, cwd);
        const memory = targetFile(scope, cwd);
        const verb = (parts[0] || "list").toLowerCase();
        const indexes = (parts[1] || "").split(/[,，\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
        const queued = readPending(queue);
        if (verb === "list") {
          const preview = queued.map((e, i) => pendingPreview(e, i + 1)).join("\n");
          return { kind: "success", text: `候选队列（${scope} · ${queue}）现有 ${queued.length} 条：\n${preview || "（空）"}\n\n用 \`/reflect-review${scope === "global" ? " global" : ""} approve 1,2\` 批准入库，\`drop 3\` 丢弃。` };
        }
        if (verb === "clear") {
          if (!queued.length) return { kind: "success", text: "队列已经是空的。" };
          const res = resolvePending(queue, memory, [], queued.map((_e, i) => i + 1), () => ({ stored: false }));
          return { kind: "success", text: `已丢弃 ${res.discarded.length} 条候选（备份：${res.backup || "无"}）。` };
        }
        if (verb !== "approve" && verb !== "accept" && verb !== "drop") {
          return { kind: "error", text: "用法：/reflect-review [global] [list | approve 1,2 | drop 3 | clear]" };
        }
        if (!indexes.length) return { kind: "error", text: "要给序号，例如 approve 1,3" };
        const accept = verb === "drop" ? [] : indexes;
        const drop = verb === "drop" ? indexes : [];
        const res = resolvePending(queue, memory, accept, drop, (file, text, tags) => recordEntry(file, text, tags));
        const lines = [
          ...res.moved.map((m) => `✓ 入库 #${m.index}：${m.text}`),
          ...res.discarded.map((d) => `✗ 丢弃 #${d.index}：${d.text}`),
        ];
        if (res.invalid.length) lines.push(`序号不存在：${res.invalid.join(", ")}`);
        lines.push(`剩余候选 ${res.count} 条${res.backup ? `（旧队列备份 ${res.backup}）` : ""}`);
        return { kind: "success", text: lines.join("\n") };
      },
    });
  }

  // ---- manual distill command (spike: lists sessions with completed turns only,
  // no auto-trigger yet — waiting on the {global:true} event-listener probe) ----
  if (commands !== undefined) {
    commands.register({
      name: "reflect-distill",
      description: "List sessions that have completed turns (for manual distillation).",
      input: { hint: "[workspace|global] [--count N]" },
      async handler({ rawInput, agent }) {
        const parts = String(rawInput || "").trim().split(/\s+/).filter(Boolean);
        const scope = parts[0] === "global" || parts[0] === "workspace" ? parts.shift() : "workspace";
        const countMatch = parts.find((p) => p.startsWith("--count="));
        const maxSessions = countMatch ? Number.parseInt(countMatch.split("=")[1], 10) || 10 : 10;
        if (Number.isNaN(maxSessions) || maxSessions < 1) return { kind: "error", text: "reflect-distill: --count must be a positive integer" };
        // Stub: in the real loop this would call sessionQuery.listSessions + filterEvents.
        // For now, return a placeholder that the probe events.jsonl will confirm the
        // listener is alive when the user checks it after a restart.
        return {
          kind: "success",
          text: `reflect-distill (spike stub): scope=${scope}, max=${maxSessions}\n` +
            `This command is a skeleton — auto-distillation is not yet wired.\n` +
            `Use /reflect-review to approve queued candidates.\n` +
            `Check ~/.dsh/reflect/events.jsonl to verify the session/event listener fired.`,
        };
      },
    });
  }

  // ---- spike probe + auto-distill: {global:true} session/event listener ----
  // Logs every event to EVENT_LOG so we can verify {global:true} spans all sessions.
  // When DSH_REFLECT_AUTO_DISTILL=on, also triggers a distillation pass on each
  // completed turn/end (debounced per-session, 5 min minimum gap).
  const AUTO_DISTILL = process.env.DSH_REFLECT_AUTO_DISTILL === "on";
  ctx.on("session/event", (subject, event) => {
    // Probe: always write (cheap append).
    if (EVENT_LOG) {
      try {
        // Debug: dump all own keys to discover actual event shape
        const keys = event ? Object.getOwnPropertyNames(event) : [];
        const dataKeys = event?.data ? Object.getOwnPropertyNames(event.data) : [];
        const line = JSON.stringify({
          at: new Date().toISOString(),
          subjectType: typeof subject,
          eventType: event?.type,
          reason: event?.data?.reason?.kind,
          seq: event?.seq,
          keys: keys,
          dataKeys: dataKeys,
        });
        writeFileSync(EVENT_LOG, line + "\n", { flag: "a", encoding: "utf8" });
      } catch {
        /* probe must never break the session */
      }
    }
    // Distill: fire-and-forget, guarded by env and event shape.
    if (!AUTO_DISTILL) return;
    if (event?.type !== "turn/end" || event?.data?.reason?.kind !== "completed") return;
    const agent = subject;
    if (!agent) return;
    tryDistill(ctx, event, agent).catch(() => {});
  }, { global: true });

  // A `section()` provider, not a `system-prompt/assemble` listener: the registry
  // owns disposal and rejects a duplicate name outright (no hand-rolled idempotency
  // check), and — decisively — the provider receives the assembly context, whose
  // runtime shape is `{agent, scope: agent}` (`assembleContextFor()` in dsh-agent)
  // even though `AssembleContext` only declares `{scope?, signal?}`. That is where
  // `agent.session.header.cwd` comes from, and it is what makes the WORKSPACE layer
  // injectable at all. Because `agent` is an undeclared runtime fact, every access
  // is optional and its absence degrades to the global-only v0 behavior — loudly,
  // once, rather than silently dropping a layer someone assumed was live.
  const shapeWarned = { done: false };
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: 950,
    text: (context) => {
      try {
        const agent = context?.agent;
        if (agent === void 0 && !shapeWarned.done) {
          shapeWarned.done = true;
          ctx.logger?.warn?.("dsh-reflect: the assemble context carried no `agent`; workspace memory will not be injected (harness shape changed?)");
        }
        const cwd = agent?.session?.header?.cwd;
        const globalEntries = readEntries(GLOBAL_FILE);
        const workspaceEntries = cwd ? readEntries(join(cwd, WORKSPACE_REL)) : [];
        // Count both queues a session could be waiting on; contents never render here.
        const pendingCount =
          readPending(GLOBAL_PENDING).length +
          (cwd ? readPending(join(cwd, WORKSPACE_PENDING_REL)).length : 0);
        const text = renderInjection(globalEntries, workspaceEntries, {
          maxTokens: INJECT_MAX_TOKENS,
          maxChars: INJECT_MAX_CHARS,
          pendingCount,
        });
        reportShape({
          stage: cwdStage(agent),
          cwd: cwd ?? null,
          global: globalEntries.length,
          workspace: workspaceEntries.length,
          pending: pendingCount,
          chars: text.length,
          budgetChars: INJECT_MAX_CHARS > 0 ? INJECT_MAX_CHARS : INJECT_MAX_TOKENS * CHARS_PER_TOKEN,
        });
        return text;
      } catch {
        // Memory is an enhancement; it must never break a model request.
        return "";
      }
    },
  });
}

export { apply, inject, name };
