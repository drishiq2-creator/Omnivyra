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
 * model and is the fallback.
 *
 * OPENAI_IMAGE_MODEL, when set, is tried FIRST, so the model can be changed
 * without a deploy (for example back to a model this account can still call).
 */
export const OPENAI_IMAGE_MODEL_DEFAULTS = ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare'] as const;

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

/** The ordered, de-duplicated models to try: the env override first, then the defaults. */
export function openAIImageModelCandidates(override: string | undefined = process.env.OPENAI_IMAGE_MODEL): string[] {
  const configured = typeof override === 'string' ? override.trim() : '';
  return Array.from(new Set([configured, ...OPENAI_IMAGE_MODEL_DEFAULTS].filter((m) => m.length > 0)));
}
