/**
 * Blog billing (OWNER rulings 2026-11-18 via b3).
 *
 *   PRICE    a FIXED 40 credits per blog (rate-independent), action 'blog_post' (credit_cost_config only - no
 *            action_pricing_config row, so the preview stays a flat fee).
 *   HOLD     40, BEFORE any AI call. A refused hold = a typed refusal (402 ...), nothing written, no AI call.
 *   SETTLE   - success: 40;
 *            - quality-gate 422 (the work ran, the output is withheld): REFUND IN FULL - it is our quality bar;
 *            - any other failure / stop: min(40, ceil(40 x provider calls made / 32)) - the calls are counted by the AI
 *              gateway inside this blog's credit scope (CreditHandle.onProviderCall); a failure before any call
 *              releases everything.
 *   ONE BLOG = ONE HOLD: the routes no longer go through wirePhase2Route('blog_generation'), so the blog_generation
 *            pricing row can never charge the same run a second time.
 *
 * Manual hold lifecycle (convention on reserveCreditsForWork): hold before writes, exactly one settler (this
 * function's finally), a failed settle leaves the hold held (never released on doubt), never echoes internals.
 */
import { randomUUID } from 'crypto';
import {
  confirmCreditReservationToActual,
  makeIdempotencyKey,
  releaseCreditReservation,
  reserveCreditsForWork,
  type CreditReservationHandle,
} from '../creditExecutionService';
import { runWithCreditHandle } from '../billing/aiGatewayBillingGuard';
import { logger } from '../logger';

export const BLOG_ACTION = 'blog_post' as const;
export const BLOG_CREDITS = 40;
/** The traced number of provider calls in one full blog (planner 3 + sections 8 + repairs + compatibility core). */
export const BLOG_REFERENCE_CALLS = 32;
export const BLOG_REFERENCE_TYPE = 'blog_post';

export type BlogHoldRefusal = { ok: false; status: 402 | 403 | 409 | 503; code: string; retryable: boolean; error: string; required?: number; available?: number };
export type BlogHoldResult = { ok: true; reservation: CreditReservationHandle } | BlogHoldRefusal;

export function isBlogHoldRefusal(r: BlogHoldResult): r is BlogHoldRefusal {
  return r.ok === false;
}

export interface BlogBillingSummary {
  charged: number;
  released: number;
  reason: 'completed' | 'partial' | 'not_started' | 'quality_refund';
}

/** A blog's per-request reference: the caller's Idempotency-Key when sent (a client retry reuses the hold), else new. */
export function blogReferenceId(idempotencyKeyHeader: unknown): string {
  return typeof idempotencyKeyHeader === 'string' && idempotencyKeyHeader.trim().length >= 8
    ? idempotencyKeyHeader.trim().slice(0, 200)
    : randomUUID();
}

export async function holdBlog(args: { orgId: string; userId: string; referenceId: string; validateMembership: boolean }): Promise<BlogHoldResult> {
  let r;
  try {
    r = await reserveCreditsForWork({
      userId: args.userId,
      orgId: args.orgId,
      action: BLOG_ACTION,
      referenceType: BLOG_REFERENCE_TYPE,
      referenceId: args.referenceId,
      idempotencyKey: makeIdempotencyKey(args.orgId, BLOG_ACTION, args.referenceId),
      amountOverride: BLOG_CREDITS,
      note: `Blog: ${BLOG_CREDITS} credits`,
      validateMembership: args.validateMembership,
    });
  } catch (err) {
    logger.error('blog_hold_failed', { orgId: args.orgId, message: (err as Error)?.message });
    return { ok: false, status: 503, code: 'BILLING_UNAVAILABLE', retryable: true, error: 'Billing is temporarily unavailable. Please try again.' };
  }
  if (r.status === 'reserved' || r.status === 'already_reserved') {
    const { status: _s, ...handle } = r;
    return { ok: true, reservation: handle as CreditReservationHandle };
  }
  if (r.status === 'insufficient_credits') {
    return { ok: false, status: 402, code: 'INSUFFICIENT_CREDITS', retryable: false, error: 'Not enough credits to generate this blog.', required: r.required, available: r.available };
  }
  if (r.status === 'no_credit_account') {
    return { ok: false, status: 402, code: 'NO_CREDIT_ACCOUNT', retryable: false, error: 'No credit account for this company.' };
  }
  if (r.status === 'not_a_member') {
    return { ok: false, status: 403, code: 'NOT_A_MEMBER', retryable: false, error: 'Not a member of this company.' };
  }
  if (r.status === 'org_control_blocked') {
    return { ok: false, status: 403, code: r.code, retryable: false, error: r.reason };
  }
  return { ok: false, status: 409, code: 'RESERVATION_ALREADY_SETTLED', retryable: false, error: 'This blog request was already billed. Send a new request to generate again.' };
}

/** Credits for a stopped run: min(40, ceil(40 x calls / 32)); 0 calls -> 0. */
export function partialBlogCredits(providerCalls: number): number {
  const calls = Math.max(0, Math.floor(providerCalls));
  return Math.min(BLOG_CREDITS, Math.ceil((BLOG_CREDITS * calls) / BLOG_REFERENCE_CALLS));
}

/** Thrown-error carrier: the route reads the settled billing summary off the error it re-throws. */
export function blogBillingOf(err: unknown): BlogBillingSummary | undefined {
  return (err as { blogBilling?: BlogBillingSummary } | null)?.blogBilling;
}

/**
 * Run the blog inside its credit scope and settle EXACTLY ONCE on every path. `isQualityGateRefusal` identifies the
 * route's quality-gate error (refunded in full). On success returns { result, billing }; on failure settles, attaches
 * `blogBilling` to the error and re-throws it.
 */
export async function runBlogWithBilling<T>(args: {
  reservation: CreditReservationHandle;
  run: () => Promise<T>;
  isQualityGateRefusal: (err: unknown) => boolean;
}): Promise<{ result: T; billing: BlogBillingSummary }> {
  const counter = { calls: 0 };
  const h = args.reservation;

  const settle = async (outcome: 'completed' | 'quality_refund' | 'failed'): Promise<BlogBillingSummary> => {
    const charge = outcome === 'completed' ? BLOG_CREDITS : outcome === 'quality_refund' ? 0 : partialBlogCredits(counter.calls);
    const reason: BlogBillingSummary['reason'] = outcome === 'completed' ? 'completed'
      : outcome === 'quality_refund' ? 'quality_refund' : charge > 0 ? 'partial' : 'not_started';
    try {
      if (charge > 0) {
        await confirmCreditReservationToActual({ ...h, note: `Blog: ${reason}, ${counter.calls} provider call(s)` }, charge);
      } else {
        await releaseCreditReservation({ ...h, note: `Blog: ${reason} - hold released` });
      }
      return { charged: charge, released: BLOG_CREDITS - charge, reason };
    } catch (e) {
      // Ambiguous settle: the hold stays held (never released on doubt); surfaced for reconciliation.
      logger.error('blog_credit_settle_pending', { referenceId: h.referenceId, charge, calls: counter.calls, message: (e as Error)?.message });
      return { charged: 0, released: 0, reason };
    }
  };

  let result: T;
  try {
    result = await runWithCreditHandle(
      { operationId: h.referenceId, idempotencyKey: h.idempotencyKey, orgId: h.orgId, action: BLOG_ACTION, source: 'http',
        amountReserved: h.creditsReserved, onProviderCall: () => { counter.calls++; } },
      args.run,
    );
  } catch (err) {
    const billing = await settle(args.isQualityGateRefusal(err) ? 'quality_refund' : 'failed');
    if (err && typeof err === 'object') (err as { blogBilling?: BlogBillingSummary }).blogBilling = billing;
    throw err;
  }
  return { result, billing: await settle('completed') };
}
