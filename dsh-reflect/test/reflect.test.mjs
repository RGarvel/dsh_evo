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
process.env.DSH_REFLECT_GLOBAL_FILE = globalFile;

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
const ctx = { tools: { register: (d) => registered.push(d) }, on: (ev, fn, opts) => listeners.push({ ev, fn, opts }) };
apply(ctx);
check("E1 three tools registered", ["reflect_record", "reflect_recall", "reflect_consolidate"].every((n) => registered.find((t) => t.name === n)));
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

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
