/**
 * GET /api/integrations could not READ the company's integrations (04, 2026-11-20; b3). It used to answer 200 with
 * `integrations: []`, so a failed read looked exactly like "nothing connected" (Rule 1). Now: 503 + this code, and
 * every caller renders "couldn't load", never an empty list.
 */
export const INTEGRATIONS_UNAVAILABLE = 'INTEGRATIONS_UNAVAILABLE' as const;

/** True only for a usable list: a 2xx whose body carries an integrations ARRAY. Anything else is "couldn't load". */
export function readIntegrationsList(ok: boolean, body: unknown): unknown[] | null {
  if (!ok || !body || typeof body !== 'object') return null;
  const list = (body as { integrations?: unknown }).integrations;
  return Array.isArray(list) ? list : null;
}
