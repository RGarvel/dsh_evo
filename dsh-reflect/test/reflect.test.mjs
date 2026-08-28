/**
 * dsh-reflect regression tests: pure store logic + full plugin wiring against
 * a fake cordis ctx (real defineTool/HarnessError from the installed dsh tree,
 * resolved via node_modules junctions). Run: npm test
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "reflect-"));
const globalFile = join(root, "g", "memory.md");
const globalPending = join(root, "g", "pending.md");
process.env.DSH_REFLECT_GLOBAL_FILE = globalFile;
// The queue needs isolating too, or a `/reflect-review global list` test would
// read (and later write) the real ~/.dsh/reflect/pending.md.
process.env.DSH_REFLECT_GLOBAL_PENDING = globalPending;

const store = await import("../lib/store.js");
const { apply, inject, name } = await import("../lib/index.js");

let failures = 0;
const check = (label, cond) => { if (cond) console.log("ok  :", label); else { failures++; console.log("FAIL:", label); } };
const ws = join(root, "proj");

// ---- A. store: parsing ----
check("A1 name/inject exported", name === "tool-reflect" && inject.includes("tools") && inject.includes("systemPrompt"));
check("A2 parse plain line", store.parseLine("- do the thing")?.text === "do the thing");
check("A3 parse tags", JSON.stringify(store.parseLine("- a b #x #y-1")?.tags) === '["x","y-1"]');
check("A4 tags only mid-line stay text", store.parseLine("- use #tag grammar here")?.text === "use #tag grammar here");
check("A5 non-lesson lines ignored", store.parseLine("# header") === null && store.parseLine("") === null && store.parseLine("  prose") === null);
const parsed = store.parseFile("# h\n- one #a\n\n- two\n<!-- c -->\n");
check("A6 parseFile order+count", parsed.length === 2 && parsed[0].text === "one" && parsed[1].text === "two");
check("A7 format roundtrip", JSON.stringify(store.parseFile(store.formatFile(parsed))) === JSON.stringify(parsed));

// ---- B. store: record / dedup ----
const r1 = store.recordEntry(ws + "/m.md", "  PowerShell 编辑 prefs 要改用 node  ", ["prefs"]);
check("B1 record creates dirs+file", r1.stored === true && r1.count === 1 && existsSync(ws + "/m.md"));
const r2 = store.recordEntry(ws + "/m.md", "powershell 编辑 prefs  要改用 node");
check("B2 dedup ignores case+space", r2.stored === false && r2.reason === "duplicate" && r2.count === 1);
const r3 = store.recordEntry(ws + "/m.md", "npm 发布 prerelease 要 --tag", []);
check("B3 second distinct appended", r3.stored === true && r3.count === 2);
const r4 = store.recordEntry(ws + "/m.md", "   ");
check("B4 empty rejected", r4.stored === false && r4.reason === "empty");
const fileText = readFileSync(ws + "/m.md", "utf8");
check("B5 file is markdown with header", fileText.startsWith("# dsh-reflect memory") && fileText.includes("- PowerShell 编辑 prefs 要改用 node #prefs"));

// ---- C. store: consolidate / backup ----
const cb = store.rewriteEntries(ws + "/m.md", [{ text: "合并后的唯一教训", tags: ["merged"] }]);
check("C1 rewrite count + backup exists", cb.count === 1 && cb.backup && existsSync(cb.backup));
check("C2 backup keeps old content", readFileSync(cb.backup, "utf8").includes("npm 发布"));
check("C3 new file replaced", store.readEntries(ws + "/m.md").length === 1);
const emptyBack = store.rewriteEntries(ws + "/m.md", []);
check("C4 clear with backup ok", emptyBack.count === 0 && store.readEntries(ws + "/m.md").length === 0);

// ---- D. injection rendering ----
const inj = store.renderInjection([{ text: "g lesson", tags: ["t"] }], [{ text: "w lesson" }], { maxChars: 4000 });
check("D1 groups rendered", inj.includes("## Persistent Memory (dsh-reflect)") && inj.includes("- g lesson #t") && inj.includes("- w lesson"));
check("D2 usage rules present", inj.includes("reflect_record") && inj.includes("Never record secrets"));
const tiny = store.renderInjection([{ text: "x".repeat(500) }], [], { maxChars: 200 });
check("D3 truncation marker", tiny.length <= 210 && tiny.includes("reflect_recall"));

// ---- E. plugin wiring (fake ctx, real defineTool/HarnessError) ----
const registered = [];
const listeners = [];
const commandDefs = [];
const ctx = {
  tools: { register: (d) => registered.push(d) },
  on: (ev, fn, opts) => listeners.push({ ev, fn, opts }),
  get: (key) => (key === "commands" ? { register: (d) => { commandDefs.push(d); return () => {}; } } : undefined),
};
apply(ctx);
check("E1 four tools registered", ["reflect_record", "reflect_recall", "reflect_consolidate", "reflect_pending"].every((n) => registered.find((t) => t.name === n)));
check("E2 assemble listener global+guarded", listeners.length === 1 && listeners[0].ev === "system-prompt/assemble" && listeners[0].opts?.global === true);

const rec = registered.find((t) => t.name === "reflect_record");
const recRes = await rec.execute({ text: "工具注册走 ctx.tools.register", tags: ["dsh"], workspace_dir: ws });
check("E3 record tool writes workspace file", recRes.stored === true && existsSync(join(ws, ".dsh", "memory.md")));
const noDir = await rec.execute({ text: "x" }).catch((e) => e);
check("E4 workspace scope requires dir", noDir instanceof Error && /workspace_dir/.test(noDir.message));
const globRes = await rec.execute({ text: "全局教训：先看源码再下结论", scope: "global" });
check("E5 global scope file", globRes.stored === true && existsSync(globalFile));

const con = registered.find((t) => t.name === "reflect_consolidate");
const conRes = await con.execute({ entries: ["- 已带前导线的条目也能进 #tag", "纯文本条目"], workspace_dir: ws });
check("E6 consolidate strips stray leading dash", conRes.count === 2 && store.readEntries(join(ws, ".dsh", "memory.md")).find((e) => e.text.startsWith("已带前导线")));

const recall = registered.find((t) => t.name === "reflect_recall");
const all = await recall.execute({ workspace_dir: ws });
check("E7 recall all scopes", all.global.count === 1 && all.workspace.count === 2);
const gOnly = await recall.execute({ scope: "global" });
check("E8 recall global only", gOnly.global.count === 1 && gOnly.workspace.skipped === true);

const asm = { sections: [{ name: "identity", order: -100, text: "base" }], contexts: [], tools: [], variables: {} };
await listeners[0].fn(asm, {}, async () => asm);
const sec = asm.sections.find((s) => s.name === "dsh-reflect-memory");
check("E9 injection section appended", !!sec && sec.text.includes("全局教训：先看源码再下结论"));
check("E10 section text is plain string", typeof sec.text === "string");
await listeners[0].fn(asm, {}, async () => asm);
check("E11 idempotent on same assembly", asm.sections.filter((s) => s.name === "dsh-reflect-memory").length === 1);

// broken store must not break assembly
const bad = { sections: null };
await listeners[0].fn(bad, {}, async () => ({ survived: true }));
check("E12 listener never throws on odd assembly", true);

// ---- render arity (regression) ----
// The harness calls output.render(args, value): parameter ONE is the call's
// arguments, the validated return value is parameter TWO. Binding the value as
// the first parameter makes every tool silently show the model its own input —
// writes still land, so no other assertion catches it.
const recallOut = await recall.output.render({ scope: "global" }, { file: globalFile, count: 7 });
check("E13 render shows value, not arguments", recallOut.length === 1
  && recallOut[0].text.includes('"count":7') && !recallOut[0].text.includes("scope"));
const recordOut = await rec.output.render({ text: "lesson", scope: "workspace" }, { file: "F", stored: true, count: 2 });
check("E14 record render carries stored/count", recordOut[0].text.includes('"stored":true') && !recordOut[0].text.includes("lesson"));

// ---- F. credential screening ----
// A stored secret is broadcast into every future system prompt, so the screen is
// the one component allowed to say no. Synthetic shapes only — never a real value.
const redact = await import("../lib/redact.js");
const sha = "0f3a9b2c7d1e4f5a6b7c8d9e0f1a2b3c4d5e6f70"; // lowercase hex, digits, no symbol/upper
const vendorKey = "xk_live_" + "9Fj2aB7dQe5rTg8y" + "_Ui3oPq7vWs-EUd";
check("F1 git sha still passes", redact.screen("钉在 rev " + sha + " 之前").hits.length === 0);
check("F2 ordinary prose passes", redact.screen("密钥轮换后要重启 web，配置不热重载 #ops").hits.length === 0);
check("F3 vendor key shape blocked", redact.screen("把 " + vendorKey + " 写进 patch").hits.length > 0);
check("F4 assignment blocked", redact.screen("password: hunter2please").hits[0] === "assignment");
check("F5 bearer blocked", redact.screen("Authorization: Bearer abc123def456ghi").hits.includes("bearer"));
check("F6 pem header blocked", redact.screen("-----BEGIN PRIVATE KEY-----").hits.includes("private-key-block"));
check("F7 url secret blocked", redact.screen("https://api/x?token=abc123def456").hits.includes("url-secret"));
check("F8 base64 blob blocked", redact.screen("Q2hhbmdlVGhpc1RvU29tZXRoaW5nRGlnaXQxMjM0NTY=").hits.includes("high-entropy"));
check("F9 long line clipped", redact.screen("x1 ".repeat(300)).truncated === true && redact.screen("x1 ".repeat(300)).text.length <= 400);
check("F10 refusal never echoes the value", !redact.blockReason(redact.screen(vendorKey).hits).includes(vendorKey));

// ---- G. review queue ----
const pending = await import("../lib/pending.js");
const pf = join(ws, ".dsh", "memory-pending.md");
const memHere = join(ws, ".dsh", "memory.md");
const before = store.readEntries(memHere).length;
check("G1 queue writes source+tags", pending.queuePending(pf, { text: "候选一", tags: ["c"], source: "session-abc@12" }).stored === true
  && readFileSync(pf, "utf8").includes("- 候选一 @src:session-abc@12 #c"));
check("G2 dedup against approved memory", pending.queuePending(pf, { text: "候选一" }, store.readEntries(memHere)).reason === "duplicate");
const g3 = pending.readPending(pf)[0];
check("G3 parse keeps text/tags/source apart", g3.text === "候选一" && g3.tags[0] === "c" && g3.source === "session-abc@12");
check("G4 drop leaves the rest queued", pending.queuePending(pf, { text: "候选二" }).stored === true
  && pending.resolvePending(pf, memHere, [], [2], () => ({ stored: false })).count === 1);
const g5 = pending.resolvePending(pf, memHere, [1], [], (f, t, tags) => store.recordEntry(f, t, tags));
check("G5 approve moves into memory", g5.moved.length === 1 && g5.count === 0 && store.readEntries(memHere).length === before + 1);
check("G6 provenance survives in the backup", !!g5.backup && readFileSync(g5.backup, "utf8").includes("@src:session-abc@12"));
check("G7 stale index is reported, never guessed", pending.resolvePending(pf, memHere, [9], [], () => ({ stored: false })).invalid.join() === "9");

// ---- H. tools + slash command over the same store ----
const pend = registered.find((t) => t.name === "reflect_pending");
check("H1 review command registered once", commandDefs.length === 1 && commandDefs[0].name === "reflect-review" && typeof commandDefs[0].handler === "function");
const globalBefore = store.readEntries(globalFile).length;
const refused = await rec.execute({ text: "记下来：" + vendorKey, scope: "global" });
check("H2 record refuses secrets without writing", refused.stored === false && /credential screen/.test(refused.reason) && store.readEntries(globalFile).length === globalBefore);
const queuedOut = await pend.execute({ action: "queue", scope: "workspace", workspace_dir: ws, text: "命令面复核的候选", source: "session-zzz@9" });
check("H3 queue action works", queuedOut.stored === true && queuedOut.count === 1);
const cmd = commandDefs[0];
const agentHere = { session: { header: { cwd: ws } } };
const approved = await cmd.handler({ rawInput: "approve 1", agent: agentHere, commandId: "c1", attachments: [], signal: undefined });
check("H4 command approves by index", approved.kind === "success" && /入库/.test(approved.text)
  && store.readEntries(memHere).some((e) => e.text === "命令面复核的候选"));
const listed = await cmd.handler({ rawInput: "global list", agent: agentHere, commandId: "c2", attachments: [], signal: undefined });
check("H5 global scope skips the cwd requirement", listed.kind === "success" && /现有 0 条/.test(listed.text));
const noWs = await cmd.handler({ rawInput: "approve 1", agent: {}, commandId: "c3", attachments: [], signal: undefined });
check("H6 command without a cwd errors instead of guessing", noWs.kind === "error" && /global/.test(noWs.text));

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
