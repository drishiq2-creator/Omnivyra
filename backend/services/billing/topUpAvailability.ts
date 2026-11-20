/**
 * Is buying top-up credits OPEN in this environment? (04, 2026-11-20; b3/owner, after c6's hotfix #73 dc205c3dd.)
 *
 * Production runs on TEST provider keys until the owner's live-payments go-live: getActiveMode() is 'test' unless
 * PAYMENT_PROVIDER_MODE=live. completePurchase refuses to grant credits for a test-mode purchase in production, so
 * a purchase started there can NEVER complete. The top-up panel must not invite one: it shows "Buying credits opens
 * soon" instead of Buy.
 *
 * Uses the SAME predicate as completePurchase's grant guard (backend/services/billing/liveProviderMode.ts): only 'live'
 * is live, so "may this environment sell?" and "may this purchase row grant?" cannot drift (7c, 2026-11-20). Until
 * that guard's flip to !isLiveProviderMode lands (fix/test-mode-guard-not-live-20261120), the row guard is narrower:
 * it refuses only an exact 'test'. Dev/QA keep test purchases open, because test keys exist to test the flow.
 */
import { isProduction } from '../config/productionFlags';
import { getActiveMode } from '../payments/orchestrator/providerConfig';
import { isLiveProviderMode } from './liveProviderMode';

export function isTopUpPurchaseOpen(): boolean {
  return !(isProduction() && !isLiveProviderMode(getActiveMode()));
}
