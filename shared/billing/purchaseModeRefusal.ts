/**
 * Why a purchase granted no credits in production, named by its STORED provider_mode (PL-162; owner ruling 2026-11-20
 * via b3: offline purchases never add credits automatically; a Super Admin grants them in Usage → Credits → Grant Credits).
 *
 * completePurchase refuses every non-'live' row in production (liveProviderMode.ts). Before PL-162 every refusal said
 * "test-mode payment", which is false for an offline ('manual') sale. Each stored mode now has its own code, copy and
 * recorded fulfillment_error:
 *   'test'    → TEST_MODE_PAYMENT_NO_CREDITS     (unchanged code: the top-up client already handles it)
 *   'manual'  → OFFLINE_PURCHASE_NO_AUTO_CREDIT  (the column's DEFAULT and the shape of a real offline sale)
 *   anything else (NULL, '', 'unknown', …) → NON_LIVE_PURCHASE_NOT_GRANTABLE
 * Exact matches only: casing or whitespace variants are "anything else", never a guess.
 */
export const NON_LIVE_NO_GRANT = 'non_live_no_grant' as const;

export const TEST_MODE_PAYMENT_NO_CREDITS = 'TEST_MODE_PAYMENT_NO_CREDITS' as const;
export const OFFLINE_PURCHASE_NO_AUTO_CREDIT = 'OFFLINE_PURCHASE_NO_AUTO_CREDIT' as const;
export const NON_LIVE_PURCHASE_NOT_GRANTABLE = 'NON_LIVE_PURCHASE_NOT_GRANTABLE' as const;

export type PurchaseModeRefusal = {
  code: typeof TEST_MODE_PAYMENT_NO_CREDITS | typeof OFFLINE_PURCHASE_NO_AUTO_CREDIT | typeof NON_LIVE_PURCHASE_NOT_GRANTABLE;
  message: string;
  /** What completePurchase records in credit_purchases.fulfillment_error. */
  fulfillmentError: string;
};

/**
 * Points at the REAL grant flow (b3, 2026-11-21): super-admin header "Usage" (/super-admin/consumption) → "Credits"
 * tab → "Grant Credits" (components/super-admin/CreditsManagementPanel). If that navigation is renamed, this follows it.
 */
export const OFFLINE_PURCHASE_NO_AUTO_CREDIT_MESSAGE =
  "Offline purchases don't add credits automatically: grant them in Usage → Credits → Grant Credits.";

export function nonLivePurchaseRefusal(storedMode: unknown): PurchaseModeRefusal {
  if (storedMode === 'test') {
    return { code: TEST_MODE_PAYMENT_NO_CREDITS, message: 'This was a test-mode payment, so no credits were added.', fulfillmentError: 'test_mode_payment_no_grant' };
  }
  if (storedMode === 'manual') {
    return { code: OFFLINE_PURCHASE_NO_AUTO_CREDIT, message: OFFLINE_PURCHASE_NO_AUTO_CREDIT_MESSAGE, fulfillmentError: 'offline_purchase_no_auto_credit' };
  }
  return { code: NON_LIVE_PURCHASE_NOT_GRANTABLE, message: "This purchase isn't from a live payment, so no credits were added.", fulfillmentError: 'non_live_payment_no_grant' };
}
