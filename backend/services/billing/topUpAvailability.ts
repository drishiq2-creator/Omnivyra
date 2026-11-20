/**
 * Is buying top-up credits OPEN in this environment? (04, 2026-11-20; b3/owner, after c6's hotfix #73 dc205c3dd.)
 *
 * Production runs on TEST provider keys until the owner's live-payments go-live: getActiveMode() is 'test' unless
 * PAYMENT_PROVIDER_MODE=live. completePurchase refuses to grant credits for a test-mode purchase in production, so
 * a purchase started there can NEVER complete. The top-up panel must not invite one: it shows "Buying credits opens
 * soon" instead of Buy.
 *
 * Same condition as completePurchase's guard (isProduction() && provider_mode === 'test'), evaluated BEFORE a
 * purchase exists. Dev/QA keep test purchases open, because test keys exist to test the flow.
 */
import { isProduction } from '../config/productionFlags';
import { getActiveMode } from '../payments/orchestrator/providerConfig';

export function isTopUpPurchaseOpen(): boolean {
  return !(isProduction() && getActiveMode() !== 'live');
}
