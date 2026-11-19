/**
 * The OpenAI image models the creator renderers call: the single source for both
 * creatorAssetRendererMedia (the in-request renderer) and openAIRenderProvider
 * (the render-worker provider).
 *
 * 2026-11-19: OpenAI's deprecations page lists gpt-image-1.5 (and
 * gpt-image-1-mini, chatgpt-image-latest) as shut down on 2026-12-01, and
 * gpt-image-2 on 2027-02-10. The recommended replacement for all of them is
 * gpt-image-2.6-sunburst or gpt-image-2.6-flare. gpt-image-1 already returns
 * "model does not exist" for the production account (2026-10-25). Sunburst leads
 * because it is the "detailed visual work" model; Flare is the "fast iteration"
 * model and is the fallback. gpt-image-2.5-sunburst (not scheduled for shutdown)
 * comes last: OpenAI's own image guide still shows 2.5 ids in its examples, so if the
 * 2.6 ids are refused for this account, text-to-image generation still renders.
 *
 * OPENAI_IMAGE_MODEL, when set, is tried FIRST, so the model can be changed
 * without a deploy (for example back to a model this account can still call).
 * An override naming a RETIRING model is IGNORED, loudly (7c, 2026-11-20): a
 * stale pin to gpt-image-1.5 would otherwise make this whole change a no-op and
 * stop renders on the shutdown date. It is filtered, never an error, so rendering
 * continues on the defaults.
 */
export const OPENAI_IMAGE_MODEL_DEFAULTS = ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.5-sunburst'] as const;

/**
 * THE list of image models OpenAI has shut down or scheduled for shutdown (as of
 * 2026-11-19). The single source: the override filter below and the sunset test
 * both read it. Exact ids, never a prefix (`gpt-image-2` as a prefix would also
 * swallow the 2.5 / 2.6 replacements). Add an id here when OpenAI schedules it.
 */
export const RETIRING_OPENAI_IMAGE_MODELS: ReadonlySet<string> = new Set([
  'gpt-image-1', 'gpt-image-1.5', 'gpt-image-1.5-2025-12-16', 'gpt-image-1-mini', 'chatgpt-image-latest',
  'gpt-image-2', 'gpt-image-2-2026-04-21', 'dall-e-2', 'dall-e-3',
]);

/** How the image-provider failure is classified (pure; shared by the in-request renderer and the worker provider). */
export type ProviderFailureKind = 'model_unavailable' | 'auth' | 'quota' | 'content_policy' | 'transient' | 'unknown';

/**
 * Classify an image-provider error from its HTTP status, provider code and message.
 * Pure. "The model 'gpt-image-1' does not exist" (HTTP 400 / 404, code model_not_found)
 * means the configured model is not available to this account — not a transient fault.
 * (Moved here verbatim from creatorAssetRendererContracts, which re-exports it, so the
 * worker provider can use it without loading the renderer's database/config modules.)
 */
export function classifyProviderImageError(error: unknown): ProviderFailureKind {
  const e = (error && typeof error === 'object' ? error : {}) as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof e.status === 'number' ? e.status : null;
  const code = typeof e.code === 'string' ? e.code.toLowerCase() : '';
  const message = String(e.message ?? error ?? '').toLowerCase();
  if (code === 'model_not_found' || /model\b.*\b(does not exist|not found|not available|do(?:es)? not have access)|must be verified to use the model/.test(message)) {
    return 'model_unavailable';
  }
  if (status === 401 || status === 403 || code === 'invalid_api_key' || /invalid api key|incorrect api key|unauthori[sz]ed/.test(message)) return 'auth';
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached' || /insufficient_quota|exceeded your current quota|billing hard limit/.test(message)) return 'quota';
  if (code === 'content_policy_violation' || /content policy|safety system|moderation/.test(message)) return 'content_policy';
  if (status === 429 || (status !== null && status >= 500) || /timeout|timed out|etimedout|econnreset|aborted|rate limit/.test(message)) return 'transient';
  return 'unknown';
}

/**
 * The provider's token usage for one image call, for the per-image price of the new
 * models (billed per token; OpenAI publishes no per-image list price for 2.6).
 * Counts only: never the prompt or the image.
 */
export function imageUsageForLog(model: string, response: unknown): { model: string; input_tokens: number | null; output_tokens: number | null } {
  const usage = (response as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage;
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { model, input_tokens: n(usage?.input_tokens), output_tokens: n(usage?.output_tokens) };
}

/**
 * The ordered, de-duplicated models to try: the env override first, then the defaults.
 * A RETIRING override is dropped with one structured warning (event
 * `creator_image_model_override_ignored`, alertable by name) naming the ignored id
 * and the model used instead, so an operator who set it is told why nothing changed.
 * Any other override (including a live id not listed anywhere here) is honoured.
 */
export function openAIImageModelCandidates(override: string | undefined = process.env.OPENAI_IMAGE_MODEL): string[] {
  let configured = typeof override === 'string' ? override.trim() : '';
  if (configured && RETIRING_OPENAI_IMAGE_MODELS.has(configured.toLowerCase())) {
    console.warn('[creator-image] creator_image_model_override_ignored', {
      event: 'creator_image_model_override_ignored',
      ignored: configured,
      using: OPENAI_IMAGE_MODEL_DEFAULTS[0],
      reason: 'OPENAI_IMAGE_MODEL names a model OpenAI has retired or scheduled for shutdown; unset it or point it at a supported model',
    });
    configured = '';
  }
  return Array.from(new Set([configured, ...OPENAI_IMAGE_MODEL_DEFAULTS].filter((m) => m.length > 0)));
}
