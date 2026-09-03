# 上游提交记录（deepseek-ai/deepseek-harness）

## 已提交（2026-09-03）

官方仓库 **禁用了 Issues**（只开 Discussions），三份全部发成了 discussion：

| 讨论 | 分类 | 内容 |
|---|---|---|
| [#5510](https://github.com/deepseek-ai/deepseek-harness/discussions/5510) | Ideas | 文件级自学习回路主线（四工具 + 一命令 + 一注入、4 seam、repo 链接） |
| [#5512](https://github.com/deepseek-ai/deepseek-harness/discussions/5512) | General `[bug]` | oneOf 参数被字符串化（7 步根因链） |
| [#5511](https://github.com/deepseek-ai/deepseek-harness/discussions/5511) | General `[doc]` | `output.render(args, value)` 第二参文档 |

### 关键事实（下次别踩）

- **repo 真名**：`deepseek-ai/deepseek-harness`（PUBLIC，description "Everything is a Plugin."）——与 npm 包 `@deepseek-ai/dsh` 不是同一名字；README 里的 discussion URL 是对的。
- **官方禁 Issues**：`gh issue create` 报 `the repository has disabled issues`。反馈只能走 Discussions，分类只有 `Announcements / General / Ideas / Polls / Q&A / Show Your Plugins!`（**没有 Bug 类**，故 bug 报告发 General 并加 `[bug]` 前缀）。
- **行号**：下方 Issue 1/2 正文的行号是本机 rev 29b22c5 盘的，讨论正文里已标「re-check against the repo」。
- **GitHub 网络**：本机 `github.com:443` 被阻断，`gh` push 走 `ssh://git@ssh.github.com:443/...`（见 `docs/release-notes.md`）。

下方 Issue 1 / Issue 2 两段完整英文正文留档，与 discussion #5511 / #5512 发布内容一致。

## 已排除（重新核对后不成立）

### ❌ `AssembleContext.agent` 漏声明 —— 收回，不成立

- 初判：`systemPrompt.section` provider 的 `context.agent` 在 `.d.ts` 没声明。
- 复核：**不成立**。`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:14-19` 通过 declaration merging 已声明：
  ```ts
  declare module '@deepseek-ai/dsh-system-prompt' {
      interface AssembleContext {
          agent?: Agent; // absent on diagnostics
      }
  }
  ```
- 真相：`agent` 不在 `dsh-system-prompt` 的**基础**声明（那里只有 `scope`/`signal`），由 `dsh-agent` 合并进来，单读前者会漏看。**不是官方缺陷**，是我们读 `.d.ts` 没看全 merging。教训：`interface` 可能在别的包里被 `declare module` 合并，别只读一份 `.d.ts` 就下结论。

---

## Issue 1（已发 discussion #5511）—— `ToolOutputDefinition.render` 没写清哪个参数才是要渲染的 value

留档说明：这是「注释不直白」的 DX 问题，不是 bug。类型签名 `(args, value)` 是对的，但对 **plain-JS 插件**（cordis plugin 不经 TS 编译）等于零保护，参数顺序反直觉，极易写反。

### Title

`dsh-tools: clarify that ToolOutputDefinition.render's SECOND param is the value to render`

### 正文（直接粘贴）

**Summary**

The `render` projection's parameter order is easy to get wrong for plain-JavaScript plugins, which get no TypeScript checking. The signature is `render(args, value)`, but neither the doc comment nor any example states which parameter is "the thing shown to the model". A plugin author naturally writes `render = (value) => JSON.stringify(value)` — which silently binds `value` to the tool's *input arguments* and echoes those back to the model instead of the tool's result. The tool's side effects still run and unit tests often pass, so this only surfaces in a live session (we burned hours on exactly this in a real plugin).

**Where**

- `@deepseek-ai/dsh-tools/lib/types/index.d.ts` — `ToolOutputDefinition.render`
- `@deepseek-ai/dsh-tools/lib/types/schema.d.ts` — `DefineToolOptions.output.render`

Current:

```ts
/** Pure projection from validated arguments and value to Native/model content. */
render(args: unknown, value: JsonValue): ContentBlock[];
```

**Ask**

Tighten the doc comment so the semantics are unambiguous, e.g.:

```ts
/**
 * Project the tool RESULT into model-visible content blocks.
 * @param args - the validated tool INPUT (same shape the handler received); usually unused for rendering.
 * @param value - the validated tool RESULT — this is the content to render.
 */
render(args: unknown, value: JsonValue): ContentBlock[];
```

Ideally add the same note to the `defineTool` docs/example with a one-line counterexample: "don't write `render: (value) => …` — that binds `value` to `args`."

---

## Issue 2（已发 discussion #5512）—— 工具参数 `oneOf`/无明确 `type` 被 DeepSeek 模型输出成字符串，导致 oneOf 校验 `matched 0`

> 已从源码完整定位（rev 29b22c5）。根因不是「参数反序列化」出错，而是「`oneOf` union 参数在 DeepSeek 端被模型序列化成字符串」。以下英文正文可直接粘贴为 issue。

### Title

`dsh: tool parameters declared as oneOf (no top-level type) are serialized to a string, so oneOf validation always fails with "matched 0"`

### 正文（直接粘贴）

**Summary**

Tool parameters whose schema uses `oneOf` (no top-level `type`) reach the tool's validator as a **string** instead of an object, so they fail validation with `… must match exactly one oneOf branch (matched 0)` (or `must be an object`). Explicit `type: "object"` parameters work fine. This breaks several built-in tools deterministically — `cordis_define`'s `plugin` parameter (and the dynamic-Cordis probe it gates) has been unusable.

**Root-cause chain** (paths/line numbers from the v29b22c5 install; re-check against the repo):

1. `dsh-tool-cordis/lib/index.js:7189-7222` — `cordis_define` declares `parameters.plugin` as `oneOf: [ {type:"object", …}, {type:"object", …} ]` with **no top-level `type`**.
2. `dsh-tools/lib/types/schema.js:130-149` — `oneOf` compiles correctly to a `node.oneOf` node (still no top-level `type`).
3. `dsh-tools/lib/types/index.js:664-675` (`schemaOf`) — the compiled parameters are projected to the model as-is (no lowering).
4. `dsh-llm-deepseek/lib/index.js:226-234` — `parameters: tool.parameters` is sent verbatim, so the wire schema for `plugin` is a bare `oneOf`.
5. DeepSeek function-calling, given a `oneOf` union with no concrete `type`, emits the value as a JSON **string** — e.g. wire arguments become `{"plugin":"{\"kind\":\"new\",\"idPrefix\":\"x\"}", …}`.
6. `dsh-agent-loop/lib/index.js:145-152` — `parseArguments` only does a top-level `JSON.parse` (`raw ? JSON.parse(raw) : {}`), so `args.plugin` arrives as that nested **string**.
7. `dsh-tools/lib/types/json-schema.js:440-441` (oneOf) / `:472-475` (object) — the string matches 0 object branches → `matched 0`; a concrete `type:"object"` node would instead report `must be an object`.

**Repro**

Call `cordis_define` with `plugin: { kind: "new", idPrefix: "test" }` → always `matched 0`. Change `plugin` to an explicit `type: "object"` declaration → succeeds.

**Suggested fixes (by cost/benefit)**

1. Stop modeling union-*object* parameters as `oneOf` in built-ins — use a single `type: "object"` with a `kind` discriminator (`enum`) and optional `idPrefix`/`pluginId`, which the provider parses as an object unambiguously.
2. Add tolerance in the argument layer: for a `oneOf`-typed parameter, if the value is a string that parses to an object, parse it before validation.
3. Lower "all-object-branch `oneOf`" into an explicit object hint at the schema-serialization boundary.

**Impact**: `cordis_define`/`cordis_inspect` tooling and any tool or MCP binding that uses a `oneOf` (or `type:"json"`-only) parameter is non-functional on the DeepSeek provider.

---

## ~~Discussion #4879 回复~~（已作废：复核发现 #4879 是「Web GUI 侧边栏视图切换 seam」讨论、与 dsh-reflect 无关；正确去向是 discussion #5510）

> 以下英文草稿不再使用，仅留档。

We built a third-party spike (`@garvel/dsh-reflect`) for exactly the missing loop this discussion describes — turning completed sessions into durable, cross-session lessons. Sharing the architecture choices that held up, plus the harness seams we had to lean on that would benefit from being formalized.

**What it is (minimal closed loop)**
- `reflect_record` / `reflect_recall` / `reflect_consolidate` / `reflect_pending` tools + a `/reflect-review` command + a system-prompt injection section.
- The model is the "distillation engine"; the plugin provides storage, read, and injection surfaces only.
- Candidates land in a human-gated queue first; only `approve` moves them into memory. Every candidate carries a `@src:session-<id>@<seq>` provenance pointer.

**Architecture choices that held up**
1. Markdown is the single source of truth (`memory.md`, one lesson per line, `#tags`); a sidecar `memory.meta.json` holds nothing but rebuildable cache (hit counts, supersede edges). Drop the sidecar and it all rebuilds from the markdown.
2. "Hit" = a `reflect_recall` that actually returns the entry, NOT injection exposure — counting exposure lets hot lessons stay hot and cold ones never surface (self-amplification).
3. Soft supersede instead of delete: a distilled verdict can mark an old lesson superseded (stops injecting, body retained, recoverable).
4. A credential screen runs before every write (assignments, bearer, PEM, `?token=`, high-entropy blobs), and refuses without echoing the value.

**Seams we leaned on that would benefit from being formalized / documented**
1. `systemPrompt.section({ name, order, text: (context) => … })` provider form + `context.agent` is the only way we found to do per-request, per-workspace injection (reading `agent.session.header.cwd`). But `context.agent` is declared only via a `declare module` merge in `dsh-agent`, not in the base `dsh-system-prompt` `.d.ts` — easy to wrongly conclude it's unavailable. Worth documenting the provider contract explicitly.
2. `ToolOutputDefinition.render(args, value)` — the second param is the thing to render; plain-JS plugins (the default for cordis plugins) get no type safety and easily bind it backwards. (opened a separate issue)
3. A tool parameter whose root schema is `oneOf` / has no parseable `type` is delivered as a string (breaks `inspect` input and dynamic-plugin `define`). (separate issue — still root-causing, will add a repro)
4. `dsh.bundle.patch` isn't hot-reloaded, and `file:` deps are entity-copied so `plugin add` reports "Already up to date" without re-copying — DX friction for iterative plugin dev.

**Repo**: github.com/RGarvel/dsh_evo — a spike v0, MIT. The auto-distill trigger/selection loop (turn/end + debounce timer + sessionQuery) is the next piece; happy to contribute it once the harness side settles the relevant event/timer seams. Feedback welcome.

---

## 附：dsh-reflect 与官方三层的关系（一句话留档）

官方三层（`dsh-compaction` 会话内压缩 / `dsh-agent-instructions` 静态项目指令 / `dsh-skill-filesystem` 技能沉淀）都是「被动 + 不跨会话自动成长」；dsh-reflect 补的是它们共同缺的「自动蒸馏回路」：会话经历 → 提炼 → 人审 → 耐久教训 → 注入此后所有会话，并衔接 compaction（借摘要）与 skill-filesystem（教训→SKILL 草稿）。