/**
 * Credit top-up (components/billing/TopUpPanel.tsx) outcomes, 2026-11-20 (b3: BLOCKING, money; c6 traced the server).
 *
 * POST /api/billing/checkout/verify runs AFTER the user has paid at the provider. Before this, any non-ok answer (a
 * lost connection, a 5xx, even "paid but fulfilment failed") showed "failed" with a raw code and re-enabled Buy, so a
 * user who had paid was invited to pay again.
 *
 * verify outcomes (c6, pages/api/billing/checkout/verify.ts on origin/main):
 *   200 { ok:true } (incl. recovered:true)                -> credited
 *   400 { ok:false, status:'failed', action }             -> ONLY action 'closed' / 'already_closed' is definitive ("not
 *        charged"). verify.ts:97 sends this SAME body for every closure action but 'fulfilled' (7c, 2026-11-20):
 *        every other action -> unconfirmed: 'deferred_unknown' (provider unreachable / db error / fulfilment failed
 *        after PAID), 'errored', 'not_found', no action, AND 'already_completed' (purchaseClosureService.ts:273 also
 *        returns it when the pending CAS lost to ANY writer, so it does not prove credited). Never read status:'failed'
 *        alone as "not charged".
 *   500 { ok:false, status:'paid', fulfillment_status:'failed' } -> PAID: payment taken, credits still being applied
 *   404 purchase_not_found                                -> NOT definitive today (a DB read failure lands here too)
 *   lost response / other 5xx / 400 missing ids           -> unknown
 * Re-calling verify is SAFE (c6): it re-asks the provider; completePurchase is a CAS with a UNIQUE credit key, so it
 * can never double-grant. So "Check again" re-calls verify.
 *
 * "your credits are being applied" (paid_pending) is backed by the checkout-expiry cron, NOT the webhook:
 * expireStalePendingPurchases (backend/services/billing/purchaseClosureService.ts:333) fulfils provider-confirmed-paid
 * rows, scheduled by vercel.json:59 /api/cron/billing-checkout-expiry (7,22,37,52 * * * *). It is TTL-gated, so "Check
 * again" stays the fast path. The provider webhook also grants, but its prod registration is unconfirmed (PL-120), so
 * the copy promises no timing.
 */
/** The outcome union AS A VALUE (b3 standard 2026-11-20): the type derives from it, and the tests check every table
 * against it in both directions. */
export const VERIFY_OUTCOME_KINDS = ['credited', 'not_charged', 'paid_pending', 'unconfirmed'] as const;
export type VerifyOutcomeKind = (typeof VERIFY_OUTCOME_KINDS)[number];

export function isVerifyOutcomeKind(kind: string): kind is VerifyOutcomeKind {
  return (VERIFY_OUTCOME_KINDS as readonly string[]).includes(kind);
}

/** Closure actions (verify 400 status:'failed') after which the payer was definitively NOT charged. Any other action,
 * known today or added later, is unconfirmed. */
export const NOT_CHARGED_ACTIONS = ['closed', 'already_closed'] as const;

export type VerifyOutcome =
  | { kind: 'credited'; credits: number | null }
  | { kind: 'not_charged'; message: string }
  | { kind: 'paid_pending'; message: string }
  | { kind: 'unconfirmed'; message: string };

export const TOPUP_NOT_CHARGED = "Your payment didn't go through, and you weren't charged.";
export const TOPUP_PAID_PENDING =
  "Payment received; your credits are being applied. Please don't pay again. Click 'Check again' to confirm your credits.";
export const TOPUP_UNCONFIRMED =
  "We couldn't confirm your payment yet. Please don't pay again. Click 'Check again' to confirm your credits.";

/** `status` null = the request threw. apiFetch answers a lost connection with a non-2xx (503 today, 599 after #17). */
export function classifyVerify(status: number | null, body: unknown): VerifyOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (status !== null && status >= 200 && status < 300 && b.ok === true) {
    const n = Number(b.credits_granted);
    return { kind: 'credited', credits: Number.isFinite(n) && n > 0 ? n : null };
  }
  if (b.status === 'paid') return { kind: 'paid_pending', message: TOPUP_PAID_PENDING };
  const action = typeof b.action === 'string' ? b.action : '';
  if (status === 400 && b.ok === false && b.status === 'failed') {
    if ((NOT_CHARGED_ACTIONS as readonly string[]).includes(action)) return { kind: 'not_charged', message: TOPUP_NOT_CHARGED };
  }
  return { kind: 'unconfirmed', message: TOPUP_UNCONFIRMED };
}

/** Per outcome: may a NEW purchase start? false only where we KNOW no payment is pending (credited / not charged). */
export const BLOCKS_NEW_PURCHASE: Record<VerifyOutcomeKind, boolean> = {
  credited: false,
  not_charged: false,
  paid_pending: true,
  unconfirmed: true,
};

/** Typed to the union, not string (7c 2026-11-20): the table is total by type, so there is no runtime default to
 * advertise. Callers narrow with isVerifyOutcomeKind first. */
export function blocksNewPurchase(kind: VerifyOutcomeKind): boolean {
  return BLOCKS_NEW_PURCHASE[kind];
}

/** Closure actions (POST /api/billing/checkout/close, 200) meaning the PROVIDER confirmed payment and credits were
 * granted (purchaseClosureService closePurchaseFromClient: "Provider wins, always"; f.ok -> 'fulfilled'). */
export const CLOSE_CREDITED_ACTIONS = ['fulfilled'] as const;

/**
 * The browser reported cancel / failure (Razorpay ondismiss or payment.failed, Cashfree error). That event is NOT the
 * answer: /checkout/close asks the provider and returns the authoritative action (7c 2026-11-20). Before this, the panel
 * showed "Payment cancelled"/"Payment failed" and re-enabled Buy without reading close's response, even when the server
 * had just granted the credits.
 *   200 { ok:true, action 'closed'|'already_closed' } -> not charged (the browser's cancelled/failed copy is honest)
 *   200 { ok:true, action 'fulfilled' }                 -> credited
 *   any other action (deferred_unknown, errored, already_completed, a future one), 404, 5xx, lost -> unconfirmed
 */
export function classifyClose(status: number | null, body: unknown, notChargedMessage: string): VerifyOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const action = typeof b.action === 'string' ? b.action : '';
  if (status !== null && status >= 200 && status < 300 && b.ok === true) {
    if ((NOT_CHARGED_ACTIONS as readonly string[]).includes(action)) return { kind: 'not_charged', message: notChargedMessage };
    if ((CLOSE_CREDITED_ACTIONS as readonly string[]).includes(action)) return { kind: 'credited', credits: null };
  }
  return { kind: 'unconfirmed', message: TOPUP_UNCONFIRMED };
}

/** create-order runs BEFORE any payment: nothing can have been charged yet. Codes -> copy, never raw. */
const CREATE_ORDER_COPY: Record<string, string> = {
  package_not_available: "This credit pack isn't available right now.",
  currency_not_available_for_package: "This credit pack can't be bought in your currency.",
  package_invalid: "This credit pack can't be bought right now.",
  purchase_record_failed: "We couldn't start checkout. You weren't charged.",
  order_creation_failed: "We couldn't reach the payment provider. You weren't charged.",
};
export const CREATE_ORDER_FALLBACK = "We couldn't start checkout. You weren't charged.";

export function createOrderMessage(body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const code = typeof b.error === 'string' ? b.error.split(':')[0] : '';
  return CREATE_ORDER_COPY[code] ?? CREATE_ORDER_FALLBACK;
}
