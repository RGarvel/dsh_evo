# 自动蒸馏回路 v1 设计（dsh-reflect）

> 状态：设计稿，未实现。写于 spike 实机验证之后（2026-08-28），依据都是本机 rev 29b22c5 上**实测或读源码确认过**的零件，不是推测。

## 0. 先推翻两条假设

1. **`dsh-schedule` 不能当定时蒸馏的触发器。** 它是**会话内提醒器**：schedule 记录只有 `after / at / every(≥300s)` 三类，每条携带一段 `prompt`；到点后它把 prompt 作为「untrusted reminder content」**呈现给人看**，且投递是 session-local——会话不在线就永久 overdue。它不启动 agent turn，也没有全局 cron。（包在盘上 `@deepseek-ai/dsh-schedule@0.1.1-rc.2`，且**未挂载**进本 profile。）
2. **不需要自己接 sqlite。** `sessionQuery` 服务在本进程**已挂载**（`dsh-session-query-sqlite` 只是它的一种实现）。可用面：`listSessions() → {header{version,id,createdAt,cwd?,parentSession?}, live, persisted}`、`readSession(id) → 全量原始事件`、`listEvents(id)/filterEvents(id, filters) → 事件元数据`、`searchEvents({sessionId, query, filters, limit}) → 带 snippet 的全文命中`。注意 **`searchEvents` 是单会话内的 FTS**（必须给 sessionId），跨会话要自己先选候选集。`~/.dsh` 下没搜到 sqlite 文件，索引可能惰性建或在别处——实现前先看它到底给不给全文。

## 1. 回路的四个环节

```
触发 → 选材 → 提炼 → 候选落库(pending) → 复核门 → 正式记忆(注入面)
                                              ↑ redaction 在进 pending 之前
```

### 1.1 触发

事件目录里**没有** "session end" 这类事件（全量确认过）。可用的接缝按性价比排：

| 方案 | 零件 | 优 | 缺 |
|---|---|---|---|
| **A 会话静默**（推荐主路） | `session/event` 折出 `turn/end{kind:'completed'}` + `ctx.timer.debounce(~10min)` | 贴"这一轮刚学到什么"，相关性最高 | 长会话反复触发 → 必须带 `session:<id>@<seq>` 游标，只喂新增区间 |
| **B 每日兜底** | `ctx.timer.interval(...)`（timer 服务随 fiber 自动 dispose，不留悬挂定时器） | 简单，成本可控，能捞到 A 漏的 | 跨重启需自己持久游标（`storage` / `storageDomain`） |
| **C compaction 搭车** | `session/event` 里的 `compaction/start` + `compaction/summary` | 官方已经做过一次蒸馏，摘要白捡 | 只有长会话才有；摘要是"讲了什么"，不是"下次怎么做" |
| D 显式 | `/reflect` 命令、或模型自己 `reflect_record` | 零意外 | 不是自动（=v0 现状） |

推荐 **A 为主 + B 兜底**，C 作为增强输入（与路线图 2 合流）。`turn/end` 的 reason 有 `completed / aborted / blocked / error`：只在 `completed` 上记账，异常收尾的轮次不配被蒸馏。

### 1.2 选材（省钱的关键）

候选会话过滤条件全部来自 header 与事件元数据，**不要 readSession 全量**（原始事件含工具结果，动辄几万 token）：

- `createdAt` 在窗口内，或该会话在窗口内有新事件（后者要靠 `session/event` 记账，别去解析日志）；
- `parentSession` 为空 → 排除子代理会话（否则会把子代理的一次性上下文也蒸进来，自我放大）；
- completed turn 数 ≥ 阈值（默认建议 3），短会话不值得花一次调用；
- 有 `cwd` → 决定候选教训落 global 还是该工作区的 `.dsh/memory.md`。

正文取 `filterEvents` 里 user/assistant 的文本增量，工具调用只保留 tool 名与失败标记（教训大多来自"哪步炸了"）。

### 1.3 提炼

两条路，选前者：

- **`llm.stream(options)` 单发**：无工具、无 agent loop，输入=会话增量摘要 + **现有记忆条目**，输出用结构化 schema 约束成 `{verdict, text, tags, source}` 列表。便宜、可复现、好加超时。
- `subagents.start(name, request)`：只在"需要跨多个会话自己翻日志"的深挖模式里用；贵，且要防子代理乱写文件（给它只读 preset）。

让提炼步骤**看见现有条目**并输出 `new | merge:<idx> | drop` 三态——这就是 v0 缺的语义判重，不必自己上 embedding（本机也没有 embedding 零件）。

### 1.4 落库与复核门（唯一真正危险的一环）

自动回路的失败模式是：**一条错教训被注入此后每一轮系统提示，并被模型当作指令**。所以硬规矩：

1. 候选**只进 `pending.md`，绝不直写 `memory.md`**，每条带来源指针 `session:<id>@<seq>`（可回溯、可撤销）；
2. 复核门：会话活着时用 `userQuestions.ask()`（本机该服务在）弹框逐条批准/丢弃；离线则留在 pending，并在注入段末尾加一行**只报数量不报正文**的提示（"N 条待复核"）；
3. **redaction 在进 pending 之前**：黑名单正则（`api[_-]?key`、`token`、`secret`、`password`、`BEGIN .*PRIVATE KEY`、`lqd_…`、长 base64 串）+ 单条长度上限 + 强制单行。`reflect_record` 走同一条过滤，别只筛自动路；
4. 全局开关进 `settings`（注册一个 `reflect` 命名空间，GUI 可调）：`enabled / autoDistill / minTurns / pendingBudget`。v0 那句"无常 config 面"到此为止——带副作用的自动回路没有开关是不可接受的。

## 2. 注入预算：从字符改 token

`tokenMeter` 服务已挂载（`estimateMessage(message)` / `measure(session, header)`）。注入前把 section 文本包成一条 message 交给它估，超预算时按（标签命中当前任务 > 新近 > 原序）丢弃尾部并指路 `reflect_recall`。现在的 1800 字符是拍脑袋值，且中英混排下误差极大。

## 3. 工作区级注入：**已经可做**（v0 那条"做不到"是错判）

上一会话记的"`AssembleContext` 只有 `{scope, signal}`，没有 cwd → 工作区级注入做不到"，是**只读 `.d.ts` 得出的错判**。源码事实（rev 29b22c5，逐处确认）：

```js
// dsh-agent/lib/index.js:384 —— 注释就写着"agent 与 scope 一起设，避免 agent 级贡献被漏掉"
function assembleContextFor(agent, signal) {
  return { agent, scope: agent, ...(signal ? { signal } : {}) };
}
// dsh-agent-loop/lib/index.js:497  assemble(assembleContextFor(this, signal))
// dsh-system-prompt/lib/index.js:271  text: typeof section.text === "function" ? section.text(context) : section.text
```

即运行时**每个 section provider 与 `system-prompt/assemble` 监听都拿到 `agent`**，`scope` 本身就是 agent 对象；`Session.header` 恒存在，`header.cwd` 就是工作区。官方 `dsh-plan-mode` 就是这么用的（`text: (context) => context.agent === void 0 ? "" : … context.agent.session …`）。**只有 `AssembleContext` 的 .d.ts 漏声明了 `agent` 字段**——类型缺口，不是能力缺口。

所以注入面该从"waterfall 监听 push section"换成注册面：

```js
ctx.systemPrompt.section({
  name: "dsh-reflect-memory",
  order: 950,
  text: (context) => {
    const cwd = context.agent?.session?.header?.cwd;
    return renderInjection(readEntries(GLOBAL_FILE), cwd ? readEntries(join(cwd, WORKSPACE_REL)) : [], { budget });
  },
});
```

比现写法好在三点：dispose 由 `section()` 返回（不用自己管）；重名直接 throw，不需要手写 `some(s => s.name === …)` 幂等判断；也不再依赖 `{global:true}` 那个技巧。

**纪律**：`agent` 未见于类型声明，属可被上游改名/收走的未文档事实 → 一律 `context.agent?.` 可选访问；拿不到就退化成"只注入全局层"（=v0 行为），并自检一次：若首个 agent 求值时 `agent` 为 undefined，用 `ctx.logger` 记一条 warn，别静默退化。

**#4879 的论据相应改写**（比原论据小得多、也更容易被接受）：不再是"请透出 cwd 才能做工作区记忆"，而是"`AssembleContext` 运行时形状比声明丰富（含 `agent`、且 `scope === agent`），请把 `agent?: Agent` 补进类型声明"——否则插件只能依赖未声明字段。

## 4. 切分（每步单独可验，按依赖排序）

1. **探针**（§3 已由源码定案，剩下两件事）：`{global:true}` 的 `session/event` 能否收到所有会话的 `turn/end`；`searchEvents` 在本机是否真有全文（`~/.dsh` 下没搜到 sqlite 文件）。产出：结论写进本文件；
2. **pending + redaction + `/reflect-review` 命令**（先完全不自动）——安全性先立起来，且这步不需要额外重启；
3. 触发器 A + 选材 + `llm.stream` 提炼 → 只写 pending，`settings` 默认关闭；
4. 注入面迁到 `systemPrompt.section()` + 工作区层 + token 预算（`tokenMeter`）+ `new/merge/drop` 合入逻辑；
5. 每日兜底 B + 跨重启游标（`storage`）。

## 5. 明确不做

- **自动直写 memory.md**（无复核门）；
- 用 `workflow` / `ralph` 跑蒸馏：重、不可复现、失败面大，单发 `llm.stream` 够用；
- 把记忆搬进 sqlite 或存储域：markdown 可审、可 diff、可随项目进 git，正是这个 spike 的核心价值；
- 在 `system-prompt/assemble` 监听里做任何 await 网络调用：那是每一轮模型调用的关键路径，慢一次全体等一次（v0 的"监听器绝不抛"纪律要一并守住）。

## 6. 顺带查到的 harness 缺陷（阻塞探针实现方式，需上报）

rev 29b22c5 上，**参数 schema 根节点只有 `oneOf`（或无可解析 `type`）的工具参数会当字符串送达**。两条独立路径复现：

- `cordis_define` 的 `plugin`（`{kind:"new",idPrefix:"probe"}` 与 `{kind:"existing",pluginId:…}` 两种都试了）恒报 `must match exactly one oneOf branch (matched 0)` → **本机构造动态 Cordis 探针插件的路被堵死**，本设计里所有"挂探针工具实测"都得改成源码直读或 profile bundle 装载；
- `mcp__llmquant-data__sec_filing_read` 的 `filing`（同为 oneOf 根）报 `filing must match exactly one of three shapes … do not pass a placeholder string`。

控制组：显式 `type:"object"` 的参数（同一次 `cordis_define` 里的 `code`）从不报错。`cordis_inspect_query` 的 `input`（schema 里没写 `type`）报 `"input" must be an object`，同一个形状。

**另一条同源缺陷（类型与运行时不一致）**：`@deepseek-ai/dsh-system-prompt` 的 `AssembleContext` 只声明 `{scope?, signal?}`，但 `dsh-agent` 的 `assembleContextFor()` 实际返回 `{agent, scope: agent, signal?}`，官方 `dsh-plan-mode` 已在读 `context.agent`。**只读 .d.ts 会得出"工作区级注入做不到"的错误结论**（本 spike v0 就是这么错的，见 §3）。建议上游把 `agent?: Agent` 补进声明。
