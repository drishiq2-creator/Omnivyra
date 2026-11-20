/**
 * Billing refusal codes: ONE vocabulary shared by every billed route and every client (04, 2026-11-20; b3 (B)).
 *
 * Names and HTTP statuses mirror 89's WRITER_BILLING_REFUSALS / WRITER_BILLING_REFUSAL_HTTP
 * (backend/services/content/billedWriterGeneration.ts on feat/post-generation-billing-20261120), which imports this
 * module on rebase. The server sends `{ error, code }` with a code from this list. Clients map the CODE to their own
 * copy and never show `error`.
 */
export const BILLING_REFUSAL_CODES = [
  'INSUFFICIENT_CREDITS', 'NO_CREDIT_ACCOUNT', 'ORG_SCOPE_VIOLATION', 'ORG_CONTROL_BLOCKED', 'BILLING_REFUSED', 'PRICING_UNAVAILABLE',
] as const;
export type BillingRefusalCode = (typeof BILLING_REFUSAL_CODES)[number];

/** HTTP status per code. Total by type; the coverage test checks it both ways. */
export const BILLING_REFUSAL_HTTP_STATUS: Readonly<Record<BillingRefusalCode, number>> = {
  INSUFFICIENT_CREDITS: 402,
  NO_CREDIT_ACCOUNT: 402,
  ORG_SCOPE_VIOLATION: 403,
  ORG_CONTROL_BLOCKED: 403,
  BILLING_REFUSED: 402,
  PRICING_UNAVAILABLE: 503,
};

/** Retry-After (seconds) per code; only a refusal that clears on its own carries one. */
export const BILLING_REFUSAL_RETRY_AFTER_SECONDS: Readonly<Partial<Record<BillingRefusalCode, number>>> = {
  PRICING_UNAVAILABLE: 30,
};

export function isBillingRefusalCode(v: unknown): v is BillingRefusalCode {
  return typeof v === 'string' && (BILLING_REFUSAL_CODES as readonly string[]).includes(v);
}

/**
 * The credit orchestrator's result status → refusal code. `null` = NOT a billing refusal (executed, already settled,
 * or an internal error): those keep their own handling and are never reported to a user as "out of credits".
 */
export function billingRefusalCodeForOrchestratorStatus(status: string): BillingRefusalCode | null {
  switch (status) {
    case 'insufficient_credits': return 'INSUFFICIENT_CREDITS';
    case 'no_credit_account': return 'NO_CREDIT_ACCOUNT';
    case 'not_a_member': return 'ORG_SCOPE_VIOLATION';
    case 'org_control_blocked': return 'ORG_CONTROL_BLOCKED';
    default: return null;
  }
}
