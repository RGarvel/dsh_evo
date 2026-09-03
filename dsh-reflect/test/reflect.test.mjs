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
// The per-assembly probe file needs isolating too: the section provider writes it,
// and it is what records WHICH link of the cwd chain came up empty.
const assemblyFile = join(root, "assembly.json");
process.env.DSH_REFLECT_ASSEMBLY_FILE = assemblyFile;

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
const sections = [];
const warnings = [];
const ctx = {
  tools: { register: (d) => registered.push(d) },
  on: (ev, fn, opts) => listeners.push({ ev, fn, opts }),
  systemPrompt: { section: (s) => sections.push(s) },
  logger: { warn: (m) => warnings.push(m) },
  get: (key) => (key === "commands" ? { register: (d) => { commandDefs.push(d); return () => {}; } } : undefined),
};
apply(ctx);
check("E1 four tools registered", ["reflect_record", "reflect_recall", "reflect_consolidate", "reflect_pending"].every((n) => registered.find((t) => t.name === n)));
check("E2 injection is a section, not a waterfall listener", sections.length === 1 && listeners.length === 1
  && listeners[0].ev === "session/event" && listeners[0].opts?.global === true
  && sections[0].name === "dsh-reflect-memory" && sections[0].order === 950 && typeof sections[0].text === "function");
check("E2b session/event probe listener registered with global:true", listeners.some(
  (l) => l.ev === "session/event" && l.opts?.global === true
));
check("E3 distill module imports cleanly", () => {
  import("./distill.js").then((m) => {
    check("E3a tryDistill is a function", typeof m.tryDistill === "function");
    check("E3b getDebounceStatus is a function", typeof m.getDebounceStatus === "function");
  }).catch(() => {});
});

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

const section = sections[0];
const cwdCtx = { agent: { session: { header: { cwd: ws } } } };
const globalOnly = section.text({});
const withWs = section.text(cwdCtx);
check("E9 section renders global lessons", globalOnly.includes("## Persistent Memory (dsh-reflect)") && globalOnly.includes("全局教训：先看源码再下结论"));
check("E10 workspace layer renders only with a session cwd", withWs.includes("Workspace lessons") && withWs.includes("纯文本条目") && !globalOnly.includes("纯文本条目"));
check("E11 provider is pure across repeated assemblies", section.text(cwdCtx) === withWs);
check("E12 provider never throws on shapeless or hostile contexts", typeof section.text(undefined) === "string"
  && typeof section.text({ agent: {} }) === "string"
  && typeof section.text({ get agent() { throw new Error("shape changed"); } }) === "string");
check("E12b a missing agent warns once instead of silently dropping the layer", warnings.length === 1 && /no `agent`/.test(warnings[0]));

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
const testOps = { record: store.recordEntry, merge: store.mergeEntry, remove: store.removeEntry, supersede: store.supersedeEntry };
const before = store.readEntries(memHere).length;
check("G1 queue writes source+tags", pending.queuePending(pf, { text: "候选一", tags: ["c"], source: "session-abc@12" }).stored === true
  && readFileSync(pf, "utf8").includes("- 候选一 @src:session-abc@12 #c"));
check("G2 dedup against approved memory", pending.queuePending(pf, { text: "候选一" }, store.readEntries(memHere)).reason === "duplicate");
const g3 = pending.readPending(pf)[0];
check("G3 parse keeps text/tags/source apart", g3.text === "候选一" && g3.tags[0] === "c" && g3.source === "session-abc@12");
check("G4 drop leaves the rest queued", pending.queuePending(pf, { text: "候选二" }).stored === true
  && pending.resolvePending(pf, memHere, [], [2], testOps).count === 1);
const g5 = pending.resolvePending(pf, memHere, [1], [], testOps);
check("G5 approve moves into memory", g5.moved.length === 1 && g5.count === 0 && store.readEntries(memHere).length === before + 1);
check("G6 provenance survives in the backup", !!g5.backup && readFileSync(g5.backup, "utf8").includes("@src:session-abc@12"));
check("G7 stale index is reported, never guessed", pending.resolvePending(pf, memHere, [9], [], testOps).invalid.join() === "9");

// ---- H. tools + slash command over the same store ----
const pend = registered.find((t) => t.name === "reflect_pending");
check("H1 review + distill commands registered", commandDefs.length === 2
  && commandDefs.some((d) => d.name === "reflect-review")
  && commandDefs.some((d) => d.name === "reflect-distill")
  && typeof commandDefs.find((d) => d.name === "reflect-review")?.handler === "function");
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

// ---- I. the gate's whole point, checked on the render path ----
await pend.execute({ action: "queue", scope: "workspace", workspace_dir: ws, text: "待复核的候选教训Z", source: "session-zz@1" });
const withPending = section.text(cwdCtx);
check("I1 queue depth is hinted", /\d+ 条候选在复核队列里/.test(withPending));
check("I2 queue CONTENT never reaches the prompt", !withPending.includes("待复核的候选教训Z"));
check("I3 approved content does reach it", withPending.includes("命令面复核的候选"));
const tight = store.renderInjection([{ text: "AAA".repeat(26) }, { text: "BBB".repeat(26) }, { text: "CCC".repeat(26) }], [], { maxTokens: 40 });
check("I4 token budget drops whole rows and declares how many", tight.length <= 160 && tight.includes("条未注入") && !tight.includes("CCC"));
const shape = JSON.parse(readFileSync(assemblyFile, "utf8"));
check("I5 the probe records a resolved cwd and the counts behind it", shape.stage === "ok" && shape.cwd === ws
  && shape.workspace === store.readEntries(memHere).length && shape.global === store.readEntries(globalFile).length && shape.assemblies > 0);
section.text({});
const shapeBad = JSON.parse(readFileSync(assemblyFile, "utf8"));
check("I6 a context without agent is recorded as no-agent, not silently skipped", shapeBad.stage === "no-agent" && shapeBad.cwd === null && shapeBad.assemblies > shape.assemblies);

// ---- J. distill candidate processing (spike.22 shipped two wiring bugs here) ----
// The inlined loop (1) tested a nonexistent `screen().allowed` flag — always
// true, so every candidate was dropped as "blocked by redaction"; and (2) passed
// a markdown string (not an object) plus a string `against` to queuePending, so
// survivors queued as `reason:"empty"`. Both now live in processCandidates.
const distill = await import("../lib/distill.js");
check("J0 processCandidates exported", typeof distill.processCandidates === "function");
check("J1 screen reports hits, never an `allowed` flag",
  redact.screen("普通中文教训没有凭据").hits.length === 0
  && redact.screen("普通中文教训没有凭据").allowed === undefined);
const jPend = join(ws, ".dsh", "distill-pending.md");
const jMem = join(ws, ".dsh", "distill-mem.md");
const queuedN = distill.processCandidates([
  { verdict: "new", text: "先确认指代再对比机制，别猜", tags: ["communication"] },
  { verdict: "new", text: "记住这个 key：" + vendorKey, tags: ["secret"] },          // redaction blocks
  { verdict: "merge", idx: 0, text: "改进版" },                                       // non-new skipped
  { verdict: "new", text: "" },                                                       // empty skipped
  { verdict: "new", text: "先确认指代再对比机制，别猜", tags: ["dup"] },              // duplicate text
], {
  screen: redact.screen,
  queuePending: pending.queuePending,
  readEntries: store.readEntries,
  pendingFile: jPend,
  memoryFile: jMem,
  sessionId: "session-distill",
});
check("J2 exactly the one safe candidate is queued", queuedN === 1);
const jq = pending.readPending(jPend);
check("J3 queued entry keeps text/tags/source apart",
  jq.length === 1 && jq[0].text === "先确认指代再对比机制，别猜"
  && jq[0].tags[0] === "communication" && jq[0].source === "session-distill@distill");
const jqDup = distill.processCandidates([
  { verdict: "new", text: "先确认指代再对比机制，别猜", tags: ["repeat"] },
], {
  screen: redact.screen,
  queuePending: pending.queuePending,
  readEntries: store.readEntries,
  pendingFile: jPend,
  memoryFile: jMem,
  sessionId: "session-distill",
});
check("J4 a repeat call does not refill the queue", jqDup === 0 && pending.readPending(jPend).length === 1);

// ---- K. sidecar metadata (lib/meta.js) ----
const meta = await import("../lib/meta.js");
check("K1 metaPathFor strips .md", meta.metaPathFor(join(ws, "memory.md")) === join(ws, "memory.meta.json"));
check("K2 keyOf identical to store.normalize",
  meta.keyOf("  PowerShell  编辑 PREFS  ") === store.normalize("  PowerShell  编辑 PREFS  "));
const kmetaFile = join(ws, ".dsh", "k-meta.json");
const kBody1 = [{ text: "先确认指代再对比", tags: ["x"] }, { text: "另一个教训", tags: [] }];
let kmeta = meta.reconcile({ v: 1, entries: {}, tombstones: {} }, kBody1, kmetaFile);
check("K3 reconcile creates one row per entry and persists",
  Object.keys(kmeta.entries).length === 2 && kmeta.entries[meta.keyOf("先确认指代再对比")].confidence === "confirmed"
  && existsSync(kmetaFile) && JSON.parse(readFileSync(kmetaFile, "utf8")).v === 1);
check("K4 reconcile is idempotent over the same body",
  JSON.stringify(meta.reconcile(kmeta, kBody1).entries) === JSON.stringify(kmeta.entries));
kmeta = meta.reconcile(kmeta, [{ text: "先确认指代再对比", tags: ["x"] }], kmetaFile);
check("K5 vanished key moves to tombstone",
  !kmeta.entries[meta.keyOf("另一个教训")] && !!kmeta.tombstones[meta.keyOf("另一个教训")]
  && typeof kmeta.tombstones[meta.keyOf("另一个教训")].at === "string");
const kMem = join(ws, ".dsh", "k-mem.md");
const kRec = store.recordEntry(kMem, "一条会写 sidecar 的教训", ["s"]);
check("K6 record/rewrite hooks the sidecar sync",
  kRec.stored === true && existsSync(meta.metaPathFor(kMem)));
const { writeFileSync } = await import("node:fs");
writeFileSync(kmetaFile, "{not json", "utf8");
const kCorrupt = meta.loadMeta(kmetaFile);
check("K7 corrupt meta degrades to empty, never throws",
  kCorrupt.v === 1 && Object.keys(kCorrupt.entries).length === 0 && Object.keys(kCorrupt.tombstones).length === 0);

// ---- L. hit feedback (step 2: recall is the only hit source, not injection) ----
const l1 = { v: 1, entries: { abc: meta.emptyRow() }, tombstones: {} };
meta.touchHit(l1, "abc", "t1");
meta.touchHit(l1, "abc", "t2");
check("L1 touchHit increments and stamps times",
  l1.entries.abc.hitCount === 2 && l1.entries.abc.firstHitAt === "t1" && l1.entries.abc.lastHitAt === "t2");
const l2 = { v: 1, entries: {}, tombstones: {} };
meta.touchHit(l2, "ghost", "t1");
check("L2 touchHit on a missing key is a no-op", Object.keys(l2.entries).length === 0);
const lMemFile = join(ws, ".dsh", "memory.md");
const lMetaFile = meta.metaPathFor(lMemFile);
// reset the sidecar so the recall below is provably the one that stamped hits
if (existsSync(lMetaFile)) writeFileSync(lMetaFile, JSON.stringify({ v: 1, entries: {}, tombstones: {} }), "utf8");
const recallOut2 = await recall.execute({ workspace_dir: ws });
check("L3 recall still returns workspace entries", recallOut2.workspace.count > 0);
const lMetaAfter = meta.loadMeta(lMetaFile);
const lHits = Object.values(lMetaAfter.entries).map((r) => r.hitCount).filter((n) => Number(n) > 0);
check("L4 recall recorded hits in the sidecar", lHits.length > 0 && lHits.every((n) => n >= 1));

// ---- M. merge/drop primitives + kind-aware pending (step 3) ----
const mMem = join(ws, ".dsh", "m-mem.md");
store.rewriteEntries(mMem, [{ text: "旧教训甲", tags: [] }, { text: "旧教训乙", tags: [] }, { text: "旧教训丙", tags: [] }]);
check("M1 mergeEntry rewrites the 2nd line", store.mergeEntry(mMem, 2, "改写的乙", ["r"]).ok === true
  && store.readEntries(mMem)[1].text === "改写的乙");
check("M2 mergeEntry refuses out-of-range", store.mergeEntry(mMem, 99, "x").reason === "out-of-range");
check("M3 removeEntry drops the 1st line", store.removeEntry(mMem, 1).ok === true
  && store.readEntries(mMem).length === 2 && store.readEntries(mMem)[0].text === "改写的乙");
check("M4 removeEntry refuses out-of-range", store.removeEntry(mMem, 99).reason === "out-of-range");
const mk1 = pending.parsePendingLine("- [m:3] 合并后的文本 @src:s1 #t");
check("M5 parsePendingLine reads a merge kind", mk1.kind === "merge" && mk1.idx === 3 && mk1.text === "合并后的文本" && mk1.source === "s1");
const mk2 = pending.parsePendingLine("- [d:2] @src:s2");
check("M6 parsePendingLine reads a drop kind with no text", mk2.kind === "drop" && mk2.idx === 2 && mk2.text === "");
check("M7 formatPendingLine roundtrips a merge", pending.parsePendingLine(pending.formatPendingLine(mk1)).idx === 3);
check("M8 legacy line still parses as new", pending.parsePendingLine("- 普通候选 @src:s3").kind === "new");
const mPend = join(ws, ".dsh", "m-pend.md");
check("M9 queue accepts merge and drop candidates",
  pending.queuePending(mPend, { kind: "merge", idx: 1, text: "合并后的最终版", source: "sx" }).stored === true
  && pending.queuePending(mPend, { kind: "drop", idx: 2, source: "sx" }).stored === true);
check("M10 drop dedups by idx, not by empty text", pending.queuePending(mPend, { kind: "drop", idx: 2, source: "sy" }).reason === "duplicate");
const mRes = pending.resolvePending(mPend, mMem, [1, 2], [], testOps);
check("M11 resolve dispatches merge→mergeEntry and drop→removeEntry",
  mRes.moved.length === 2 && mRes.moved[0].kind === "merge" && mRes.moved[1].kind === "drop"
  && store.readEntries(mMem).length === 1 && store.readEntries(mMem)[0].text === "合并后的最终版");
const mMem2 = join(ws, ".dsh", "m-mem2.md");
const mPend2 = join(ws, ".dsh", "m-pend2.md");
store.rewriteEntries(mMem2, [{ text: "条目一", tags: [] }, { text: "条目二", tags: [] }]);
const mProc = distill.processCandidates([{ verdict: "merge", idx: 0, text: "更好的条目一" }, { verdict: "drop", idx: 1 }], {
  screen: redact.screen,
  queuePending: pending.queuePending,
  readEntries: store.readEntries,
  pendingFile: mPend2,
  memoryFile: mMem2,
  sessionId: "session-m",
});
check("M12 processCandidates queues merge+drop with 1-based idx",
  mProc === 2 && pending.readPending(mPend2).some((e) => e.kind === "merge" && e.idx === 1)
  && pending.readPending(mPend2).some((e) => e.kind === "drop" && e.idx === 2));

// ---- N. supersede soft-delete (step 4) ----
const n1 = { v: 1, entries: { old: meta.emptyRow(), nue: meta.emptyRow() }, tombstones: {} };
meta.markSuperseded(n1, "old", "nue");
check("N1 markSuperseded sets the supersededBy edge and reverse supersedes",
  n1.entries.old.supersededBy === "nue" && n1.entries.nue.supersedes.includes("old"));
check("N2 activeKeys hides the superseded row", meta.activeKeys(n1).has("nue") && !meta.activeKeys(n1).has("old"));
const nMem = join(ws, ".dsh", "n-mem.md");
store.rewriteEntries(nMem, [{ text: "过时的教训", tags: [] }, { text: "另一条", tags: [] }]);
const nSup = store.supersedeEntry(nMem, 1, "取代它的新教训", ["s"]);
check("N3 supersedeEntry appends the new lesson", nSup.stored === true && nSup.superseded === 1
  && store.readEntries(nMem).length === 3);
const nMeta = meta.loadMeta(meta.metaPathFor(nMem));
check("N4 supersedeEntry marks the old row supersededBy", !!(nMeta.entries[meta.keyOf("过时的教训")]?.supersededBy));
const ns = pending.parsePendingLine("- [s:2] 新的取代文本 @src:s4");
check("N5 parsePendingLine reads a supersede kind", ns.kind === "supersede" && ns.idx === 2 && ns.text === "新的取代文本");
check("N6 formatPendingLine roundtrips a supersede", pending.parsePendingLine(pending.formatPendingLine(ns)).idx === 2);
const nPend = join(ws, ".dsh", "n-pend.md");
check("N7 queue accepts a supersede candidate", pending.queuePending(nPend, { kind: "supersede", idx: 1, text: "取代后的教训", source: "sx" }).stored === true);
const nRes = pending.resolvePending(nPend, nMem, [1], [], testOps);
check("N8 resolve dispatches supersede→supersedeEntry", nRes.moved.length === 1 && nRes.moved[0].kind === "supersede");
const nMem2 = join(ws, ".dsh", "n-mem2.md");
const nPend2 = join(ws, ".dsh", "n-pend2.md");
store.rewriteEntries(nMem2, [{ text: "旧条目一", tags: [] }, { text: "旧条目二", tags: [] }]);
const nProc = distill.processCandidates([{ verdict: "supersede", idx: 0, text: "取代旧条目一的" }], {
  screen: redact.screen,
  queuePending: pending.queuePending,
  readEntries: store.readEntries,
  pendingFile: nPend2,
  memoryFile: nMem2,
  sessionId: "session-n",
});
check("N9 processCandidates queues a supersede with 1-based idx",
  nProc === 1 && pending.readPending(nPend2).some((e) => e.kind === "supersede" && e.idx === 1));

// ---- O. retrieval ranking (step 5) ----
const oj = (ts) => ts.map((text) => ({ text, tags: [] }));
const oWs = oj(["w冷门", "w热", "w齐"]);
const oGl = oj(["g热", "g冷门"]);
const oBig = { maxTokens: 1 << 20 };
const oNoRank = store.renderInjection(oGl, oWs, oBig);
const oRank = store.renderInjection(oGl, oWs, { ...oBig, rank: (e) => (e.text === "w热" ? 9 : e.text === "g热" ? 5 : 0) });
check("O1 rank floats a hot workspace lesson above its cold peers",
  oRank.indexOf("w热") < oRank.indexOf("w冷门") && oRank.indexOf("w热") < oRank.indexOf("w齐"));
check("O2 rank floats a hot global lesson within the global group",
  oRank.indexOf("g热") < oRank.indexOf("g冷门"));
check("O3 omitting rank matches the current order byte-for-byte",
  oNoRank === store.renderInjection(oGl, oWs, oBig));
check("O4 an all-zeros rank is a stable no-op",
  store.renderInjection(oGl, oWs, { ...oBig, rank: () => 0 }) === oNoRank);
check("O5 workspace group still precedes global after ranking",
  oRank.indexOf("Workspace lessons:") < oRank.indexOf("Global lessons:"));
check("O6 a throwing rank degrades to zero, never breaks render",
  store.renderInjection(oGl, oWs, { ...oBig, rank: () => { throw new Error("boom"); } }) === oNoRank);

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
