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