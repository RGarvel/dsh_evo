# @garvel/dsh-reflect

> 给 DeepSeek Harness 补上"越用越顺手"的自动回路（spike v0）

DSH 的模型权重永远冻结，它的"学习"只能是**文件级外部记忆**。官方零件里有三层——会话内压缩（`dsh-compaction`）、项目指令（`dsh-agent-instructions`）、技能沉淀（`dsh-skill-filesystem`）——但缺一环：**没有"会话自动回看→提炼→写回"的蒸馏回路**。本插件把最小可用版本立起来：模型自己就是那台"蒸馏机"，插件提供存储、读写面和注入面。

## 机制（三工具 + 一注入）

| 面 | 说明 |
|---|---|
| `reflect_record` | 追加一条"耐久经验"（决策依据/验证过的命令/坑/偏好），按归一化文本去重。落盘 markdown，一行一条，尾部 `#tag` |
| `reflect_recall` | 读取全局 + 工作区两层记忆（文件缺失=空） |
| `reflect_consolidate` | **模型驱动的整表重写**：合并/删陈/压缩。重写前自动 `memory.md.bak-<时间戳>` 备份，激进整理零风险 |
| 注入 seam | 监听 `system-prompt/assemble` 瀑布，把全局记忆 + 使用规约追加为 section（order 950），每轮组装实时读盘，超长截断并指路 recall。listener 全程 try/catch——记忆坏掉也不能弄崩 prompt。**注**：已查明更好的写法是 `ctx.systemPrompt.section({name, order, text: (context) => …})`——provider 能拿到 `context.agent.session.header.cwd`，工作区层因此可做（见 `docs/auto-distill-design.md` §3），迁移在路线图表内 |

存储约定：

- 全局：`~/.dsh/reflect/memory.md`（可用 `DSH_REFLECT_GLOBAL_FILE` 覆盖）
- 工作区：`<cwd>/.dsh/memory.md`（随项目进 git，团队共享）

## 它刻意不是什么（v0 边界）

- **不自动触发**：沉淀/整理由模型按注入规约主动调用（或你一句"把今天的坑记下来"）。自动回路是下一步（见路线图）；
- **不读会话历史**：v0 不做"会话结束自动回看 transcript 蒸馏"。零件其实齐了——`sessionQuery` 服务（`listSessions`/`filterEvents`/`searchEvents`）+ `llm.stream` 单发提炼 + `ctx.timer` 静默去抖，缺的是策略与安全门，见 `docs/auto-distill-design.md`；
- **workspace 层只写不注入**：注入 section 目前只嵌**全局**条目。原因**不是** harness 缺口（早先记的"`AssembleContext` 拿不到 cwd"是只读 `.d.ts` 的错判——运行时 `assembleContextFor()` 一直把 `agent` 塞在 context 里，`scope === agent`，官方 plan-mode 就在用），只是 v0 没迁到 `section()` provider 写法。迁移后即修；
- 去重是精确归一化匹配，不做语义判重（语义判重=consolidate 的活）；
- 无 config 面（常量 + 两个 env），spike 阶段够用。**注意**：一旦上自动回路，`settings` 注册 `reflect` 命名空间做总开关是硬要求（详见设计文档 §1.4）。

## 测试

```
npm test
```

31 项断言：store 纯逻辑（解析/标签/去重/备份/渲染/截断）+ 真实 `dsh-tools.defineTool` 注册烟雾（其 schema DSL 连拒两版后的合规写法本身是成果）+ 假 ctx 全链路（record→consolidate→recall→assemble 注入幂等/异常免疫）+ **render 元数回归**（E13/E14）。

> 坑（实机才暴露）：harness 的 `output.render(args, value)` **第一参是入参、返回值在第二位**。早期写成 `render = (value) => JSON.stringify(value)`，工具于是把**模型自己的入参**当成结果回显——写盘照常成功、测试全绿，只有真会话能看出来。签名对照见官方 `dsh-tool-fs` 的 `render: (_args, value) => …`。

`node_modules/@deepseek-ai/{dsh-tools,dsh-llm}` 是指向已安装 dsh 的 **junction**（开发形态，发布物走 peerDependencies）。

## 安装（本机 DSH）

```
dsh plugin --profile web add file:D:/dsh_evo/dsh-reflect   # 或 npm 发布后 @garvel/dsh-reflect
# 然后杀掉 web 进程、重新 `dsh web`（CLI 没有 restart 子命令；配置与插件不热重载）
```

两个前提：

- `package.json` 必须声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`——缺它 `dsh plugin add` 只当**普通依赖**装进 profile，不进 bundle 层栈（CLI 会 warning 一句，很容易被忽略）；
- `file:` 依赖在 pnpm 下是**实体拷贝**，改源码后 `plugin add` 报 "Already up to date" 不重拷：要么手动同步 `~/.dsh/profiles/web/node_modules/@garvel/dsh-reflect/`，要么先 `plugin remove` 再 add。装载结果可用 `dsh --profile web --dump-config` 静态核对（看合成树里有没有 `tool-reflect` 层，不必重启）。

## 路线图

**详细设计已成稿**：[`docs/auto-distill-design.md`](docs/auto-distill-design.md)（触发/选材/提炼/复核四环节，附零件清单与实测过的服务面）。骨架：

1. **自动蒸馏**：`session/event` 折 `turn/end{completed}` + `ctx.timer` 静默去抖（**不是** `dsh-schedule`——它是会话内提醒器，不启动 agent turn）→ `sessionQuery` 选候选会话 → `llm.stream` 单发提炼 → 候选进 `pending.md`；
2. **复核门 + redaction**：`userQuestions.ask()` 逐条批准，敏感模式在进 pending 前过滤，总开关进 `settings`；
3. **注入面迁移**：`system-prompt/assemble` 监听 → `systemPrompt.section()` provider，顺带打通**工作区层注入**（`context.agent.session.header.cwd`，见"刻意不是什么"第 3 条）+ 用 `tokenMeter` 做预算；
4. compaction 搭车（`compaction/summary` 事件是白捡的输入）、语义判重（`new/merge/drop` 三态交给提炼步骤）、高频教训→SKILL.md 草稿（`skills.register`）。

## 渊源

对话线索：harness 无权重级自学习（那是 Hermes 训练侧叙事）→ 三层外部记忆盘点 → 缺口=自动蒸馏回路 → 本 spike。上游相关提案：[deepseek-harness#4879](https://github.com/deepseek-ai/deepseek-harness/discussions/4879)。
