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