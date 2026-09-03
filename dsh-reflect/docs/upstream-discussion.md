# [Idea] 文件级自学习回路：把完成的会话蒸馏成跨会话耐久教训（附纯插件实证 @garvel/dsh-reflect）

## 背景

DSH 的模型权重永远冻结，它的"学习"只能是**文件级外部记忆**。官方已有三层——会话内压缩（`dsh-compaction`）、项目指令（`dsh-agent-instructions`）、技能沉淀（`dsh-skill-filesystem`）——但缺一环：**没有"会话结束自动回看 → 提炼 → 写回"的蒸馏回路**。三层都是"被动 + 不跨会话自动成长"。

我们用纯插件形态把这一环的最小可用版本立了起来：`@garvel/dsh-reflect`（repo：github.com/RGarvel/dsh_evo）。模型自己就是那台"蒸馏机"，插件只提供存储、读写面、注入面。

## 做了什么（四工具 + 一命令 + 一注入）

- `reflect_record` / `reflect_recall` / `reflect_consolidate` / `reflect_pending` 四个工具 + `/reflect-review` 人用命令 + 每轮组装实时读盘的注入 section。
- 候选先落 **human-gated 复核队列**，只有 approve 才进 `memory.md`；每条带 `@src:session-<id>@<seq>` 溯源指针。
- 写盘前过**凭据筛查硬闸**（`password:` 式赋值、`Bearer`、PEM 头、`?token=`、高熵串），命中即拒且不回显。

## 架构取舍（每条都选了确定性而非聪明）

1. **markdown 正文唯一真源**，sidecar `memory.meta.json` 只存可重建缓存（hit 计数、supersede 边）；删掉 sidecar 可从正文整体重建。
2. **"hit" = `reflect_recall` 真的返回了该条**，而不是注入曝光——否则热条目恒热、冷条目永远出不来（自我放大）。
3. **soft supersede 而非删除**：蒸馏可判"新条 supersede 旧条"，旧条停止注入、正文保留、可恢复。
4. **凭据筛查**在每次写盘前跑。

## 落地时踩到的、希望官方正式化的 seam

1. `systemPrompt.section({ name, order, text: (context) => … })` provider 形态 + `context.agent`，是做 per-request、per-workspace 注入的唯一途径（读 `agent.session.header.cwd`）。但 `context.agent` 只由 `dsh-agent` 的 `declare module` 合并声明，不在 `dsh-system-prompt` 的基础 `.d.ts` 里，极易误判为"不可用"。建议把 provider 契约写进文档。
2. `ToolOutputDefinition.render(args, value)` 第二参才是要渲染的 value；纯 JS 插件（cordis 默认形态）无类型保护，极易写反。（详见 discussion #5511）
3. 工具参数根 schema 是 `oneOf`／无明确 `type` 时，值被 provider 端序列化成字符串送达，导致 oneOf 校验恒 `matched 0`（`cordis_define`、部分 MCP 工具中招）。（详见 discussion #5512，含 7 步根因链）
4. `dsh.bundle.patch` 不热重载、`file:` 依赖实体拷贝 `plugin add` 报 "Already up to date" 不重拷——迭代开发的 DX 摩擦。

## 为什么值得宿主收编

自动回看→提炼→写回是"外部记忆"三层的胶水，也正好承接 `dsh-compaction` 的 summary 作为白捡输入、衔接 `dsh-skill-filesystem`（高频教训 → SKILL.md 草稿）。若 harness 侧把这几个 seam（尤其 1、2、3）正式化，第三方"越用越顺手"的插件才有稳定演进空间。

实证代码可指读：`github.com/RGarvel/dsh_evo` 的 `dsh-reflect/`。欢迎以任何形式吸收进宿主。