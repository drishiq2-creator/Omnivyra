/**
 * THE canonical client mapping for every billed AI response (e9 ruling, 2026-11-13).
 *
 * Every billed route answers with one shape (55/e1 keep it consistent):
 *   402 { error, message?, required?, balance? | available? }  → not enough credits
 *   409 { code: 'ALREADY_PROCESSED' } → this exact request was already done AND charged
 *       (double-click / network retry). It's SUCCESS: refresh, don't show an error.
 *   500 { code: 'RECLAIM_CAP_EXHAUSTED' } → our failure, nothing charged: offer "try again"
 *       (a retry is a new click, so a NEW key). Replaces ALREADY_RELEASED (never on main).
 *   503 { code: '<anything>_UNVERIFIABLE' } + Retry-After → a spending limit / budget / org
 *       control couldn't be checked; nothing charged: plain "try again", NEVER top-up. Any
 *       future *_UNVERIFIABLE code is handled the same way with no UI change (e9).
 * Keyed on HTTP status and `code` only, never on message text. Raw snake_case codes are
 * never shown to users.
 *
 * Used by Market Pulse run start, blog-card chat, content regenerate and activity
 * refine_variant. Future billed paths reuse it.
 */

/** Where users top up; the same page the credit-alert emails link to. */
export const TOP_UP_HREF = '/company/billing';

export type BilledOutcome =
  | { kind: 'ok' }
  | { kind: 'credits'; code: string; message: string; required?: number; available?: number }
  | { kind: 'already_processed'; message: string }
  | { kind: 'retry'; message: string }
  /** The work is DONE (2xx) but its charge is still being finalised: show the result, never re-run. */
  | { kind: 'settlement_pending'; message: string }
  /**
   * A server-side failure (5xx) we can't classify. The work MAY have happened (and may be
   * charged), so tell the user to check before trying again, never a plain "failed" that
   * invites a re-click (a new key, a new hold, a second charged run). (7c review.)
   */
  | { kind: 'uncertain'; message: string }
  | { kind: 'error'; message: string };

export const SETTLEMENT_PENDING_MESSAGE = 'Done. Billing for this is still being finalised. You won’t be charged twice, so there’s no need to run it again.';
export const RECLAIM_MESSAGE = 'That didn’t finish on our side and you weren’t charged. Please try again.';
export const UNCERTAIN_MESSAGE = 'We’re not sure this went through. Please check the result before trying again.';
/** c6 engagement-v2 (b3adbc688): the stored result for this key can't be read right now; nothing new ran. */
export const REPLAY_UNAVAILABLE_MESSAGE = 'We couldn’t load the result just now. Please try again in a moment.';
/** c6's agreed contract (2026-11-13): a 2xx `executed` body may carry settlementPending. */
export const SETTLE_AMBIGUOUS_CODE = 'CREDIT_SETTLE_AMBIGUOUS';
const isSettlementPendingBody = (b: Record<string, unknown>) =>
  !!b.settlementPending && typeof b.settlementPending === 'object' &&
  (b.settlementPending as { code?: unknown }).code === SETTLE_AMBIGUOUS_CODE;

const CREDIT_CODES = new Set(['insufficient_credits', 'no_credit_account', 'pricing_unavailable']);

/** The *_UNVERIFIABLE refusals known today (pinned by the helper test). The helper matches the
 *  SUFFIX, so a new one needs no UI change; add it here so the list stays honest. */
export const KNOWN_UNVERIFIABLE_CODES: readonly string[] = Object.freeze([
  'DAILY_LIMIT_UNVERIFIABLE',
  'BUDGET_UNVERIFIABLE',
  'ORG_CONTROLS_UNVERIFIABLE',
]);
const isUnverifiableCode = (code: string) => /^[A-Z][A-Z0-9_]*_UNVERIFIABLE$/.test(code);
export const UNVERIFIABLE_MESSAGE = 'We couldn’t check your spending limits just now. Nothing was charged. Please try again in a moment.';

const CREDIT_FALLBACK: Record<string, string> = {
  insufficient_credits: 'You don’t have enough credits for this.',
  no_credit_account: 'Your company doesn’t have a credit account yet.',
  pricing_unavailable: 'Pricing is temporarily unavailable, so this wasn’t started. Please try again shortly.',
};

const isCodeLike = (s: string) => /^[A-Za-z0-9_]+$/.test(s) && /_/.test(s);

/**
 * Classify a billed AI response. `fallback` is the human message for a generic failure.
 * 2xx → ok.
 */
export function classifyBilledResponse(status: number, body: unknown, fallback: string): BilledOutcome {
  if (status >= 200 && status < 300) {
    // The work is DONE; only its charge is unresolved. Render the result normally plus the
    // quiet note, and never resubmit (b3 + 7c, 2026-11-18). Never shows holdId / detail.
    const ok = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (isSettlementPendingBody(ok)) return { kind: 'settlement_pending', message: SETTLEMENT_PENDING_MESSAGE };
    return { kind: 'ok' };
  }
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const code = typeof b.code === 'string' ? b.code : '';
  const errorField = typeof b.error === 'string' ? b.error : '';
  const message = typeof b.message === 'string' && b.message.trim() ? b.message.trim() : '';
  const detail = typeof b.detail === 'string' && b.detail.trim() ? b.detail.trim() : '';
  // Final shape (55, 2026-11-13): `error` is the readable sentence and `code` is the machine
  // key (INSUFFICIENT_CREDITS / NO_CREDIT_ACCOUNT / PRICING_UNAVAILABLE / ALREADY_PROCESSED /
  // RECLAIM_CAP_EXHAUSTED / *_UNVERIFIABLE).
  // Older bodies put a snake_case reason in `error` and the sentence in `message`;
  // both are accepted.
  const human = message || (errorField && !isCodeLike(errorField) ? errorField : '') || (detail && !isCodeLike(detail) ? detail : '');

  if (status === 409 && code === 'ALREADY_PROCESSED') {
    return { kind: 'already_processed', message: 'This was already done. Refreshing to show the result.' };
  }
  if (code === 'SETTLEMENT_PENDING') {
    return { kind: 'settlement_pending', message: SETTLEMENT_PENDING_MESSAGE };
  }
  // c6 (MP billing): a refused credit hold creates nothing; billing being down is retryable.
  // c6 engagement-v2: results are stored before the charge and REPLAYED for the same key; a 503
  // REPLAY_UNAVAILABLE means the stored result is unreadable right now. Nothing new ran or was
  // charged: a plain retry (with the same key), never "not sure it went through".
  if (code === 'REPLAY_UNAVAILABLE') {
    return { kind: 'retry', message: REPLAY_UNAVAILABLE_MESSAGE };
  }
  if (code === 'BILLING_UNAVAILABLE') {
    return { kind: 'retry', message: 'Billing is unavailable right now, so nothing was started. Please try again shortly.' };
  }
  // Matched on the code alone, deliberately: it is unique to the reclaim path. "You weren't
  // charged" is TRUE only because of the owner's ruling (b3, 2026-11-18): failures on our side
  // are refunded in full, and c6 releases the entry fee on failure, pinned server-side.
  // RELEASE DEPENDENCY: ship this helper WITH or AFTER that c6 change, never before.
  if (code === 'RECLAIM_CAP_EXHAUSTED') {
    return { kind: 'retry', message: RECLAIM_MESSAGE };
  }
  // The server says EXACTLY what was charged (c6's `billing` object, e.g. blogs): state that
  // fact rather than "uncertain". Only for refusals/failures; a 2xx returned above.
  const billing = b.billing as { charged?: unknown; released?: unknown; reason?: unknown } | undefined;
  if (billing && typeof billing === 'object' && typeof billing.charged === 'number') {
    const charged = billing.charged;
    const released = typeof billing.released === 'number' ? billing.released : 0;
    if (billing.reason === 'quality_refund') {
      return { kind: 'error', message: 'This didn’t pass our quality check, so you weren’t charged.' };
    }
    if (billing.reason === 'partial' && charged > 0) {
      return { kind: 'error', message: `You were charged ${charged} of ${charged + released} credits; ${released} were returned.` };
    }
    if (charged === 0) {
      return { kind: 'error', message: `${human || fallback}${/[.!?]$/.test(human || fallback) ? '' : '.'} You weren’t charged.` };
    }
  }
  if (isUnverifiableCode(code)) {
    return { kind: 'retry', message: UNVERIFIABLE_MESSAGE };
  }
  const creditKey = [code, errorField].map((c) => c.toLowerCase()).find((c) => CREDIT_CODES.has(c));
  if (status === 402 || creditKey) {
    const creditCode = creditKey ?? 'insufficient_credits';
    const available = typeof b.balance === 'number' ? b.balance : typeof b.available === 'number' ? b.available : undefined;
    return {
      kind: 'credits',
      code: creditCode,
      message: human || CREDIT_FALLBACK[creditCode] || CREDIT_FALLBACK.insufficient_credits,
      ...(typeof b.required === 'number' ? { required: b.required } : {}),
      ...(available !== undefined ? { available } : {}),
    };
  }
  // An unclassified SERVER failure may have done (and charged for) the work: never a plain
  // "failed". A 4xx means the request was refused before any work, so a plain error is honest.
  if (status >= 500) return { kind: 'uncertain', message: UNCERTAIN_MESSAGE };
  return { kind: 'error', message: human || fallback };
}

/** One plain-text line for surfaces that can only show text (toasts, chat bubbles). */
export function billedOutcomeText(outcome: BilledOutcome): string {
  switch (outcome.kind) {
    case 'ok':
      return '';
    case 'credits': {
      const numbers =
        typeof outcome.required === 'number' && typeof outcome.available === 'number'
          ? ` (${outcome.required} credits are reserved up front; you’ll only be charged for what’s used. You have ${outcome.available})`
          : '';
      const topUp = outcome.code === 'pricing_unavailable' ? '' : ' Top up credits on the Billing page.';
      const sentence = `${outcome.message}${numbers}`;
      return `${/[.!?]$/.test(sentence) ? sentence : `${sentence}.`}${topUp}`;
    }
    default:
      return outcome.message;
  }
}
