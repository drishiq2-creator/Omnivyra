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
  createCredit,
  getReservationKeys,
  makeIdempotencyKey,
  releaseCreditReservation,
  reserveCreditsForWork,
  type CreditReservationHandle,
} from '../creditExecutionService';
import type { CreditCategory } from '../creditExecutionServiceContracts';
import { runWithCreditHandle } from '../billing/aiGatewayBillingGuard';
import { logger } from '../logger';
import { getResolvedConfigStrict } from '../intelligenceConfigService';
import { emitAnomaly, emitFinancialAudit } from '../billing/billingAuditEmitter';
import { loadBilledResult, persistBilledResult } from '../billing/billedResultStore';
import { supabase } from '../../db/supabaseClient';

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
  reason: 'completed' | 'failed' | 'quality_refund' | 'replayed' | 'unpersisted';
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
 * b3 ruling 2026-11-18: an ABSENT global row = not disabled -> ALLOW, reported as an alertable anomaly ONCE per process.
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
    // No switch row configured: absence = not disabled (b3). Alertable, once per process (not per request).
    if (!switchRowAbsentReported) {
      switchRowAbsentReported = true;
      emitAnomaly({ kind: 'blog_kill_switch_row_absent', severity: 'critical', message: 'blog_kill_switch_row_absent',
        metadata: { jobType: BLOG_KILL_SWITCH_JOB_TYPE } });
    }
    return null;
  }
  if (cfg.enabled === false) {
    return { ok: false, status: 403, code: 'BLOG_GENERATION_DISABLED', retryable: false, error: 'Blog generation is turned off for this account.' };
  }
  return null;
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

/** A stored, already-charged blog for this org + key: replay it; a read error refuses (503, retryable). */
export async function blogReplay(orgId: string, referenceId: string): Promise<{ ok: true; body: Record<string, unknown> | null } | BlogRefusal> {
  try {
    const stored = await loadBilledResult({ scope: BLOG_REPLAY_SCOPE, orgId, key: referenceId });
    if (!stored.found) return { ok: true, body: null };
    const v = stored.value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('stored blog result is not an object');
    return { ok: true, body: { ...(v as Record<string, unknown>), billing: { charged: 0, released: 0, reason: 'replayed' } } };
  } catch (err) {
    logger.error('blog_replay_read_failed', { orgId, message: (err as Error)?.message });
    return { ok: false, status: 503, code: 'BLOG_RESULT_READ_FAILED', retryable: true, error: 'We could not load this blog right now. Please try again.' };
  }
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
export const BLOG_REFUND_REFERENCE_TYPE = 'blog_refund';
const PROTECTED_ORG_PREFIXES = ['73e5fa6f'];   // Embrosales: never touched by automation
export function blogUnavailableRefundedText(credits: number): string {
  return `We couldn't recover this blog, so your ${credits} credits have been returned. You can write it again.`;
}

async function refundUnavailableBlog(args: { orgId: string; userId: string; referenceId: string }): Promise<BlogRefusal> {
  const confirmKey = getReservationKeys(makeIdempotencyKey(args.orgId, BLOG_ACTION, args.referenceId)).confirmKey;
  emitAnomaly({ organizationId: args.orgId, kind: 'blog_result_lost', severity: 'critical', message: 'blog_result_lost',
    metadata: { referenceId: args.referenceId } });
  if (PROTECTED_ORG_PREFIXES.some((p) => args.orgId.toLowerCase().startsWith(p))) {
    return { ok: false, status: 409, code: 'BLOG_RESULT_UNAVAILABLE', retryable: false,
      error: 'This blog was already generated and charged, but we could not return it. We will review the charge.' };
  }
  const retry: BlogRefusal = { ok: false, status: 503, code: 'BLOG_REFUND_PENDING', retryable: true,
    error: 'We could not recover this blog and are returning your credits. Please try again in a moment.' };
  try {
    const { data, error } = await supabase
      .from('credit_transactions')
      .select('id, execution_phase, free_delta, paid_delta, incentive_delta')
      .eq('idempotency_key', confirmKey)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as { id: string; execution_phase: string | null; free_delta: number | null; paid_delta: number | null; incentive_delta: number | null } | null;
    if (!row || !['confirm', 'confirm_partial'].includes(String(row.execution_phase))) throw new Error('original confirm row not found');
    const parts: Array<[CreditCategory, number]> = [
      ['free', Math.abs(Number(row.free_delta ?? 0))],
      ['paid', Math.abs(Number(row.paid_delta ?? 0))],
      ['incentive', Math.abs(Number(row.incentive_delta ?? 0))],
    ];
    const total = parts.reduce((n, [, v]) => n + v, 0);
    if (!(total > 0)) throw new Error('original confirm moved no credits');
    for (const [category, amount] of parts) {
      if (amount <= 0) continue;
      await createCredit({
        orgId: args.orgId, amount, category,
        referenceType: BLOG_REFUND_REFERENCE_TYPE, referenceId: row.id,
        note: `Blog result unavailable - original charge returned (confirm ${row.id})`,
        performedBy: args.userId,
        idempotencyKey: `blog_refund:${row.id}:${category}`,   // keyed on the ORIGINAL settle: exactly once
      });
    }
    await emitFinancialAudit({ actorUserId: args.userId, actionType: 'system_refund', organizationId: args.orgId,
      amountCredits: total, reasonType: 'system', reason: 'blog_result_unavailable', ledgerIdempotencyKey: `blog_refund:${row.id}`,
      metadata: { referenceId: args.referenceId, confirmTransactionId: row.id } });
    logger.info('blog_result_unavailable_refunded', { orgId: args.orgId, referenceId: args.referenceId, confirmId: row.id, credits: total });
    return { ok: false, status: 409, code: 'BLOG_RESULT_UNAVAILABLE', retryable: false, error: blogUnavailableRefundedText(total) };
  } catch (err) {
    // Never a promise we did not keep: the refund is not claimed until it is written.
    logger.error('blog_result_unavailable_refund_failed', { orgId: args.orgId, referenceId: args.referenceId, message: (err as Error)?.message });
    return retry;
  }
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
