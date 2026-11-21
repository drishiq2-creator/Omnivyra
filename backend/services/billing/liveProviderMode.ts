/**
 * "Is this a LIVE payment mode?" (04, 2026-11-20). Only the exact value 'live' is live; 'test', 'manual', NULL, '' and
 * anything else are NOT, so callers fail closed.
 *
 * TWO VOCABULARIES carry a provider mode, and this predicate is only the shared "is it live" question, not one
 * vocabulary (7c NB1, PL-162):
 *   - credit_purchases.provider_mode:      NOT NULL DEFAULT 'manual', CHECK IN ('manual','test','live');
 *   - payment_provider_events.provider_mode: DEFAULT 'test', CHECK IN ('test','live') ('manual' is not legal there).
 * What a non-live value MEANS is per table: for a purchase row see shared/billing/purchaseModeRefusal.ts.
 *
 * Consumers on main: backend/services/purchaseService.ts completePurchase ("may this row grant?").
 * Pending: backend/services/billing/topUpAvailability.ts ("may this environment sell?") on the TopUp branch; it adds
 * this same file, and whoever lands second confirms the tree holds exactly one copy with both importers.
 * NOT folded in yet (their own mode logic): backend/services/payments/orchestrator/cashfreeAdapter.ts:16,
 * backend/services/billing/payments/checkoutSessionStore.ts:46.
 */
export const LIVE_PROVIDER_MODE = 'live' as const;

export function isLiveProviderMode(mode: unknown): boolean {
  return mode === LIVE_PROVIDER_MODE;
}
