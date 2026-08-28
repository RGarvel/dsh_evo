# @garvel/dsh-reflect

> 给 DeepSeek Harness 补上"越用越顺手"的自动回路（spike v0）

DSH 的模型权重永远冻结，它的"学习"只能是**文件级外部记忆**。官方零件里有三层——会话内压缩（`dsh-compaction`）、项目指令（`dsh-agent-instructions`）、技能沉淀（`dsh-skill-filesystem`）——但缺一环：**没有"会话自动回看→提炼→写回"的蒸馏回路**。本插件把最小可用版本立起来：模型自己就是那台"蒸馏机"，插件提供存储、读写面和注入面。

## 机制（三工具 + 一注入）

| 面 | 说明 |
|---|---|
| `reflect_record` | 追加一条"耐久经验"（决策依据/验证过的命令/坑/偏好），按归一化文本去重。落盘 markdown，一行一条，尾部 `#tag` |
| `reflect_recall` | 读取全局 + 工作区两层记忆（文件缺失=空） |
| `reflect_consolidate` | **模型驱动的整表重写**：合并/删陈/压缩。重写前自动 `memory.md.bak-<时间戳>` 备份，激进整理零风险 |
| 注入 seam | 监听 `system-prompt/assemble` 瀑布，把全局记忆 + 使用规约追加为 section（order 950），每轮组装实时读盘，超长截断并指路 recall。listener 全程 try/catch——记忆坏掉也不能弄崩 prompt |

存储约定：

- 全局：`~/.dsh/reflect/memory.md`（可用 `DSH_REFLECT_GLOBAL_FILE` 覆盖）
- 工作区：`<cwd>/.dsh/memory.md`（随项目进 git，团队共享）

## 它刻意不是什么（v0 边界）

- **不自动触发**：沉淀/整理由模型按注入规约主动调用（或你一句"把今天的坑记下来"）。自动回路是下一步（见路线图）；
- **不读会话历史**：v0 不做"会话结束自动回看 transcript 蒸馏"——那需要 `dsh-session-query-sqlite` 挖日志 + 一次 LLM 提炼，成本与隐私策略先在工作区会话里讨论；
- **workspace 注入未完成**：注入 section 目前只嵌**全局**条目（`AssembleContext` 只有 scope/signal，拿不到会话 cwd——这是 harness 侧的 seam 缺口，正好是 #4879 那类问题）；工作区条目靠 `reflect_recall` 拉取；
- 去重是精确归一化匹配，不做语义判重（语义判重=consolidate 的活）；
- 无 config 面（常量 + 两个 env），spike 阶段够用。

## 测试

```
npm test
```

29 项断言：store 纯逻辑（解析/标签/去重/备份/渲染/截断）+ 真实 `dsh-tools.defineTool` 注册烟雾（其 schema DSL 连拒两版后的合规写法本身是成果）+ 假 ctx 全链路（record→consolidate→recall→assemble 注入幂等/异常免疫）。
`node_modules/@deepseek-ai/{dsh-tools,dsh-llm}` 是指向已安装 dsh 的 **junction**（开发形态，发布物走 peerDependencies）。

## 安装（本机 DSH）

```
dsh plugin add @garvel/dsh-reflect   # 或 file:D:/dsh_evo/dsh-reflect 开发挂载
dsh web restart
```

## 路线图（在新会话 dsh_evo 里讨论）

1. **自动蒸馏**：`dsh-schedule` 每日任务 / `session/end` 类事件 → 子代理回看近期会话（sqlite query）→ 产出候选教训 → `reflect_record`（带人工复核开关）；
2. **compaction 钩子**：checkpoint 生成本就是天然蒸馏点，能否在插件位上搭车（官方 seam 候选，可反哺 #4879）；
3. **工作区级注入**：等 `AssembleContext` 透出 cwd/scope→workspace 映射，或退而求其次注入 AGENTS.md 指针；
4. 语义判重（条目 embedding）、敏感词入库前 redaction、注入预算的 token 化（现按字符）；
5. 与 skills 打通：高频教训自动起草 SKILL.md。

## 渊源

对话线索：harness 无权重级自学习（那是 Hermes 训练侧叙事）→ 三层外部记忆盘点 → 缺口=自动蒸馏回路 → 本 spike。上游相关提案：[deepseek-harness#4879](https://github.com/deepseek-ai/deepseek-harness/discussions/4879)。
