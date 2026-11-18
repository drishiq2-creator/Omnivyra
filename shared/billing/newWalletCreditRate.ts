/**
 * OWNER ruling 2026-11-18 (via b3): every NEW wallet starts at credit_rate_usd 0.007 - the owner's rate (one credit =
 * USD 0.007), ahead of the full pricing release. The ONE source for the app-side value; the database column default is
 * the same number (migration organization_credits_rate_default_0007), so wallets created by SQL credit functions or the
 * projection reconciler (which insert organization_credits(organization_id) and take the column default) agree with
 * the signup path.
 *
 * Existing wallets are NOT touched here - they move only in the D8 rate equalisation (pricing release).
 */
export const NEW_WALLET_CREDIT_RATE_USD = 0.007;
