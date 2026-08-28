/**
 * Credential screening for dsh-reflect.
 *
 * Why this exists as its own module with one job: everything this plugin stores
 * gets copied into EVERY future system prompt. A single stored secret therefore
 * stops being one leaked value and becomes a permanent, silently-rebroadcast
 * credential. So screening runs BEFORE any write — both the model-facing tools
 * and (later) the automatic distillation queue go through it, and neither can
 * opt out.
 *
 * The rules aim at *credential-shaped values*, not at scary words: an ordinary
 * Chinese lesson mentioning "token" or "密钥" must pass. That is why the
 * high-entropy rule additionally requires a digit AND (an uppercase letter or a
 * symbol): a bare 40-char lowercase git sha — a legitimate thing to cite in a
 * lesson — survives, while `AK…_…`-shaped keys and base64 blobs do not.
 *
 * @module @garvel/dsh-reflect/redact
 */

/** Named value-shaped rules. A match means: refuse the write, ask for a rephrase. */
export const SECRET_RULES = [
  // `password: hunter2`, `api_key=…`, `token：…` (full-width colon too).
  ["assignment", /(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|pwd|密钥|令牌)\s*[:：=]\s*\S/i],
  // `Authorization: Bearer …`
  ["bearer", /\bbearer\s+[a-z0-9._~+\/-]{8,}=*/i],
  // PEM / JWK block headers
  ["private-key-block", /-{2,}\s*BEGIN\s+[A-Z ]*(?:PRIVATE|SECRET)\s+KEY/i],
  // Secrets pasted into URLs: `?token=…`, `&key=…`, `/auth/abc123`
  ["url-secret", /[?&](?:key|token|auth|secret|sig|access_token)=\S+/i],
  // Cloud access-key shapes (AWS-style 20-char uppercase alnum, and the common
  // `prefix_live_rest` / `prefix_hash_hash` vendor shapes).
  ["access-key-shape", /\b(?:AK|ASIA)[A-Z0-9]{16,}\b/],
];

/** Runs of 24+ token-alphabet chars carrying both a digit and (upper|symbol). */
export const HIGH_ENTROPY =
  /\b(?=[A-Za-z0-9+/_-]{24,}\b)(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[A-Z]|[A-Za-z0-9+/_-]*[_+/])[A-Za-z0-9+/_-]{24,}\b/;

/** Lesson length cap: an injected prompt section must stay cheap. */
export const MAX_TEXT_CHARS = 400;

/**
 * Screen one candidate lesson.
 *
 * @param text - raw candidate text.
 * @returns {{text: string, hits: string[], truncated: boolean}} `text` is the
 *   flattened, capped form the caller should store; `hits` names every rule that
 *   matched (empty = safe to store).
 */
export function screen(text) {
  const flat = String(text ?? "").trim().replace(/\s*\n\s*/g, " ");
  const truncated = flat.length > MAX_TEXT_CHARS;
  const clipped = truncated ? flat.slice(0, MAX_TEXT_CHARS - 1).trimEnd() + "…" : flat;
  const hits = [];
  for (const [name, re] of SECRET_RULES) {
    if (re.test(clipped)) hits.push(name);
  }
  if (!hits.length && HIGH_ENTROPY.test(clipped)) hits.push("high-entropy");
  return { text: clipped, hits, truncated };
}

/**
 * Guidance for whoever tried to store a blocked line. Deliberately does NOT
 * echo the offending substring back — that would put the secret in yet another
 * transcript.
 *
 * @param hits - rule names from {@link screen}.
 */
export function blockReason(hits) {
  return (
    `blocked by credential screen (${hits.join(", ")}); describe the value's shape or location ` +
    `instead of its content, e.g. "LLMQUANT_API_KEY lives in profiles/web/cordis.patch.yml"`
  );
}
