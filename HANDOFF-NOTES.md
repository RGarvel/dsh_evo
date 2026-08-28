# 交接备忘（由 D:\rp 会话 2026-08-28 迁移而来）

本工作区承载 **dsh-reflect**：DSH"文件级自学习回路"的 spike，源码在 `dsh-reflect/`（29/29 测试通过，未发布 npm、未装入本机 profile）。

## 已验证的事实（别重复劳动）

- `system-prompt/assemble` 是全局瀑布事件，插件可 push `{name, order, text:string}` section —— spike 的注入面就是它，测试 E9-E12 断言过幂等与异常免疫；
- `AssembleContext` 只有 `{scope, signal}`，**没有 cwd** → 工作区级注入做不到（v0 只注入全局层 + 指路 recall）。这是 harness seam 缺口，与 #4879 同族；
- `dsh-tools.defineTool` 的 output schema DSL **拒绝** `type:["object","null"]` 数组、拒绝 oneOf 分支里的 `additionalProperties`——可空返回一律改成对象+`skipped` 标记（两连拒已踩，见 README 测试节）；
- 事件监听需 `{global:true}` 才吃到所有 scope 的组装（否则仅本插件 scope，实测按 bundle 插入形态在 host scope 生效）。

## 待办（新会话的讨论清单）

1. **实机装载**：profile `dsh plugin add file:D:/dsh_evo/dsh-reflect`（或 npm 发布后 @garvel/dsh-reflect）→ 重启 web → 真会话里 `reflect_record` 一条、下轮看注入 section 是否出现（终端 `curl` 法看 prompt 快照，或直接问模型"你能看到 Persistent Memory 吗"）；
2. 自动蒸馏回路设计：`dsh-schedule` 定时 vs 会话结束事件；用 `dsh-session-query-sqlite` 挖近期会话让子代理提炼候选教训（要人工复核开关 + 敏感词 redaction）；
3. 注入预算 token 化、语义判重、与 skills 打通（高频教训→SKILL.md 草稿）；
4. 上游联动：把"memory-injection 需要的 scope→workspace 映射"作为追加论据评论进 #4879（如果它还没凉）；
5. 发版决策：@garvel/dsh-reflect 首发用 --tag spike；发布必须你终端跑（EOTP 网页认证）。

## 环境常量

- 本机 dsh：`C:\Users\阮家威\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`（rev 29b22c5）；GUI http://127.0.0.1:3080；
- 依赖解析：`dsh-reflect/node_modules/@deepseek-ai/{dsh-tools,dsh-llm}` 是指向上述树的 junction（`.gitignore` 已排除 node_modules）；
- 相关仓库：`D:\dsh-channel-view`（GUI spike）· `D:\dsh-channel-spec`（RFC-0001）· `D:\movedsh\dsh-tool-workspace-migrate`（0.1.6 已发布，本工作区就是用它迁过来的）。
