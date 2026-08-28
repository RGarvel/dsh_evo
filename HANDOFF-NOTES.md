# 交接备忘（由 D:\rp 会话 2026-08-28 迁移而来）

## ⚠️ 误迁与还原记录（先读这条）

上一会话先用 `migrate_workspace` 把 rp 会话整体迁了进来（生成 `session-e06fac5b…`，含全部 rp 历史）——这**不是**你要的形态，已还原：

- `e06fac5b` 已归档（历史仍可从归档会话翻查，dsh_evo 侧边栏不再显示）；
- b95d03d5 已从 `workspace.json` 的归档名单移除（host 无 unarchive API，走了文件层还原，**需要重启 dsh web 才生效**——顺手把 QQ 回绑也带上，prefs 已指回 b95d）；
- 拷进 dsh_evo 的 17 个 rp 杂文件与 rp 侧占位 stub 均已删除。

**本工作区的正确用法**：不继承整段 rp 对话。新开对话=在 GUI 侧边栏于 dsh_evo 工作区点「新建对话」，第一句让模型读本文件即可无缝接手（已验证事实+待办都在下面）。

## dsh-reflect 原型（上一对话构建，未装载）

本工作区承载 **dsh-reflect**：DSH"文件级自学习回路"的 spike，源码在 `dsh-reflect/`（29/29 测试通过，未发布 npm、未装入本机 profile）。

## 已验证的事实（别重复劳动）

- `system-prompt/assemble` 是全局瀑布事件，插件可 push `{name, order, text:string}` section —— spike 的注入面就是它，测试 E9-E12 断言过幂等与异常免疫；
- `AssembleContext` 只有 `{scope, signal}`，**没有 cwd** → 工作区级注入做不到（v0 只注入全局层 + 指路 recall）。这是 harness seam 缺口，与 #4879 同族；
- `dsh-tools.defineTool` 的 output schema DSL **拒绝** `type:["object","null"]` 数组、拒绝 oneOf 分支里的 `additionalProperties`——可空返回一律改成对象+`skipped` 标记（两连拒已踩，见 README 测试节）；
- 事件监听需 `{global:true}` 才吃到所有 scope 的组装（否则仅本插件 scope，实测按 bundle 插入形态在 host scope 生效）。

## 待办（新会话的讨论清单）

1. **实机装载**（2026-08-28 本会话已完成装载侧，剩重启+验证）：
   - ✅ `dsh-reflect/package.json` 补了 `dsh.bundle.patch: ./cordis.patch.yml` 声明——**没有它 `dsh plugin add` 只当普通依赖装，不进 bundle 层栈**（CLI 有 warning，源码 `dsh/lib/plugin-*.js` reconcile 逻辑）；
   - ✅ `dsh plugin --profile web add file:D:/dsh_evo/dsh-reflect` 已跑，profile package.json bundles 末尾已出现 `@garvel/dsh-reflect`；
   - ⚠ profile 侧是**实体拷贝**（pnpm file: 行为）：改 dsh_evo 源码后 `plugin add` 报 "Already up to date" 不重拷，需手动同步 `~/.dsh/profiles/web/node_modules/@garvel/dsh-reflect/` 下的副本（本次只同步过 package.json）；
   - ✅ 全局记忆已播种 2 条（`~/.dsh/reflect/memory.md`，含本次装载经验本身）；模块从 profile 路径烟雾 import 通过；
   - ❇ **剩余**：终端 `dsh`（即重启 web 进程，无 restart 子命令，杀进程重开）→ 新会话问"你能看到 Persistent Memory 吗"或直接调 `reflect_record`/`reflect_recall` 验证注入面+工具面；
2. 自动蒸馏回路设计：`dsh-schedule` 定时 vs 会话结束事件；用 `dsh-session-query-sqlite` 挖近期会话让子代理提炼候选教训（要人工复核开关 + 敏感词 redaction）；
3. 注入预算 token 化、语义判重、与 skills 打通（高频教训→SKILL.md 草稿）；
4. 上游联动：把"memory-injection 需要的 scope→workspace 映射"作为追加论据评论进 #4879（如果它还没凉）；
5. 发版决策：@garvel/dsh-reflect 首发用 --tag spike；发布必须你终端跑（EOTP 网页认证）。注意 npm 发布物 `files` 已含 cordis.patch.yml，`dsh.bundle` 声明也已就位——发出去的包可直接 `dsh plugin add @garvel/dsh-reflect`。

## 环境常量

- 本机 dsh：`C:\Users\阮家威\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`（rev 29b22c5）；GUI http://127.0.0.1:3080；
- 依赖解析：`dsh-reflect/node_modules/@deepseek-ai/{dsh-tools,dsh-llm}` 是指向上述树的 junction（`.gitignore` 已排除 node_modules）；
- 相关仓库：`D:\dsh-channel-view`（GUI spike）· `D:\dsh-channel-spec`（RFC-0001）· `D:\movedsh\dsh-tool-workspace-migrate`（0.1.6 已发布，本工作区就是用它迁过来的）。
