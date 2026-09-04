# @garvel/dsh-reflect

> 给 DeepSeek Harness 补上"越用越顺手"的自动回路（spike v0）
>
> 仓库：[github.com/RGarvel/dsh_evo](https://github.com/RGarvel/dsh_evo)

DSH 的模型权重永远冻结，它的"学习"只能是**文件级外部记忆**。官方零件里有三层——会话内压缩（`dsh-compaction`）、项目指令（`dsh-agent-instructions`）、技能沉淀（`dsh-skill-filesystem`）——但缺一环：**没有"会话自动回看→提炼→写回"的蒸馏回路**。本插件把最小可用版本立起来：模型自己就是那台"蒸馏机"，插件提供存储、读写面和注入面。

## 机制（四工具 + 一命令 + 一注入）

| 面 | 说明 |
|---|---|
| `reflect_record` | 追加一条"耐久经验"（决策依据/验证过的命令/坑/偏好），按归一化文本去重。落盘 markdown，一行一条，尾部 `#tag`。**先过凭据筛查**，命中即拒（`reason: "blocked by credential screen (…)"`）且不回显内容 |
| `reflect_recall` | 读取全局 + 工作区两层记忆（文件缺失=空） |
| `reflect_consolidate` | **模型驱动的整表重写**：合并/删陈/压缩。重写前自动 `memory.md.bak-<时间戳>` 备份，激进整理零风险。逐条过筛查，命中者剔除并回报 `blocked` 数 |
| `reflect_pending` | **复核队列**：`list` / `queue` / `approve` / `drop`。候选先进队列，**不参与任何 prompt 组装**，只有被批准后才落入 `memory.md`。每条带 `@src:session-<id>@<seq>` 溯源指针 |
| `/reflect-review` | 同一队列的人用出口（不经模型）：`/reflect-review [global] [list \| approve 1,2 \| drop 3 \| clear]`。工作区路径取自会话 `header.cwd` |
| 凭据筛查 `lib/redact.js` | 写盘前的硬闸：`password: …` 式赋值、`Bearer …`、PEM 头、URL 里的 `?token=`、云 AK 形状、以及"≥24 字符且同时含数字与大写/符号"的高熵串。刻意**不**误伤小写十六进制 git sha，也不管中文里正常提到"密钥/token"；拒绝时绝不回显命中内容，长度上限 400 字符（超出截断并报 `truncated`） |
| 注入 seam | `ctx.systemPrompt.section({name, order: 950, text: (context) => …})`——**provider 形态，每轮组装实时读盘**。拿 `context.agent.session.header.cwd` 定位工作区，所以**全局层 + 工作区层一起注入**；dispose 由 registry 管，重名直接 throw（不再手写幂等判断，也不用 `{global:true}` 那个技巧）。预算按 token 计（`maxTokens`，默认 600 → 与 harness 自己的 `ceil(len/4)` 同除数），超限**整行从尾部丢**并写明"还有 N 条未注入"，绝不静默截半句。provider 全程 try/catch：记忆坏掉、`agent` 字段被上游收走，都不能弄崩模型请求；退化时 `logger.warn` **一次**，不静默 |

存储约定：

- 全局：`~/.dsh/reflect/memory.md`（`DSH_REFLECT_GLOBAL_FILE`）+ 队列 `~/.dsh/reflect/pending.md`（`DSH_REFLECT_GLOBAL_PENDING`）
- 工作区：`<cwd>/.dsh/memory.md`（随项目进 git，团队共享）+ 队列 `<cwd>/.dsh/memory-pending.md`
- 队列与记忆**一对一配对**（全局队列→全局记忆，工作区队列→该工作区记忆），所以批准时不需要在条目里再存 scope

## 它刻意不是什么（v0 边界）

- **自动蒸馏默认关闭**：沉淀/整理由模型按注入规约主动调用（或你一句"把今天的坑记下来"）。自动蒸馏回路已落地（`session/event` 折 `turn/end{completed}` → 提炼 → 候选**只进** `pending.md`，绝不直写 `memory.md`），但默认 `off`——用 `settings` 的 `reflect.autoDistill`，或 env `REFLECT_AUTO_DISTILL=on` / 哨兵文件 `~/.dsh/reflect/auto-distill.on` 打开；
- **不读会话历史**：v0 不做"会话结束自动回看 transcript 蒸馏"。零件其实齐了——`sessionQuery` 服务（`listSessions`/`filterEvents`/`searchEvents`）+ `llm.stream` 单发提炼 + `ctx.timer` 静默去抖，缺的是策略与安全门，见 `docs/auto-distill-design.md`；
- ~~workspace 层只写不注入~~ **已修**：注入改为 per-session provider，工作区层跟着 `header.cwd` 进提示词。留这条是为了记成因——早先那句"`AssembleContext` 拿不到 cwd"是**只读 `.d.ts` 的错判**：运行时 `assembleContextFor()` 一直把 `agent` 塞在 context 里（`scope === agent`），官方 plan-mode 就在用。**`.d.ts` 不是契约，看调用点**；
- **不自称精确 token 计数**：预算除数直接取 harness 自己的 `estimateSystemTokens`（`ceil(len/4) + 4`），没有 embedding、没有 tiktoken。曾打算调 `tokenMeter.estimateMessage()`，读完源码放弃——那是面向**会话消息**的（要 role framing、`+4` per block），拿伪造 Message 喂它只会让预算和循环实际计费不一致；
- 去重是精确归一化匹配，不做语义判重（语义判重=consolidate 的活）；
- config 面两层：**正式开关在 `settings`**——`reflect` 命名空间（GUI 可调），字段 `enabled` / `autoDistill` / `minTurns` / `pendingBudget`（默认 `enabled=true`、其余 `off`/`3`/`50`）。env 仍是尖峰验证/紧急覆盖（`DSH_REFLECT_GLOBAL_FILE` / `_GLOBAL_PENDING` / `_INJECT_MAX_TOKENS` / `_INJECT_MAX_CHARS` / `REFLECT_AUTO_DISTILL` / `REFLECT_MIN_TURNS`）。三个诊断探针**默认全关**（opt-in，显式给路径才写）：`DSH_REFLECT_ASSEMBLY_FILE`（注入面取证，`stage` 点名 cwd 链断在哪一格）、`DSH_REFLECT_EVENT_LOG`（逐事件 jsonl）、`DSH_REFLECT_DEBUG_FILE`（蒸馏门控 trace）。settings 服务未挂载时自动回退 env，任意组装都能跑（详见设计文档 §1.4）。

## 测试

```
npm test
```

109 项断言（含探针自身的 I5/I6：解析成功时记下真实 cwd，缺 agent 时记下 `no-agent` 而不是静默少一层）：store 纯逻辑（解析/标签/去重/备份/渲染/截断）+ 真实 `dsh-tools.defineTool` 注册烟雾（其 schema DSL 连拒两版后的合规写法本身是成果）+ 假 ctx 全链路（record→consolidate→recall→注入 section）+ **render 元数回归**（E13/E14）+ **凭据筛查**（F1-F10，含"git sha 与正常中文不许误伤""拒绝时不许回显"两条反例）+ **队列**（G1-G7：溯源、配对去重、批准迁移、备份留痕、序号漂移只报不猜）+ **工具与 `/reflect-review` 共用同一存储**（H1-H6）+ **注入面**（E9-E12b：工作区层只在有 cwd 时出现、provider 对畸形/敌意 context 不抛、缺 `agent` 只 warn 一次；I1-I4：队列只报条数不报内容、token 预算整行裁剪）。

> 本机 `npm test` 会被执行策略拦（`npm.ps1 cannot be loaded`），直接 `node test/reflect.test.mjs`。

> 坑（实机才暴露）：harness 的 `output.render(args, value)` **第一参是入参、返回值在第二位**。早期写成 `render = (value) => JSON.stringify(value)`，工具于是把**模型自己的入参**当成结果回显——写盘照常成功、测试全绿，只有真会话能看出来。签名对照见官方 `dsh-tool-fs` 的 `render: (_args, value) => …`。

`node_modules/@deepseek-ai/{dsh-tools,dsh-llm,dsh-settings,schemastery}` 是指向已安装 dsh 的 **junction**（开发形态，发布物走 peerDependencies）。

## 安装（本机 DSH）

```
dsh plugin --profile web add file:<path-to-this-repo>   # 或 npm 发布后 @garvel/dsh-reflect
# 然后杀掉 web 进程、重新 `dsh web`（CLI 没有 restart 子命令；配置与插件不热重载）
```

两个前提：

- `package.json` 必须声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`——缺它 `dsh plugin add` 只当**普通依赖**装进 profile，不进 bundle 层栈（CLI 会 warning 一句，很容易被忽略）；
- `file:` 依赖在 pnpm 下是**实体拷贝**，改源码后 `plugin add` 报 "Already up to date" 不重拷：要么手动同步 `~/.dsh/profiles/web/node_modules/@garvel/dsh-reflect/`，要么先 `plugin remove` 再 add。装载结果可用 `dsh --profile web --dump-config` 静态核对（看合成树里有没有 `tool-reflect` 层，不必重启）。

## 路线图

**详细设计已成稿**：[`docs/auto-distill-design.md`](docs/auto-distill-design.md)（触发/选材/提炼/复核四环节，附零件清单与实测过的服务面）。骨架：

1. **自动蒸馏**（✅ 已落地，默认 off）：`session/event` 折 `turn/end{completed}` + 5 分钟去抖 → `sessionQuery` 选候选会话 → `llm.stream` 单发提炼 → 候选进 `pending.md`。两个探针已定案：`{global:true}` 监听确实收到所有会话的 `turn/end`（events.jsonl probe）；`searchEvents` 本机无 SQLite 全文（选材用 `listSessions`+`filterEvents`）。开关走 `settings`（`reflect.autoDistill`）＋ env/哨兵覆盖；
2. **复核门**：队列 + `/reflect-review` + 凭据筛查 + `settings` 总开关已就位（第 4 个工具那节）。剩一件锦上添花：`userQuestions.ask()` 把批准变成一次点击式提问；
3. ✅ **注入面迁移**（已完成）：`assemble` 监听 → `systemPrompt.section()` provider，工作区层注入随之打通；预算改 token 口径（harness 同除数）；**工作区组排在组前**，预算紧时先丢旧的全局教训而非当前项目教训；
4. compaction 搭车（`compaction/summary` 事件是白捡的输入）、语义判重（`new/merge/drop` 三态交给提炼步骤）、高频教训→SKILL.md 草稿（`skills.register`）。

## 渊源

对话线索：harness 无权重级自学习（那是 Hermes 训练侧叙事）→ 三层外部记忆盘点 → 缺口=自动蒸馏回路 → 本 spike。上游已提交：[discussion #5510](https://github.com/deepseek-ai/deepseek-harness/discussions/5510)（主线 · Ideas）+ [#5512](https://github.com/deepseek-ai/deepseek-harness/discussions/5512)（[bug] oneOf）+ [#5511](https://github.com/deepseek-ai/deepseek-harness/discussions/5511)（[doc] render）。
