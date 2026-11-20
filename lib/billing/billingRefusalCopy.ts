/**
 * Client copy for billing refusals (04, 2026-11-20; b3/89/cb). The server sends `{ error, code }` with a code from
 * shared/billing/billingRefusalCodes.ts. This module maps the CODE to client-owned copy and never shows `error`, even
 * when it reads well: a shape test cannot tell user copy from developer prose (7c, Settings → Security).
 *
 * No top-up link (cb, PL-147): no real top-up can complete in prod yet (test keys, 0 purchases, pricing hold). The
 * copy says "contact your admin". Add the link when cb reports live payments verified.
 */
import {
  BILLING_REFUSAL_CODES, isBillingRefusalCode, type BillingRefusalCode,
} from '../../shared/billing/billingRefusalCodes';

/** Shown when an AI action was REFUSED. Total by type; the coverage test checks it against the union both ways. */
export const BILLING_REFUSAL_COPY: Readonly<Record<BillingRefusalCode, string>> = {
  INSUFFICIENT_CREDITS: 'Your organisation is out of AI credits. Nothing was charged. Ask your admin to add credits.',
  NO_CREDIT_ACCOUNT: "Your organisation doesn't have AI credits set up yet. Nothing was charged. Ask your admin.",
  ORG_SCOPE_VIOLATION: "You don't have access to use AI for this company.",
  ORG_CONTROL_BLOCKED: "Your organisation's settings block this AI action. Nothing was charged. Ask your admin.",
  BILLING_REFUSED: 'This AI action was refused by billing. Nothing was charged. Ask your admin.',
  PRICING_UNAVAILABLE: 'AI pricing is temporarily unavailable. Nothing was generated or charged. Please try again in a moment.',
};

/**
 * Shown ABOVE a deterministic fallback the server returned instead of AI output (b3 (A)): the user keeps the basic
 * result, but is never told it is AI output.
 */
export const BILLING_FALLBACK_NOTE: Readonly<Record<BillingRefusalCode, string>> = {
  INSUFFICIENT_CREDITS: "AI wasn't used: your organisation is out of AI credits. Here's a basic version.",
  NO_CREDIT_ACCOUNT: "AI wasn't used: your organisation doesn't have AI credits set up yet. Here's a basic version.",
  ORG_SCOPE_VIOLATION: "AI wasn't used: you don't have access to use AI for this company. Here's a basic version.",
  ORG_CONTROL_BLOCKED: "AI wasn't used: your organisation's settings block this AI action. Here's a basic version.",
  BILLING_REFUSED: "AI wasn't used: this AI action was refused by billing. Here's a basic version.",
  PRICING_UNAVAILABLE: "AI wasn't used: AI pricing is temporarily unavailable. Here's a basic version.",
};

export interface BillingRefusal { code: BillingRefusalCode; message: string }

/**
 * Is this response a billing refusal? Returns the code + client copy, or `null` when it is not one, so the caller keeps
 * its own handling for other errors.
 *   - a known `code` on any 402/403/503 → that code;
 *   - a 402 with an unknown or missing code → BILLING_REFUSED (402 is "payment required": always billing);
 *   - a 403/503 WITHOUT a known code → null (403 can be auth, 503 can be an outage).
 */
export function describeBillingRefusal(status: number | null | undefined, body: unknown): BillingRefusal | null {
  const code = (body && typeof body === 'object' ? (body as Record<string, unknown>).code : undefined);
  if ((status === 402 || status === 403 || status === 503) && isBillingRefusalCode(code)) {
    return { code, message: BILLING_REFUSAL_COPY[code] };
  }
  if (status === 402) return { code: 'BILLING_REFUSED', message: BILLING_REFUSAL_COPY.BILLING_REFUSED };
  return null;
}

/** The fallback note for a 200 that carried `billing_refusal_code`, or null. An unknown code still gets labelled. */
export function billingFallbackNote(body: unknown): string | null {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).billing_refusal_code : undefined;
  if (raw == null || raw === '') return null;
  return BILLING_FALLBACK_NOTE[isBillingRefusalCode(raw) ? raw : 'BILLING_REFUSED'];
}

export { BILLING_REFUSAL_CODES };

/** Thrown by a client fetch helper for a billing refusal; its message IS the client copy (no "Failed to …" prefix). */
export class BillingRefusalNotice extends Error {
  readonly code: BillingRefusalCode;
  constructor(refusal: BillingRefusal) {
    super(refusal.message);
    this.name = 'BillingRefusalNotice';
    this.code = refusal.code;
  }
}

/** Call on a non-ok response BEFORE the caller's own error handling. Throws BillingRefusalNotice for a refusal. */
export function throwIfBillingRefusal(status: number, body: unknown): void {
  const r = describeBillingRefusal(status, body);
  if (r) throw new BillingRefusalNotice(r);
}

export function isBillingRefusalNotice(e: unknown): e is BillingRefusalNotice {
  return e instanceof BillingRefusalNotice || (e as { name?: unknown } | null)?.name === 'BillingRefusalNotice';
}

/** The message to show for a caught error: billing copy as-is, anything else with the caller's prefix (unchanged). */
export function userErrorMessage(error: unknown, prefix: string): string {
  if (isBillingRefusalNotice(error)) return error.message;
  return `${prefix}: ${String((error as { message?: unknown } | null)?.message || error)}`;
}
