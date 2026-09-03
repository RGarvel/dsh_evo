# 发布记录（release notes）

> 发布/推送动作的自包含记录。下个会话照做即可，不用重新踩坑。
> 约定：下文 `<repo-root>` = 本仓库根目录（含 `dsh-reflect/`、`.dsh/`、`HANDOFF-NOTES.md`、`.git`）。

## 首次 GitHub 发布（2026-09-03）

**仓库**：https://github.com/RGarvel/dsh_evo（public，default branch `main`，41 commits）

### 动作序列

1. **本地建库**：`<repo-root>` 即 git 根；补齐 step 4（supersede）+ step 5（ranking）+ `lib/meta.js` + 三份 docs 的提交。
2. **凭据扫描**：发布前全库 grep 凭据/路径，确认无真实秘密——命中的 `password:`/`BEGIN PRIVATE KEY` 等都是 `lib/redact.js` 测试用例里的假占位符与文档描述。
3. **脱敏**：`HANDOFF-NOTES.md` 里 9 处本机/身份信息（真实姓名、`C:\Users\...` 绝对路径、内部项目名、session id、频道回绑）全部换成占位符或相对形式。
4. **README 对齐**：补 repo 链接、清掉 `file:D:/...` 本机路径、断言数 63→109。
5. **推送**（走 SSH over HTTPS 443，见下）。

### 网络坑（本机复现前必读，已记入全局记忆）

- 本机网络：`github.com:443` 被阻断/超时，但 `api.github.com` 与 `ssh.github.com:443` 通。
- 后果：`gh repo create` 能成功（走 `api.github.com`），但 `git push` 走 `github.com:443` **必失败**（`Connection was reset` / `Could not connect to server`）。
- **解法**：remote 改用 SSH over HTTPS 443：

  ```
  git remote set-url origin ssh://git@ssh.github.com:443/RGarvel/dsh_evo.git
  ```

  本机 `id_ed25519` 已配到 RGarvel；自检：`ssh -T -p 443 git@ssh.github.com` 应回 `Hi RGarvel! You've successfully authenticated...`。
- 此仓库 remote 已永久设为 ssh-over-443，**勿改回 https**，否则再 push 会断。

### npm 首次发布（2026-09-03）

- ✅ `@garvel/dsh-reflect@0.0.1-spike.22` → `--tag spike`（public）。tarball 实测 `200 OK`。
- 认证两道坑：① 账号开 2FA 时，旧 bypass-2FA token 被 npm 禁 direct publish（报 404/E403），先 `npm login` 重登出合规 token；② publish 仍要 EOTP 网页认证——**必须真终端**跑 `npm publish --tag spike`，npm 打印 `https://www.npmjs.com/auth/cli/<id>`，浏览器打开完成认证后自动发布。agent/脚本跑会因 auth URL 掩码 + 缺少浏览器而卡住。
- 发布后现象：`npm view` 可能短暂 404（metadata CDN 缓存了发布前的 404），但 tarball（`…/@garvel/dsh-reflect/-/dsh-reflect-<v>.tgz`）与 `/-/v1/search?text=maintainer:garvel` **立即可见**，几分钟内 metadata 自愈——别误判为发布失败。

### 下次发布备忘

- 推送：`git -C <repo-root> push origin main`（remote 已是 ssh-over-443）。
- npm 发新版：改 `package.json` 的 version → 真终端 `npm publish --tag spike`（EOTP 网页认证）。
- 仍未做：发布前拿掉 `_ASSEMBLY_FILE` 诊断面（README「v0 边界」已标）。