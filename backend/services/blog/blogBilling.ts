/**
 * Blog billing (OWNER rulings 2026-11-18 via b3).
 *
 *   PRICE    a FIXED 40 credits per blog (rate-independent), action 'blog_post' (credit_cost_config only - no
 *            action_pricing_config row, so the preview stays a flat fee).
 *   HOLD     40, BEFORE any AI call. A refused hold = a typed refusal (402 ...), nothing written, no AI call.
 *   SETTLE   - success: 40;
 *            - quality-gate 422 (the work ran, the output is withheld): REFUND IN FULL - it is our quality bar;
 *            - any other failure: RELEASED IN FULL (OWNER general rule 2026-11-18: a failure on our side with
 *              nothing delivered costs the customer nothing). partialBlogCredits() - min(40, ceil(40 x calls / 32)) -
 *              is the ruled price for a DELIVERED partial blog; no path delivers one today, so nothing charges it.
 *              The gateway still counts provider calls in this blog's scope (CreditHandle.onProviderCall) and the
 *              count is logged on every settle (b3: measure real cost per blog).
 *   KEY      the client's Idempotency-Key is REQUIRED (400 IDEMPOTENCY_KEY_REQUIRED, nothing held) - a missing key
 *            used to mint a random one, so a double-click was two charges (7c; b3 BLOCKING).
 *   SWITCH   super-admin activity control 'Blog Create' (intelligence job_type 'blog_generation') gates BOTH blog
 *            routes (403 BLOG_GENERATION_DISABLED); a read error refuses (503, retryable).
 *   REPLAY   b3 BLOCKING 2026-11-18 (04's question): a blog that finished and was charged is STORED (before the settle)
 *            in api_idempotency_keys (scope 'blog_post', caller_id 'org:<orgId>' - tenant-scoped, kept indefinitely:
 *            no job deletes completed rows). The same key replays it (200, no new hold); a store read error is 503
 *            retryable; a settled key with no stored result auto-refunds the original charge exactly once (b3).
 *   REF      BLOG_REFERENCE_CALLS (32) and phase2RouteWiring ROUTE_UNIT_CALLS.blog_generation (7) are two values for
 *            the same quantity; this file's 32 is the live one for blogs (7c).
 *   ONE BLOG = ONE HOLD: the routes no longer go through wirePhase2Route('blog_generation'), so the blog_generation
 *            pricing row can never charge the same run a second time.
 *
 * Manual hold lifecycle (convention on reserveCreditsForWork): hold before writes, exactly one settler (this
 * function's finally), a failed settle leaves the hold held (never released on doubt), never echoes internals.
 */
import {
  confirmCreditReservationToActual,
  getReservationKeys,
  makeIdempotencyKey,
  releaseCreditReservation,
  reserveCreditsForWork,
  type CreditReservationHandle,
} from '../creditExecutionService';
import { runWithCreditHandle } from '../billing/aiGatewayBillingGuard';
import { logger } from '../logger';
import { getResolvedConfigStrict } from '../intelligenceConfigService';
import { emitAnomaly } from '../billing/billingAuditEmitter';
import { persistBilledResult, replayBilledResult } from '../billing/billedResultStore';
import { readOriginalCharge, refundOriginalCharge } from '../billing/owedRefunds';

export const BLOG_ACTION = 'blog_post' as const;
export const BLOG_CREDITS = 40;
/** The traced number of provider calls in one full blog (planner 3 + sections 8 + repairs + compatibility core). */
export const BLOG_REFERENCE_CALLS = 32;
export const BLOG_REFERENCE_TYPE = 'blog_post';

export type BlogRefusal = { ok: false; status: 400 | 402 | 403 | 409 | 503; code: string; retryable: boolean; error: string; required?: number; available?: number };
export type BlogHoldRefusal = BlogRefusal;
/** Type guard (strict:false does not narrow `!x.ok`). */
export function isBlogRefusal(r: { ok: boolean }): r is BlogRefusal {
  return r.ok === false;
}
export type BlogHoldResult = { ok: true; reservation: CreditReservationHandle } | BlogHoldRefusal;

export function isBlogHoldRefusal(r: BlogHoldResult): r is BlogHoldRefusal {
  return r.ok === false;
}

export interface BlogBillingSummary {
  charged: number;
  released: number;
  /** 'unpersisted': delivered in this response but could not be stored for replay -> released, not charged (b3). */
  /** 'replayed': the stored result of an earlier, already-charged request with the same key - nothing new charged. */
  /** 'platform': Omnivyra's own public blog - platform spend, no company wallet charged (b3 item 4a). */
  reason: 'completed' | 'failed' | 'quality_refund' | 'replayed' | 'unpersisted' | 'platform';
  /** Present when the settle was ambiguous: the hold stays held and reconciles later (the shared 200 + settlementPending contract). */
  settlementPending?: { code: 'CREDIT_SETTLE_AMBIGUOUS' };
}

/** A blog's reference = the client's Idempotency-Key (a retry of the same click reuses it). REQUIRED: no key -> 400. */
export function blogReferenceId(idempotencyKeyHeader: unknown): { ok: true; referenceId: string } | BlogRefusal {
  const k = Array.isArray(idempotencyKeyHeader) ? idempotencyKeyHeader[0] : idempotencyKeyHeader;
  if (typeof k === 'string' && k.trim().length >= 8) return { ok: true, referenceId: k.trim().slice(0, 200) };
  return { ok: false, status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED', retryable: false,
    error: 'An Idempotency-Key header (at least 8 characters, one per blog request) is required to generate a blog.' };
}

/** The intelligence job_type super-admin 'Blog Create' toggles; both blog routes honour it. */
export const BLOG_KILL_SWITCH_JOB_TYPE = 'blog_generation';

let switchRowAbsentReported = false;
/** Test seam: re-arm the once-per-process report. */
export function __resetBlogSwitchAbsentReportForTests(): void { switchRowAbsentReported = false; }

/**
 * null = allowed. companyId null = the global switch only. A read error refuses (never read as "on").
 * b3 ruling 2026-11-18 (adopting 7c): migration 20270217000060 GUARANTEES the global row, so an ABSENT row means
 * someone deleted it - the incident switch - and blogs FAIL CLOSED (403). Still an alertable anomaly, once per process.
 */
export async function blogGenerationRefusal(companyId: string | null): Promise<BlogRefusal | null> {
  let cfg;
  try {
    cfg = await getResolvedConfigStrict(companyId, BLOG_KILL_SWITCH_JOB_TYPE);
  } catch (err) {
    logger.error('blog_kill_switch_read_failed', { companyId, message: (err as Error)?.message });
    return { ok: false, status: 503, code: 'BLOG_SWITCH_UNAVAILABLE', retryable: true, error: 'Blog generation is temporarily unavailable. Please try again.' };
  }
  if (!cfg) {
    if (!switchRowAbsentReported) {
      switchRowAbsentReported = true;
      emitAnomaly({ kind: 'blog_kill_switch_row_absent', severity: 'critical', message: 'blog_kill_switch_row_absent',
        metadata: { jobType: BLOG_KILL_SWITCH_JOB_TYPE } });
    }
    return BLOG_DISABLED;
  }
  if (cfg.enabled === false) return BLOG_DISABLED;
  return null;
}
const BLOG_DISABLED: BlogRefusal = { ok: false, status: 403, code: 'BLOG_GENERATION_DISABLED', retryable: false, error: 'Blog generation is turned off for this account.' };

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
  if (r.status === 'reserved') {
    const { status: _s, ...handle } = r;
    return { ok: true, reservation: handle as CreditReservationHandle };
  }
  if (r.status === 'already_confirmed') {
    // Charged earlier under this key and blogReplay found no stored copy: the customer paid for nothing we can
    // return -> the original charge is credited back exactly once (b3; refundUnavailableBlog).
    return refundUnavailableBlog({ orgId: args.orgId, userId: args.userId, referenceId: args.referenceId });
  }
  if (r.status === 'already_released') {
    return { ok: false, status: 409, code: 'BLOG_REQUEST_ENDED', retryable: false,
      error: 'This blog request did not finish and was not charged. Start it again.' };
  }
  if (r.status === 'already_reserved') {
    // The same key is still held by a run in flight: running it again would generate twice under one charge.
    return { ok: false, status: 409, code: 'BLOG_ALREADY_IN_PROGRESS', retryable: true, error: 'This blog is already being generated.' };
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
  return { ok: false, status: 409, code: 'RESERVATION_ALREADY_SETTLED', retryable: false, error: 'This blog request has already finished. Start a new request to generate again.' };
}

// ── Replay store (b3 BLOCKING) - the shared billedResultStore (one implementation with wirePhase2Route) ──────────
export const BLOG_REPLAY_SCOPE = 'blog_post';
/**
 * b3 ruling 2026-11-18 (item 4a): Omnivyra's OWN public blog (super-admin /api/admin/blog/generate, public_blogs) is
 * PLATFORM spend - no company wallet is held or charged. Its result is still stored (this scope) so the required
 * Idempotency-Key deduplicates a retry. (4b, after a9's 039 merges: attribute its AI usage to the platform ledger.)
 */
export const BLOG_PLATFORM_SCOPE = 'blog_post_platform';
export const BLOG_PLATFORM_BILLING = { charged: 0, released: 0, reason: 'platform' } as const;

/** Store a platform blog for dedup. Best effort: nothing is charged either way. */
export async function storePlatformBlog(orgId: string, referenceId: string, result: unknown): Promise<void> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return;
  await persistBilledResult({ scope: BLOG_PLATFORM_SCOPE, orgId, key: referenceId, value: result });
}

/**
 * A stored, already-charged blog for this org + key: replay it. A failed read is counted DURABLY (billedResultStore):
 * transient -> 503 retryable; TERMINAL (3 failures or 24h from the first) -> the refund path (b3/7c), never an endless
 * "try again". The platform scope charged nothing, so its terminal case refunds nothing.
 */
export async function blogReplay(
  orgId: string, referenceId: string, opts: { scope?: string; userId: string },
): Promise<{ ok: true; body: Record<string, unknown> | null } | BlogRefusal> {
  const scope = opts.scope ?? BLOG_REPLAY_SCOPE;
  const r = await replayBilledResult({ scope, orgId, key: referenceId });
  if (r.kind === 'absent') return { ok: true, body: null };
  if (r.kind === 'found') {
    const v = r.value;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return { ok: true, body: { ...(v as Record<string, unknown>), billing: { charged: 0, released: 0, reason: scope === BLOG_PLATFORM_SCOPE ? 'platform' : 'replayed' } } };
    }
    logger.error('blog_replay_stored_value_invalid', { orgId, referenceId });
  }
  if (r.kind === 'transient') {
    return { ok: false, status: 503, code: 'BLOG_RESULT_READ_FAILED', retryable: true, error: 'We could not load this blog right now. Please try again.' };
  }
  // terminal (or an unusable stored value): the blog cannot be returned.
  if (scope === BLOG_PLATFORM_SCOPE) {
    return { ok: false, status: 409, code: 'BLOG_RESULT_UNAVAILABLE', retryable: false, error: "We couldn't recover this blog. Nothing was charged; you can write it again." };
  }
  return refundUnavailableBlog({ orgId, userId: opts.userId, referenceId });
}

/** Persist a finished blog and read it back BEFORE its settle (b3 invariant). False = not persisted -> not charged. */
async function storeBlogResult(h: CreditReservationHandle, result: unknown): Promise<boolean> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    logger.error('blog_result_store_failed', { orgId: h.orgId, referenceId: h.referenceId, message: 'blog result is not an object' });
    return false;
  }
  return persistBilledResult({ scope: BLOG_REPLAY_SCOPE, orgId: h.orgId, key: h.referenceId, value: result });
}

// ── Auto-refund of a charged blog that cannot be returned (b3 ruling 2026-11-18) ───────────────────────────────────
/**
 * REACHABILITY (answer to 7c/04): after persist-and-read-back-before-settle, a NEW run cannot be confirmed without a
 * readable stored copy (the only confirm path is runBlogWithBilling's 'completed' settle, which runs after the
 * read-back). So BLOG_RESULT_UNAVAILABLE is reachable only through LATER LOSS of a stored row (manual deletion, a
 * database restore) - no job deletes completed rows - or if some future resolver CONFIRMS a blog hold that this code
 * released or left pending (none does today: the orphan reapers release and are unscheduled). There are no pre-change
 * blog_post charges (the key is new on this branch).
 *
 * For whatever remains: the original charge is credited back EXACTLY ONCE as forward 'grant' ledger entries (one per
 * category the confirm consumed), keyed on the ORIGINAL confirm transaction id - a second retry hits the same keys and
 * grants nothing more. Audited (reason 'blog_result_unavailable'). Never a wallet rebuild; protected orgs are never
 * auto-refunded (a critical anomaly asks for review instead).
 */
export function blogUnavailableRefundsOriginalCharge(): true { return true; }
export function blogUnavailableRefundedText(credits: number): string {
  return `We couldn't recover this blog, so your ${credits} credits have been returned. You can write it again.`;
}
/** The refund is RECORDED and the system is paying it (the grant-only job completes it; no action needed). */
export function blogUnavailableReturningText(credits: number): string {
  return `We couldn't recover this blog, so your ${credits} credits are being returned to your account. You can write it again.`;
}

async function refundUnavailableBlog(args: { orgId: string; userId: string; referenceId: string }): Promise<BlogRefusal> {
  const confirmKey = getReservationKeys(makeIdempotencyKey(args.orgId, BLOG_ACTION, args.referenceId)).confirmKey;
  emitAnomaly({ organizationId: args.orgId, kind: 'blog_result_lost', severity: 'critical', message: 'blog_result_lost',
    metadata: { referenceId: args.referenceId } });
  const pending: BlogRefusal = { ok: false, status: 503, code: 'BLOG_REFUND_PENDING', retryable: true,
    error: 'We could not recover this blog and could not record the refund yet. Please try again in a moment.' };
  let charge;
  try {
    charge = await readOriginalCharge(confirmKey);
  } catch (err) {
    logger.error('blog_result_unavailable_charge_unreadable', { orgId: args.orgId, referenceId: args.referenceId, message: (err as Error)?.message });
    return pending;
  }
  if (!charge) {
    // No confirmed charge under this key: nothing was taken (a hold may still be pending; the resolver owns it).
    logger.error('blog_result_unavailable_no_original_charge', { orgId: args.orgId, referenceId: args.referenceId });
    return { ok: false, status: 409, code: 'BLOG_RESULT_UNAVAILABLE', retryable: false, error: "We couldn't recover this blog. You were not charged for it; you can write it again." };
  }
  // b3: "auto-refund" = the system pays without the user acting. The debt is RECORDED (one row per original confirm);
  // paid now if possible, else by the grant-only job 'billing-owed-refund-complete'.
  const out = await refundOriginalCharge({
    orgId: args.orgId, performedBy: args.userId, charge, reason: 'blog_result_unavailable',
    grantKeyPrefix: 'blog_refund', referenceId: args.referenceId,
  });
  if (out.status === 'granted') {
    return { ok: false, status: 409, code: 'BLOG_RESULT_UNAVAILABLE', retryable: false, error: blogUnavailableRefundedText(out.credits) };
  }
  if (out.status === 'owed') {
    return { ok: false, status: 409, code: 'BLOG_RESULT_UNAVAILABLE', retryable: false, error: blogUnavailableReturningText(out.credits) };
  }
  if (out.status === 'protected') {
    return { ok: false, status: 409, code: 'BLOG_RESULT_UNAVAILABLE', retryable: false,
      error: 'This blog was already generated and charged, but we could not return it. We will review the charge.' };
  }
  return pending;   // 'unrecorded': never a promise we did not keep
}

/** The ruled price of a DELIVERED partial blog: min(40, ceil(40 x calls / 32)); 0 calls -> 0. No path delivers a partial blog today. */
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

  const settle = async (outcome: 'completed' | 'quality_refund' | 'failed' | 'unpersisted'): Promise<BlogBillingSummary> => {
    // OWNER 2026-11-18: a failure on our side with nothing delivered is free - only success charges.
    const charge = outcome === 'completed' ? BLOG_CREDITS : 0;
    const reason: BlogBillingSummary['reason'] = outcome;
    try {
      if (charge > 0) {
        await confirmCreditReservationToActual({ ...h, note: `Blog: ${reason}, ${counter.calls} provider call(s)` }, charge);
      } else {
        await releaseCreditReservation({ ...h, note: `Blog: ${reason} - hold released` });
      }
      logger.info('blog_credit_settled', { referenceId: h.referenceId, reason, charged: charge, providerCalls: counter.calls });
      return { charged: charge, released: BLOG_CREDITS - charge, reason };
    } catch (e) {
      // Ambiguous settle: the hold stays held (never released on doubt); surfaced for reconciliation.
      logger.error('blog_credit_settle_pending', { referenceId: h.referenceId, charge, calls: counter.calls, message: (e as Error)?.message });
      return { charged: 0, released: 0, reason, settlementPending: { code: 'CREDIT_SETTLE_AMBIGUOUS' } };
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
  // b3 invariant: generate -> PERSIST -> settle -> respond. Not persisted -> not charged.
  const persisted = await storeBlogResult(h, result);
  return { result, billing: await settle(persisted ? 'completed' : 'unpersisted') };
}
