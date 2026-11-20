/**
 * Pre-render moderation for render-inline (A8 step 2, b3 2026-11-20).
 *
 * Applies the SAME deterministic, fail-closed ruleset as the guarded render route (renderModerationGate
 * preRenderModeration) to every text field of an inline asset payload, BEFORE anything is generated.
 *   - a banned pattern anywhere in the payload text  -> blocked
 *   - no text at all (cannot positively clear)       -> blocked (fail closed)
 * Honest limit: a rule-based gate, as on the guarded route; OpenAI's own policy check still applies to the
 * provider call, and a real image classifier is a later phase. No sharp / renderer import here (the route
 * loads those only after fonts are configured).
 */
import { createHash } from 'crypto';
import { preRenderModeration } from './rendering/moderation/renderModerationGate';
import type { RenderModerationResult, RenderSpec } from './rendering/contracts';

export const IMAGE_PROMPT_BLOCKED = 'IMAGE_PROMPT_BLOCKED' as const;

const MAX_DEPTH = 8;
const MAX_STRINGS = 500;

/** Every string value in the payload (bounded walk; keys are not content). */
export function payloadText(payload: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (out.length >= MAX_STRINGS || depth > MAX_DEPTH || v == null) return;
    if (typeof v === 'string') { const t = v.trim(); if (t) out.push(t); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'object') { for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1); }
  };
  walk(payload, 0);
  return out;
}

export function moderateInlinePayload(payload: Record<string, unknown>): RenderModerationResult {
  const text = payloadText(payload);
  const subjectHash = createHash('sha256').update(JSON.stringify(text)).digest('hex');
  const spec = { moderation_context: { moderated_text: text, is_text_like: false } } as unknown as RenderSpec;
  return preRenderModeration(spec, subjectHash);
}
