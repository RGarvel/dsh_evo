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
import { homedir } from "node:os";
import { join } from "node:path";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  parseLine,
  recordEntry,
  readEntries,
  renderInjection,
  rewriteEntries,
} from "./store.js";

const name = "tool-reflect";
const inject = ["tools", "systemPrompt"];

const SECTION_NAME = "dsh-reflect-memory";
const GLOBAL_FILE = process.env.DSH_REFLECT_GLOBAL_FILE || join(homedir(), ".dsh", "reflect", "memory.md");
const WORKSPACE_REL = join(".dsh", "memory.md");
const INJECT_MAX_CHARS = Number(process.env.DSH_REFLECT_INJECT_MAX_CHARS || 1800);
const MAX_ENTRIES = 500;

/** Resolve which file a scoped call operates on. */
function targetFile(scope, workspaceDir) {
  if (scope === "global") return GLOBAL_FILE;
  if (!workspaceDir) {
    throw new HarnessError("reflect: workspace scope needs workspace_dir (pass your current working directory)", "invalid_request");
  }
  return join(workspaceDir, WORKSPACE_REL);
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
      "One entry per call, self-contained sentence, optional #tags. Duplicates are dropped. Never record secrets.",
    parameters: {
      text: { type: "string", required: true, description: "The lesson, one self-contained line." },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags, e.g. npm, plugin." },
      scope: { type: "string", enum: ["workspace", "global"], description: "Defaults to workspace (lives with the project)." },
      workspace_dir: { type: "string", description: "Absolute working directory of the project (required for workspace scope)." }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: { stored: { type: "boolean", required: true }, count: { type: "number", required: true }, file: { type: "string", required: true }, reason: { type: "string" } }
      },
      render
    },
    async execute(args) {
      const scope = args.scope || "workspace";
      const file = targetFile(scope, args.workspace_dir);
      const res = recordEntry(file, args.text, args.tags || []);
      return { file, ...res };
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
        properties: { count: { type: "number", required: true }, file: { type: "string", required: true }, backup: { type: "string" } }
      },
      render
    },
    async execute(args) {
      const scope = args.scope || "workspace";
      const file = targetFile(scope, args.workspace_dir);
      if (!Array.isArray(args.entries)) throw new HarnessError("reflect_consolidate: entries must be an array of strings", "invalid_request");
      const parsed = [];
      for (const raw of args.entries.slice(0, MAX_ENTRIES)) {
        const e = parseLine(`- ${String(raw).replace(/^-\s*/, "")}`);
        if (e) parsed.push(e);
      }
      if (!parsed.length && args.entries.length) {
        throw new HarnessError("reflect_consolidate: no parseable entries", "invalid_request");
      }
      return { file, ...rewriteEntries(file, parsed) };
    }
  }));

  // Injection: every prompt assembly gets the global list + the usage rules.
  ctx.on("system-prompt/assemble", async (assembly, _context, next) => {
    try {
      if (!assembly.sections.some((s) => s.name === SECTION_NAME)) {
        const text = renderInjection(readEntries(GLOBAL_FILE), [], { maxChars: INJECT_MAX_CHARS });
        if (text) assembly.sections.push({ name: SECTION_NAME, order: 950, text });
      }
    } catch {
      /* memory must never break prompt assembly */
    }
    return await next();
  }, { global: true });
}

export { apply, inject, name };
