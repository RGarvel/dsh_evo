# dsh-reflect 记忆升级设计（meta-design）

> 状态：已全部落地（step 0–5，见 §7 执行记录）。原写于 2026-09-02 作为路线留档，落地实况与设计稿的出入见 §4 各模块注记。
> 前情：接口层认知与源码实证有一半出入——注入面已有 token 预算、去重、凭据闸、人审队列都实装；真正净增的是**检索、置信度、时效/命中、冲突仲裁**四条，加上 auto-distill 的两个接线 bug（已修）。

## 0. 两条已敲定的决策

1. **sidecar JSON**（`<scope>/memory.meta.json`）承载结构化元数据；正文 `memory.md` 保持 `- text #tags` 一行一条、可审可 diff。
2. **命中 = `reflect_recall` 主动查看计数**；注入系统提示只算"曝光"，**不计命中** —— 防自我放大。

## 1. 架构原则（一条贯穿）

> 正文是唯一真源；sidecar 是**可重建的机器索引**。sidecar 丢了 = 退化回今天的 v0 行为，正文还在就有救。

consolidate 重写正文后跑一次 `reconcile`，按 `normalizedText` 对齐（去重已保证单文件内 `normalizedText` 唯一），正文里消失的老 key 进 tombstone。

## 2. sidecar schema

```jsonc
// <scope>/memory.meta.json
{
  "v": 1,
  "entries": {
    "<normalizedText>": {
      "confidence": "confirmed" | "tentative" | "stale", // 方向4
      "firstHitAt": "2026-09-02T09:00:00Z",
      "lastHitAt":  "2026-09-03T11:20:00Z",              // 方向5
      "hitCount": 7,
      "supersedes": ["<normalizedText>", "..."],          // 方向6
      "supersededBy": null,                                // 软删除标记
      "keywords": ["zstd", "session-log"]                 // 方向2（distill 时抽）
    }
  },
  "tombstones": { "<normalizedText>": { "replacedBy": "...", "at": "..." } }
}
```

正文格式不变；`confidence/supersedes/keywords` 入库时写一次，`firstHitAt/lastHitAt/hitCount` 运行期累计。

## 3. 迁移顺序（6 步，依赖排序，每步独立可回滚）

| 步 | 改什么 | 依赖 | 验证 | 回滚 |
|---|---|---|---|---|
| **0** ✅ | distill 候选接线两 bug | 无 | 回归 J 节 | 改回两行 |
| **1** ✅ | 新增 `lib/meta.js`（sidecar 读写 + reconcile），尚不消费 | — | reconcile 幂等 + 正文 diff 不变（K1–K7 实测） | 删模块 |
| **2** ✅ | 置信度 + 命中反馈接入 `reflect_recall` | 1 | recall 后 hitCount 累积、注入不涨（L1–L4 实测 + 线上两次 recall 1→2） | 关 meta 消费 |
| **3** ✅ | merge/drop 接线（`kind` + store 原语） | 1（利用 distill 产出） | `kind:merge` 候选 approve 后正文改写（M1–M12 实测 + 线上隔离验证 merge→改写、drop→删除） | 只留 new |
| **4** ✅ | 冲突仲裁（supersedes 软删除） | 3 的 store 原语 | 新条 approve 后旧条标 supersededBy、停注入（N1–N9 实测 + 线上隔离验证 supersededBy/supersedes 落盘） | 清 supersedes |
| **5** ✅ | 检索重排序 | 2 攒够 hitCount | rank 组内重排（O1–O6 实测：hot 前置、全零冷启动=恒等序） | 恒等 rank |

> 检索放最后：它吃 `hitCount/lastHitAt`，冷启动无数据时=现状顺序，天然安全；强行先上只会退化成随机丢尾部。

## 4. 函数安全签名（按模块）

### 新 `lib/meta.js`（纯函数，零 dsh 依赖，可单测）

```js
loadMeta(file): Meta            // 缺文件→空；坏 JSON→空并告警，不 throw
saveMeta(file, meta): void
reconcile(meta, entries): Meta  // 正文→sidecar 对齐；孤儿 key 进 tombstones；幂等
touchHit(meta, key, now): Meta  // reflect_recall 专用；绝不从 section 调用
markConfidence(meta, key, conf) // 未落地：行恒为 "confirmed"，方向4 的置信度调整缓做
markSuperseded(meta, oldKey, newKey)
activeKeys(meta): Set<key>      // 落地新增：返回未 superseded 的 key（注入过滤用）
```

契约：`reconcile` 是唯一从正文派生 sidecar 的入口，幂等；`touchHit` 是唯一写 `hitCount/lastHitAt` 的入口。

### 改 `store.js`

```js
recordEntry(file, text, tags)      // 末尾挂钩 meta.reconcile()，其余不变
rewriteEntries(file, entries)      // 同上
mergeEntry(file, idx, text, tags)  // 新；1-based，越界报错不猜
removeEntry(file, idx)             // 新；硬删（drop 判定用）
supersedeEntry(file, oldIdx, text, tags)  // 新；append + 标旧条 supersededBy（软删）
renderInjection(g, ws, { maxTokens, pendingCount, rank })  // rank?: (e)=>number（meta 由调用方闭包）
```

不变量：`renderInjection` 不传 `rank`（或 rank 全零/抛异常降级）时字节级等价于现状（零行为变化承诺，O3/O4/O6 实测）。

### 改 `pending.js`

```js
{ kind:"new",  text, tags, source }
{ kind:"merge", idx, text, tags, source }  // idx 0-based，同 distill prompt
{ kind:"drop",  idx, source }
{ kind:"supersede", idx, text, tags, source }  // idx 0-based；approve 后新条入库 + 旧条软删
```

`parsePendingLine/formatPendingLine` 向后兼容：无 `kind` 的老行按 `new` 解析；`resolvePending` 按 kind 分派到 `recordEntry / mergeEntry / removeEntry / supersedeEntry`。

### 改 `index.js`

```js
// reflect_recall：命中计数走 touchHit（topic/tags/limit 过滤未落地，缓做）
// section provider 只读 sidecar：过滤 supersededBy + 按 hitCount 排序，绝不写
```

## 5. 两条贯穿不变量（"安全签"里的安全）

1. **sidecar 可随时丢弃**：丢了 = 回到 v0；正文在，`reconcile` 一次全量重建。所有打分字段是可再生的缓存，不是事实。
2. **元数据写绝不进 model request 关键路径**：`systemPrompt.section` 每轮都执行，所以只读；写只发生在 `reflect_recall` 工具调用与 distill 后台任务，失败只丢一条计数，绝不拖慢或打断一轮。

这两条同时守住"自我放大"与"慢一轮全体等一轮"（`auto-distill-design.md §5`）。

## 6. 明确不做（沿用 auto-distill 设计纪律）

- 自动直写 `memory.md`（无复核门）；
- 把记忆搬进 sqlite / 存储域：markdown 可审可 diff 是核心价值；
- 在注入面做 embedding 语义检索：本机无 embedding 零件，且注入面拿不到本轮 user message 语义——语义检索下放到 `reflect_recall` 的 `topic/tags` 过滤。

## 7. 执行记录（2026-09-02）

> 六步全部实现并线上验证完毕。测试当前 **109 项全绿**。

### step 0 · distill 接线 bug（详见 `spike-22-distill-bugfix.md`）
- `distill.js`：抽出 `processCandidates`，修 `screen().allowed`（→ `hits.length`）与 `queuePending` 传对象；回归 J0–J4。
- 线上验证：重启后 `distill-debug.log` 由 `queued=0` 变为 `queued=4`，候选落 `pending.md`。

### step 1 · sidecar 基座
- 新增 `lib/meta.js`：`metaPathFor/keyOf/emptyRow/loadMeta/saveMeta/reconcile`（零 dsh 依赖，单向被 store import，无环）。
- `store.js`：`recordEntry/rewriteEntries` 写后 `syncMeta`（try/catch，失败不碰正文）。
- 实测 K1–K7：`keyOf`≡`store.normalize`、reconcile 幂等、消失 key 进 tombstone、record 写 sidecar、坏 JSON 降级不 throw。

### step 2 · 命中反馈
- `meta.js` 加 `touchHit`；`index.js` 的 `reflect_recall` grab 走 `reconcile → touchHit → saveMeta`。
- 实测 L1–L4 + 线上：重启后新进程 pid=16388，两次 `reflect_recall` 使 sidecar `hitCount` 1→2、`firstHitAt` 钉住、`lastHitAt` 更新。
- 笔记：schema 里的 `confidence`（confirmed/tentative/stale）未落地——行恒为 `confirmed`，`markConfidence` 未实现；时效/置信度调整属方向 4，本次只做了命中计数（即方向 5 的输入）。

### step 3 · merge/drop 接线
- `store.js` 加 `mergeEntry/removeEntry`（1-based，越界/空拒绝不猜，写后 `syncMeta`）。
- `pending.js`：行格式加 `[m:idx]`/`[d:idx]` 前缀（无前缀= new，向后兼容）；`queuePending` 支持 kind（drop 按 idx 去重）；`resolvePending` 改 `ops{record,merge,remove}` 按 kind 分派。
- `distill.js`：`processCandidates` 处理 merge/drop verdict（0-based→1-based，越界跳过）。
- `index.js`：接 `storeOps`，preview 区分 merge/drop。
- 实测 M1–M12 + 线上隔离验证：`[m:1]` approve 改写第 1 条、`[d:3]` approve 删除第 3 条，memory 3 条→2 条。

### step 4 · supersede 软删除（方案 1：distill 新增 verdict）
- `meta.js` 加 `markSuperseded`/`activeKeys`；`store.js` 加 `supersedeEntry`（append 新条 + 标旧条 `supersededBy`）。
- `pending.js`：行格式加 `[s:idx]`；`resolvePending` 分派 `ops.supersede`。
- `distill.js`：PROMPT 增 `supersede` verdict；`processCandidates` 处理（0-based→1-based）。
- `index.js`：`storeOps` 加 supersede；section provider 用 `filterActive`（`activeKeys` 过滤 supersededBy，只读不写盘）。
- 实测 N1–N9 + 线上隔离验证：`[s:1]` approve 后新条 append、旧条 `supersededBy` 落盘、注入面过滤。

### step 5 · 检索重排序
- `store.js`：`renderInjection` 增可选 `rank`，只在每个 group 内按分排序（workspace 仍整体优先）；缺省 rank 字节级等价（零行为变化）；rank 抛异常降级为 0。
- `index.js`：`filterActive` 升级为 `collect`（同返 entries + meta），按 `hitCount`（`keyOf(text)` 反查，workspace meta 优先）构造 `rank` 传入。
- 实测 O1–O6：hot 前置、全零冷启动=现存顺序、缺省 rank 字节级等价、rank 抛异常不破坏渲染。
- 线上：重启后 `new web bound 3080=True`（端口验证生效），apply pid=21376。

### 副本同步与重启
- 同步 `lib/{store,meta,pending,distill,index}.js` 至 `profiles/web/node_modules/@garvel/dsh-reflect/lib/`（MD5 一致）。
- `restart-reflect-web.ps1` 两次加固：编码坑（`$bin` 改 `$env:APPDATA`）+ 端口坑（kill 后等 3080 释放、start 后等**该 pid 真正 bind 3080**，不再只看进程存活）——端口坑已线上验证 `bound=True`。