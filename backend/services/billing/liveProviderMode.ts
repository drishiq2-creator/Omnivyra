/**
 * The ONE definition of "this is a LIVE payment mode" (04, 2026-11-20; 7c on 7ba0b291f).
 *
 * Two questions use it, and must never drift apart:
 *   - "may this environment sell?": backend/services/billing/topUpAvailability.ts (getActiveMode());
 *   - "may this purchase row grant?": backend/services/purchaseService.ts completePurchase (row.provider_mode).
 * Only the exact value 'live' is live. 'test', NULL, '' and anything else are NOT, so both sides fail closed.
 */
export const LIVE_PROVIDER_MODE = 'live' as const;

export function isLiveProviderMode(mode: unknown): boolean {
  return mode === LIVE_PROVIDER_MODE;
}
