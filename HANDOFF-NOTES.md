# 交接备忘（由旧工作区会话 2026-08-28 迁移而来）

## ⚠️ 误迁与还原记录（先读这条）

上一会话先用 `migrate_workspace` 把旧会话整体迁了进来（生成 `<migrated-session>…`，含全部旧历史）——这**不是**你要的形态，已还原：

- `<migrated-session>` 已归档（历史仍可从归档会话翻查，dsh_evo 侧边栏不再显示）；
- `<target-session>` 已从 `workspace.json` 的归档名单移除（host 无 unarchive API，走了文件层还原，**需要重启 dsh web 才生效**——顺手把频道回绑也带上，prefs 已指回 `<target-session>`）；
- 拷进 dsh_evo 的 17 个旧工作区杂文件与源侧占位 stub 均已删除。

**本工作区的正确用法**：不继承整段旧对话。新开对话=在 GUI 侧边栏于 dsh_evo 工作区点「新建对话」，第一句让模型读本文件即可无缝接手（已验证事实+待办都在下面）。

## dsh-reflect 原型（已装入本机 profile 并实机验证）

本工作区承载 **dsh-reflect**：DSH"文件级自学习回路"的 spike，源码在 `dsh-reflect/`（31/31 测试通过；已挂进 web profile bundle 栈、真会话验证过注入面/工具注册面/写盘面；仍未发布 npm）。下一步的设计稿在 `dsh-reflect/docs/auto-distill-design.md`。

## 已验证的事实（别重复劳动）

- `system-prompt/assemble` 是全局瀑布事件，插件可 push `{name, order, text:string}` section —— spike 的注入面就是它，测试 E9-E12 断言过幂等与异常免疫；
- ❌→✅ **上一会话那条"`AssembleContext` 没有 cwd → 工作区级注入做不到"是错的**（只读了 `.d.ts`）。运行时 `dsh-agent/lib/index.js:384` 的 `assembleContextFor(agent, signal)` 返回 `{agent, scope: agent, signal?}`，`dsh-system-prompt:271` 把它原样交给 `section.text(context)`，官方 `dsh-plan-mode` 就在读 `context.agent.session`。`Session.header.cwd` 恒存在 → **工作区级注入在插件位上就能做**，不需要等 #4879；缺的只是 `AssembleContext` 的类型声明没写 `agent`。教训：**d.ts 不是合同，能力要看调用点**；
- 顺带：注入面更好的形态是 `ctx.systemPrompt.section({name, order, text:(ctx)=>…})`（自带 dispose、重名 throw），不必用 waterfall 监听自己 push；
- `dsh-tools.defineTool` 的 output schema DSL **拒绝** `type:["object","null"]` 数组、拒绝 oneOf 分支里的 `additionalProperties`——可空返回一律改成对象+`skipped` 标记（两连拒已踩，见 README 测试节）；
- 事件监听需 `{global:true}` 才吃到所有 scope 的组装（否则仅本插件 scope，实测按 bundle 插入形态在 host scope 生效）；
- **`output.render` 的签名是 `(args, value)`——返回值在第二个参数**（对照官方 `dsh-tool-fs`）。写成 `render(value)` 时 harness 会把模型的**入参**当结果喂回：工具副作用照常、测试全绿、只有真会话看得出（本次就是靠"recall 返回 `{"scope":"global"}`"识破的）。已在 spike 加 E13/E14 元数回归；
- **本机动态 Cordis 探针插件走不通，且根因已定位成一条通用缺陷**：工具参数 schema 的根节点**只有 `oneOf`／无可解析 `type`** 时，值会被当字符串送达。两处独立复现——`cordis_define` 的 `plugin`（两种分支形态都试，恒报 `matched 0`）、`mcp__llmquant-data__sec_filing_read` 的 `filing`（报"do not pass a placeholder string"）；控制组是显式 `type:"object"` 的 `code` 参数与 `cordis_inspect_query` 的 `input`（schema 没写 type → 报 `must be an object`）。**影响**：想做"临时挂个工具实测"的探针，本机上必须改成 profile bundle 形态（要重启），或者直接读源码。

## 待办（新会话的讨论清单）

1. **实机装载** ✅（2026-08-28 完成）：
   - `dsh-reflect/package.json` 补了 `dsh.bundle.patch: ./cordis.patch.yml` 声明——**没有它 `dsh plugin add` 只当普通依赖装，不进 bundle 层栈**（CLI 有 warning，源码 `dsh/lib/plugin-*.js` reconcile 逻辑）；
   - `dsh plugin --profile web add file:D:/dsh_evo/dsh-reflect` 已跑，profile bundles 末尾已挂 `@garvel/dsh-reflect`；`dsh --profile web --dump-config` 可静态核对合成树里的 `tool-reflect` 层（免重启）；
   - ⚠ profile 侧是**实体拷贝**（pnpm file: 行为）：改源码后 `plugin add` 报 "Already up to date" 不重拷，需手动同步 `~/.dsh/profiles/web/node_modules/@garvel/dsh-reflect/` 下的副本；
   - **重启后实测**：新会话系统提示确实出现 `## Persistent Memory (dsh-reflect)` 段并列出全局条目，三工具都在模型工具表里 → **注入面 + 注册面 + 写盘面全通**（全局 4 条 / 工作区 1 条已核对）；
   - ❇ **唯一遗留**：过程中查出并修好了 `render` 元数 bug（见上），修复已同步进 profile 副本，但**代码只在进程启动时求值 → 需再重启一次**才能看到正常返回值（现在模型收到的仍是入参回显）。下次重启后验一句：`reflect_recall(scope:"global")` 应返回 `{global:{count:N,...},workspace:{...}}` 而不是 `{"scope":"global"}`。
2. 自动蒸馏回路设计 ✅ **已成稿** → `dsh-reflect/docs/auto-distill-design.md`。两条待办假设被推翻/修正：
   - `dsh-schedule` **不是 cron**，是会话内提醒器（after/at/every≥300s，到点把 prompt 当"不可信提醒"给人看，会话不在线就永久 overdue），且未挂载进本 profile → 定时改用 `ctx.timer`（debounce/interval，随 fiber dispose）；
   - 不用碰 sqlite：`sessionQuery` 服务**已挂载**（`listSessions`/`readSession`/`filterEvents`/`searchEvents`），但 `searchEvents` 是**单会话内** FTS，跨会话得自己选候选；
   - 事件目录里**没有** session-end 类事件；可用触发面是 `session/event`（折 `turn/end{completed}`）、`agent/turn-stopping`、`agent/disposed`、`agent/status`；
   - **工作区级注入已定案可做**（见上面那条 ❌→✅）：`context.agent.session.header.cwd`，且更好的形态是 `systemPrompt.section()` 而非瀑布监听；
   - 安全底线：候选只进 `pending.md`，`userQuestions.ask()` 做复核门，redaction 在进 pending 之前，总开关放 `settings` 注册 `reflect` 命名空间。
3. ✅ **注入预算 token 化已做**（结论比预想的简单：harness 给系统提示定价就是 `ceil(len/4)+4`，所以"token 化"=用同一除数，别去调 `tokenMeter.estimateMessage`——它面向会话消息）。剩：语义判重（把现有条目喂给提炼步骤输出 `new/merge/drop`，本机无 embedding 零件）、与 skills 打通（`skills.register` 可挂 provider）；
4. 上游联动，现在有两个候选，**第二个比 #4879 值钱**：
   - #4879：论据要改写——不再是"请透出 cwd"，而是"`AssembleContext` 的 .d.ts 漏声明了运行时一直存在的 `agent` 字段（`assembleContextFor()` 返回 `{agent, scope:agent}`），请补齐"。优先级降；
   - **新报告（建议优先）**：rev 29b22c5 上"参数根 schema 只有 `oneOf`／无可解析 `type` → 值被当字符串送达"，两条独立复现（`cordis_define.plugin` 恒 matched 0、MCP `sec_filing_read.filing`），控制组是显式 `type:"object"`。这条堵死了动态 Cordis 插件的全部入口，比 cwd 严重。
5. 发版决策：@garvel/dsh-reflect 首发用 --tag spike；发布必须你终端跑（EOTP 网页认证）。当前版本 `0.0.1-spike.7`，`files` 已含 `lib`/`docs`/`cordis.patch.yml`/`README`/`LICENSE`，`dsh.bundle` 声明也已就位——发出去的包可直接 `dsh plugin add @garvel/dsh-reflect`。
6. **实现进度（按设计文档 §4 切分）**：
   - 第 1 步探针：`scope→cwd` 那问已由源码定案（见 ❌→✅ 条）；**两个剩的探针已落地为 spike.7 的自证代码**：`session/event` 监听器写 `~/.dsh/reflect/events.jsonl`（`{global:true}`，重启后读文件看 session 分布），`searchEvents` 本机无 SQLite（`SESSION_QUERY_SEARCH_DISABLED`），选材退化为 `listSessions` + `filterEvents`；
   - **第 2 步 ✅ 已落地**（2026-08-28 晚，`0.0.1-spike.3`，56/56 测试）：`lib/redact.js` 凭据筛查（record/consolidate/queue 三条写路径全过闸，拒绝时不回显命中内容，小写 hex git sha 与正常中文不误伤）+ `lib/pending.js` 复核队列（`- text @src:session-x@n #tag` 格式、与配对 memory 文件去重、approve 才入 `memory.md`、每次重写自动 `.bak-` 留痕、序号漂移只报不猜）+ 第 4 个工具 `reflect_pending`（list/queue/approve/drop）+ 人用命令 `/reflect-review [global] [list|approve 1,2|drop 3|clear]`（`ctx.get('commands')` 可选依赖，工作区取 `agent.session.header.cwd`）；
   - **第 4 步 ✅ 终验通过**（同日，`0.0.1-spike.6`，63/63 测试）：注入换成 `ctx.systemPrompt.section({name, order:950, text:(context)=>…})`（源码核对：`PromptSection.order` 必填、`text` 可传 provider、`section()` 自带 disposer、重名直接 throw）；工作区层随 `context.agent?.session?.header?.cwd` 一起注入；预算改 token 口径，但**除数直接取 harness 自己的 `estimateSystemTokens` = `ceil(len/4)+4`**——`dsh-token-meter` 只导出 `TokenMeter` 类，`estimateMessage` 面向会话消息（role framing + 每块 `+4`），拿伪造 Message 去调只会让预算与循环实际计费不一致，所以 4 chars/token 就是契约（`CHARS_PER_TOKEN` 在 store.js）；超限**整行**从尾部丢并声明"还有 N 条未注入"；缺 `agent` 时 `logger.warn` 一次不静默；队列只报条数、内容绝不进提示词（I2 守着）；env 增至五个（`DSH_REFLECT_INJECT_MAX_TOKENS` 默认 600，`_INJECT_MAX_CHARS` 保留为直接覆盖且优先级更高，`_ASSEMBLY_FILE` 默认 `~/.dsh/reflect/assembly.json` 记录每次组装的 `{stage, cwd, global, workspace, pending, chars, budgetChars, assemblies, at}`，`off` 关闭）；**工作区组排在组前**，预算紧时先丢旧的全局教训而非当前项目教训（spike.6 修正，否则工作区总被尾部截断吃掉）；自证探针定位到实机 cwd 是另一工作区目录（不是 dsh_evo），读写路径全证无罪，断点只在那条 cwd 链。
   - **仍不自动**：没有生产者往队列里写东西；全局队列现有一条探针（`commands.register()`/`section()` 自管 dispose 那条），等你 `/reflect-review global approve 1`；
   - **第 3 步回路落地**（`0.0.1-spike.9`，同日）：新增 `lib/distill.js`，包含 `tryDistill(ctx, event, agent)` — 由 `session/event` 监听器在 `turn/end{kind:"completed"}` 时触发（debounce 5min/会话），调用 `sessionQuery.listEvents` + `filterEvents` 提取用户/助手消息，通过 `llm.stream`（复用会话自身的 provider/model）提炼结构化教训，新条目进 `pending.md`（过 redaction），merge/drop 暂不支持自动应用（需人工复核）。**默认关闭**：`DSH_REFLECT_AUTO_DISTILL=on` 才生效。`/reflect-distill` 命令保留为手动入口（spike stub）。
     - `{global:true}` 跨会话 ✅：events.jsonl 同时出现 seq `78691+`（当前会话）和 `69106+`（另一会话），证明监听器能看到所有会话的 turn 流（`turn/start`、`user/message`、`assistant/chunk`、`tool/call`、`tool/result`、`step/end` 等）；
     - `searchEvents` 不可用 ❌：本机无 SQLite 索引（`SESSION_QUERY_SEARCH_DISABLED`），选材退化为 `listSessions` + `filterEvents(sessionId)`；
     - `turn/end{kind:"completed"}` 待确认（turn 还在流式中，待下一会话 turn 结束验证）。**待重启验**：重启后读 `~/.dsh/reflect/events.jsonl`，看 `sessionId` 分布——如果只有当前会话的 id，说明 `{global:true}` 不跨会话；如果有多条不同 sessionId，说明全局监听生效，可以开自动蒸馏回路。
   - **部署纪律**（本轮踩到）：部署副本 `index.js` 与源码差 51 行而 `store.js` 差 0 行（spike.4 一次只同步了一个文件），导致队列提示出现了但工作区没有——**核对固化**：`Compare-Object` 逐文件比所有 `lib/*.js`，且版本号与部署字节一一对应。
   - **env 配置方式**（spike.9–14 踩坑，最终结论）：`DSH_` 前缀被 `dsh-app-boot` 的 `BOOTSTRAP_PREFIXES=["DSH_","XDG_","DYLD_","BASH_FUNC_"]` 拦在 `.env` 外（`loadLayeredEnv` 会抛错拒绝启动），且 sysdm 用户变量要**新开的终端进程**才继承（旧 cmd/Explorer 不刷新，改完只重启 dsh 拿不到）。**最终解法＝哨兵文件**：`resolveAutoDistill()` 认三种来源——`DSH_REFLECT_AUTO_DISTILL=on`（真导出 env）／`REFLECT_AUTO_DISTILL=on`（去前缀名，可进 `~/.dsh/.env`，`loadLayeredEnv` 每次启动都会 apply 非前缀变量）／哨兵文件 `~/.dsh/reflect/auto-distill.on` 存在。哨兵文件我能用工具直接创建，完全绕开 env 继承，是验证期的确定性开关。
   - **turn/end 字段名 bug**（spike.10 修）：`SessionEventMap['turn/end']` 的字段是 `reason`（`'completed'|'aborted'|...'TurnEndReason`），不是 `kind`。distill.js 和 index.js 两处 `event?.kind` 全改成 `event?.reason`。events.jsonl 探针里 `kind` 字段也因此永远为空，后续改用 `reason`。
   - **turn/end reason 嵌套结构 bug**（spike.11 修）：`reason` 字段不是字符串 `"completed"`，而是嵌套对象 `{kind: "completed"}`（见 `TurnEndReasonMap`）。distill.js 和 index.js 两处 `event.reason !== "completed"` 全改成 `event.reason?.kind !== "completed"`。
   - **SessionEvent 包装层 bug**（spike.12 修）：`session/event` 监听器收到的 `event` 是 `SessionEvent` 包装对象（`{ type, seq, time, data }`，探针 `getOwnPropertyNames` 实测），payload 在 `event.data` 里。`reason` 是 `event.data.reason` 不是 `event.reason`。三处修正：index.js 触发条件 + index.js 探针 + distill.js selectCandidate。
   - **distill.js 深层 bug**（spike.14 修）：(a) `listEvents` 返回同样 `{type,data}` 包装，两处 `e.kind==="completed"` 计数永远 0 → 引入 `isCompletedTurnEnd(e)` 容错 helper（同时认 `e.kind` 与 `e.data?.reason?.kind`）。(b) `pendingFile` 用 `process.env.HOME`（Windows 下 undefined → 相对路径）→ 改 `homedir()`。(c) `llm.stream` 的 `purpose:"distill"` 非法（类型只 `compaction|session-title`）→ 删除。(d) hand-built messages 缺 `Message` 要求的 `id`+`source` → 用 `createUserMessage({source:{kind:"user"},content:[...]})`，并把三条 user 合并成一条消息的三个 text block（避免连续同角色）。(e) 全链路加 `distill-debug.log` 探针（listener/每个 bail 点/stream 结果/queued 数），重启一次即知卡在哪。
   - **session/event subject 是 Session 不是 agent**（spike.15 修，探针定位）：debug 日志显示 listener 全部 `AUTO_DISTILL=true reason=completed hasSubject=true`（监听/门限/字段读取全通了），但 tryDistill 抛 `Cannot read properties of undefined (reading 'id')`。根因＝`subject` 是 **Session 实例**（`dsh-agent-loop:48` 官方 listener 写 `if (subject !== session) return`），我错当 agent 写了 `subject.session.id`（多套 `.session`）。Session 自身有 `get id`、`readonly header`（含 `.cwd`）、方法 `requestContext()`（带 provider+model）、`requestHeader()`（带 `.config.provider/model`）。修法：selectCandidate 用 `session.id`/`session.header.cwd`，route 用 `session.requestContext()??requestHeader().config`。注意与 systemPrompt.section 的 `context.agent.session`（那才是 agent，带 .session）区分。
   - **session/event subject 是 Session 不是 agent**（spike.15 修，探针定位）：debug 日志显示 listener 全部 `AUTO_DISTILL=true reason=completed hasSubject=true`（监听/门限/字段读取全通了），但 tryDistill 抛 `Cannot read properties of undefined (reading 'id')`。根因＝`subject` 是 **Session 实例**（`dsh-agent-loop:48` 官方 listener 写 `if (subject !== session) return`），我错当 agent 写了 `subject.session.id`（多套 `.session`）。Session 自身有 `get id`、`readonly header`（含 `.cwd`）、方法 `requestContext()`（带 provider+model）、`requestHeader()`（带 `.config.provider/model`）。修法：selectCandidate 用 `session.id`/`session.header.cwd`，route 用 `session.requestContext()??requestHeader().config`。注意与 systemPrompt.section 的 `context.agent.session`（那才是 agent，带 .session）区分。
   - **listEvents 记录无 data 字段 bug**（spike.16 修）：spike.15 已跑到 `selected session=... cwd=D:\dsh_evo pendingFile=...\memory-pending.md`（subject/route/cwd 全对），但 bail 在 `completed turns before this = 0 < 3`。根因＝`sessionQuery.listEvents` 返回 `SessionEventRecord`（只有 `{sessionId,seq,type,time,surface}`，**无 data**），我却用 `isCompletedTurnEnd` 读 `e.data?.reason?.kind` → 恒 false → 计数 0。修法：改成 `isTurnEnd(e)=e.type==="turn/end"`（completed 性已由监听器上游保证）。另 `filterEvents` 返回 `SessionEventSearchDocument = record + {text}`，fetchTurnContent 取 `d.text` 是对的。
   - **部署时序坑**（spike.15 误判过）：改完 lib/ 后**必须确认 dsh web 进程启动时间晚于文件写盘时间**，否则跑的还是内存里的旧代码（现象：debug 日志标签还是上一版的 `hasAgent` 而非 `hasSubject`）。核对：`(Get-CimInstance Win32_Process -Filter "ProcessId=<PID>").CreationDate` vs `lib/*.js` 的 LastWriteTime。插件不热重载。
   - **验证状态**（spike.16 部署后，待最后一轮）：`MIN_COMPLETED_TURNS` 临时降为 1（可用 env `REFLECT_MIN_TURNS` 覆盖），新会话第 2 个完成 turn 即触发。待重启→**在同一新会话连发 2–3 条消息**→读 `distill-debug.log`：应见 `selected` → `route provider=… model=…` → `streamed response chars=…` → `done: queued N`，且 `D:\dsh_evo\.dsh\memory-pending.md`（工作区层）出现 `@src:...@distill` 行＝端到端跑通。若 bail 在 `no LLM route` 则 route 解析再调；`stream failed` 则网络/额度；`not JSON` 则收紧 PROMPT 输出约束。哨兵文件 `~/.dsh/reflect/auto-distill.on` 在＝开关生效。

## 环境常量

- 本机 dsh：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`（rev 29b22c5）；GUI http://127.0.0.1:3080；
- 依赖解析：`dsh-reflect/node_modules/@deepseek-ai/{dsh-tools,dsh-llm}` 是指向上述树的 junction（`.gitignore` 已排除 node_modules）；
- 相关仓库（本机另见）：GUI spike · RFC-0001 · workspace-migrate 工具（0.1.6 已发布，本工作区就是用它迁过来的）。
