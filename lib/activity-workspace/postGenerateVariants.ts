/**
 * The ONE keyed request for activity-workspace `generate_variants` (shared by the content-ops hook and
 * executeMasterContentPipeline, so the key rule lives in one place).
 */
import { apiFetch } from '../apiFetch';
import { createBilledKeyLifetime, isUnknownOutcome } from '../billing/billedKeyLifetime';
import { classifyBilledResponse, billedOutcomeText, UNCERTAIN_MESSAGE } from '../billing/billedResponse';

/**
 * generate_variants is billed and keyed on the client's Idempotency-Key (c6: required, replays for
 * the same key; the server's Date.now() fallback is removed in the same release). One key per
 * action per target, kept on an unknown outcome so a retry replays instead of charging again
 * (lib/billing/billedKeyLifetime).
 */
const variantKeys = createBilledKeyLifetime('activity-generate-variants', { replays: true });

/** An error whose outcome is unknown: shown as-is, never prefixed with "Failed". */
export class UnconfirmedOutcomeError extends Error {}

/** POST generate_variants with the action's key; throws UnconfirmedOutcomeError on an unknown outcome. */
/**
 * The key's scope is the exact request body (7c: one source, not one composition per caller). The
 * body names the target AND carries its content, so a retry of the same action reuses the key and an
 * edit is a new one. Callers must keep the body deterministic (no Date.now()/random ids in it).
 */
export function generateVariantsScope(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

/** 7c: the one decision between a timeout and a SECOND billed call. Fall back only on a KNOWN failure. */
export function shouldFallbackAfter(error: unknown): boolean {
  return !(error instanceof UnconfirmedOutcomeError);
}

export async function postGenerateVariants(
  body: Record<string, unknown>,
  failureText: string,
  opts: { signal?: AbortSignal } = {},
): Promise<any> {
  const scope = generateVariantsScope(body);
  const op = variantKeys.begin(scope);
  let response: Response;
  try {
    response = await apiFetch('/api/activity-workspace/content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...op.headers },
      body: JSON.stringify({ action: 'generate_variants', ...body }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch {
    // apiFetch re-throws only an abort (e.g. a caller's timeout); the outcome is unknown, so the key
    // is kept. A lost connection arrives as apiFetch's synthetic 503 below (also unknown).
    variantKeys.finish(scope, { lost: true });
    throw new UnconfirmedOutcomeError(UNCERTAIN_MESSAGE);
  }
  const data = await response.json().catch(() => ({}));
  variantKeys.finish(scope, { status: response.status, body: data });
  if (!response.ok) {
    // One source of copy: the canonical billed mapping (402 credits, server sentences, uncertain).
    const text = billedOutcomeText(classifyBilledResponse(response.status, data, failureText));
    if (isUnknownOutcome(response.status, data)) throw new UnconfirmedOutcomeError(text);
    throw new Error(text);
  }
  return data;
}
