# 交接备忘（由 D:\rp 会话 2026-08-28 迁移而来）

## ⚠️ 误迁与还原记录（先读这条）

上一会话先用 `migrate_workspace` 把 rp 会话整体迁了进来（生成 `session-e06fac5b…`，含全部 rp 历史）——这**不是**你要的形态，已还原：

- `e06fac5b` 已归档（历史仍可从归档会话翻查，dsh_evo 侧边栏不再显示）；
- b95d03d5 已从 `workspace.json` 的归档名单移除（host 无 unarchive API，走了文件层还原，**需要重启 dsh web 才生效**——顺手把 QQ 回绑也带上，prefs 已指回 b95d）；
- 拷进 dsh_evo 的 17 个 rp 杂文件与 rp 侧占位 stub 均已删除。

**本工作区的正确用法**：不继承整段 rp 对话。新开对话=在 GUI 侧边栏于 dsh_evo 工作区点「新建对话」，第一句让模型读本文件即可无缝接手（已验证事实+待办都在下面）。

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
3. 注入预算 token 化（**零件已确认在**：`tokenMeter` 服务已挂载，有 `estimateMessage`）、语义判重（把现有条目喂给提炼步骤输出 `new/merge/drop`，本机无 embedding 零件）、与 skills 打通（`skills.register` 可挂 provider）；
4. 上游联动，现在有两个候选，**第二个比 #4879 值钱**：
   - #4879：论据要改写——不再是"请透出 cwd"，而是"`AssembleContext` 的 .d.ts 漏声明了运行时一直存在的 `agent` 字段（`assembleContextFor()` 返回 `{agent, scope:agent}`），请补齐"。优先级降；
   - **新报告（建议优先）**：rev 29b22c5 上"参数根 schema 只有 `oneOf`／无可解析 `type` → 值被当字符串送达"，两条独立复现（`cordis_define.plugin` 恒 matched 0、MCP `sec_filing_read.filing`），控制组是显式 `type:"object"`。这条堵死了动态 Cordis 插件的全部入口，比 cwd 严重。
5. 发版决策：@garvel/dsh-reflect 首发用 --tag spike；发布必须你终端跑（EOTP 网页认证）。注意 npm 发布物 `files` 已含 cordis.patch.yml，`dsh.bundle` 声明也已就位——发出去的包可直接 `dsh plugin add @garvel/dsh-reflect`。

## 环境常量

- 本机 dsh：`C:\Users\阮家威\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`（rev 29b22c5）；GUI http://127.0.0.1:3080；
- 依赖解析：`dsh-reflect/node_modules/@deepseek-ai/{dsh-tools,dsh-llm}` 是指向上述树的 junction（`.gitignore` 已排除 node_modules）；
- 相关仓库：`D:\dsh-channel-view`（GUI spike）· `D:\dsh-channel-spec`（RFC-0001）· `D:\movedsh\dsh-tool-workspace-migrate`（0.1.6 已发布，本工作区就是用它迁过来的）。
