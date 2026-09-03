# spike.22 蒸馏回路 bug 修复记录

> 日期：2026-09-02 · 状态：已修复并单测通过，**待重启 web 进程线上生效**
> 范围：只动 `lib/distill.js` 的候选入队环节 + `test/reflect.test.mjs` 新增回归；正文格式、注入面、凭据闸、人审队列均未改。

## 1. 现象

`~/.dsh/reflect/distill-debug.log` 里，每一次自动蒸馏都是同一结局：

```
parsed array from=text items=6
skip candidate blocked by redaction: "dsh Web侧栏只显示已注册…"
skip candidate blocked by redaction: "注册 dsh 工作区用 POST …"
…（每条候选各一行 skip）
done: parsed=6 queued=0
```

即：LLM 调用、流式解析、JSON 提取这条链**全通**，产出了 5–7 条候选，但**没有一条进 pending**，报错却写着 "blocked by redaction"。而那些候选都是普通中文教训，不含任何凭据——所以"被凭据闸拦下"是假象。

## 2. 根因（两个接线 bug，都在候选→pending 这一段）

### Bug A — 凭据判定读了不存在的字段

```js
// redact.js screen() 实际返回：
return { text: clipped, hits, truncated };   // 没有 allowed 字段

// distill.js 却这样判：
const screenResult = screen(item.text);
if (!screenResult.allowed) { /* skip */ continue; }   // !undefined === true 恒成立
```

`screen().allowed` 恒为 `undefined`，`!undefined` 恒为 `true`，于是**每一条候选都被丢弃**。正确判定是 `screenResult.hits.length === 0`（`hits` 非空 = 命中凭据规则 = 拒绝）。

### Bug B — 入队参数形状错误

```js
// pending.js 签名：
queuePending(file, entry, against = [])   // entry 必须是 {text,tags,source} 对象

// distill.js 却传了：
queuePending(pendingFile, `- ${item.text}… @src:${sessionId}@distill`, "spike-auto-distill");
```

`entry` 传成了 markdown 字符串（`entry.text === undefined` → `clean === ""` → `reason:"empty"`），`against` 传成了字符串标签而非现有条目列表。即使 Bug A 修好，幸存候选也会以 `empty` 被拒。

对比控制变量：`reflect_record` / `reflect_pending` / `reflect_consolidate` 三条写路径都**正确**用了 `screen().hits` 判断，`index.js:307` 的 `queuePending` 也是标准对象 + `readEntries(memory)` 调用。只有 distill 这一条自动路的接线是错的。

## 3. 修复

把候选处理从 `tryDistill` 里**抽成纯函数 `processCandidates`** 并导出，修掉两处接线，顺带收紧三处：

1. **Bug A**：`if (sr.hits.length)` 取代 `if (!screenResult.allowed)`；
2. **Bug B**：`queuePending(pendingFile, { text, tags, source }, existing)` 传对象，`against` 传 `readEntries(memoryFile)`（复用"已有教训不再入队"的去重语义）；
3. **收紧**：入库用 `screen()` 返回的 `sr.text`（展平 + 400 字符截断），而非原始 `item.text`；`tags` 走 `filter(Boolean)`；仅当 `res.stored === true` 才 `queued++`（不再把 duplicate/empty 误计为成功）。

```js
// lib/distill.js 新增导出（纯函数，依赖注入，可直接单测）
export function processCandidates(parsed, { screen, queuePending, readEntries, pendingFile, memoryFile, sessionId, dbg = () => {} }) { … }
```

`tryDistill` 里相应改为调用它，其余逻辑不动。

## 4. 测试

`test/reflect.test.mjs` 新增 J 节（J0–J4），钉死根因与接线：

- **J1**：`screen("普通中文").hits.length === 0 && screen(...).allowed === undefined` —— 直接钉死 Bug A 的字段名；
- **J2**：`processCandidates` 喂入 5 条（安全 ×1、含 key 凭据 ×1、merge ×1、空 ×1、重复 ×1）→ 仅 1 条入队；
- **J3**：入队条目 `text` / `tags` / `source` 三字段正确分离（`source === "session-distill@distill"`）；
- **J4**：重复调用不重复入队。

结果：**71 项检查全通过（ALL PASS）**，含既有 67 项 + 新增 4 项，无回归。

## 5. 生效条件与待验证

1. **副本已同步**：`profiles/web/node_modules/@garvel/dsh-reflect/lib/distill.js` 已覆盖为新版，MD5 与源码一致（`6D69A67A…9732`）。
2. **仍需重启 web**：Node 已把旧模块载入内存，`pnpm` file: bundle 又是实体拷贝（改源码不自动同步），所以必须重启 `dsh web` 进程才会加载新 `.js`。
3. **重启后验证**：跑任意一个 ≥2 轮完成的会话，看 `distill-debug.log` 从 `parsed=N queued=0` 变为 `queued>0`，且 `~/.dsh/reflect/pending.md`（或对应工作区 `.dsh/memory-pending.md`）出现候选、`/reflect-review list` 可见。

## 6. 后续路线（详见 `docs/meta-design.md`）

本次是 step 0（bug 修复）。后续按依赖排序：sidecar 元数据 → 置信度/命中反馈 → merge/drop 接线 → 冲突仲裁 → 检索重排序，每步独立可回滚。