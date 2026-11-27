import { hostname } from 'os';
import type { RpaTask, RpaResult, RpaRunContext } from './rpaWorkerService';
import { ownedDbTable, ownedDbRpc } from '../../db/writeOwner';

/**
 * Durable RPA work queue (rpa_retry_queue) with an atomic claim and
 * per-organization fairness.
 *
 * Phase C (20270314000001_rpa_retry_queue_claim):
 *   - every accepted RPA task has a durable row BEFORE anything executes
 *     (`acceptRpaTask`, idempotent per action: a duplicate accept is a no-op);
 *   - a row is executed only by the worker that CLAIMED it
 *     (`claim_rpa_retry_queue`, FOR UPDATE SKIP LOCKED, one token per row), so
 *     overlapping flushes get disjoint rows;
 *   - the outcome is written only when the claim token still matches
 *     (`finalize_rpa_retry_queue_claim`); a late finaliser is refused;
 *   - LOST-RESPONSE RULE: a claim whose lease expired may already have posted.
 *     It is never re-claimed: `park_expired_rpa_retry_claims` parks it as
 *     RPA_OUTCOME_UNKNOWN (attempts = max_attempts), exactly like an outcome the
 *     handler itself reported as unknown.
 *   - success keeps the row as a tombstone (completed_at, attempts =
 *     max_attempts) so the same action can never be accepted and run again.
 *   - LEASE CHECK BEFORE RUNNING (review S-1): `renew_rpa_retry_queue_claim`
 *     is called immediately before a handler runs (and again by the Playwright
 *     handler inside its heavy-job slot). It succeeds only while the token
 *     still holds and the lease is unexpired, and extends the lease. On false
 *     the row is NOT run: a still-held (expired) claim is released as never
 *     attempted (`release_rpa_retry_queue_claim`, attempts unchanged); a claim
 *     already parked stays parked (outcome-unknown) - it was not run here.
 *
 * Phase 9 fairness is unchanged: `flushRpaRetryQueueRoundRobin` visits every
 * org with due work, at most `limit_per_org` claims each, bounded per tick.
 *
 * Backoff: `2^attempts` minutes, capped at 120 minutes. Max attempts is 5.
 */

const MAX_ATTEMPTS = 5;
const DEFAULT_PER_ORG_LIMIT = 10;

// Conservative per-tick global execution cap. A large post-outage backlog
// (worst case ~maxOrgs × limitPerOrg ≈ 1000 serial Chromium sessions in one
// tick) is spread across multiple ticks instead. Env-configurable; does NOT
// change retry counts, backoff, or round-robin fairness — untouched rows
// remain due and drain on the next tick.
const MAX_TASKS_PER_TICK = (() => {
  const o = Number(process.env.RPA_FLUSH_MAX_TASKS_PER_TICK);
  return Number.isInteger(o) && o >= 1 && o <= 1000 ? o : 50;
})();

/**
 * Claim lease. Longer than the executor's RPA hard timeout (5 min) plus the
 * heavy-job slot wait, so a healthy run finalises well inside it. A lease that
 * does expire is parked as outcome-unknown, never re-run.
 */
export const RPA_CLAIM_LEASE_SECONDS = (() => {
  const o = Number(process.env.RPA_CLAIM_LEASE_SECONDS);
  return Number.isInteger(o) && o >= 60 && o <= 3600 ? o : 900;
})();

/** Identity recorded in claimed_by (evidence on a parked expired claim). */
export const rpaWorkerIdentity = (): string => {
  let host = 'unknown-host';
  try { host = hostname() || host; } catch { /* keep default */ }
  return `${host}:${process.pid}`.slice(0, 200);
};

/** Prefix carried by every outcome-unknown result / parked row. */
export const RPA_OUTCOME_UNKNOWN_PREFIX = 'RPA_OUTCOME_UNKNOWN';

const firstLine = (v: unknown, max = 300): string =>
  String((v as any)?.message ?? v ?? '').split(/\r?\n/)[0].slice(0, max);

export type RpaQueueClaim = { queue_id: string; claim_token: string };

export type RpaAcceptResult =
  | { ok: true; accepted: true; queue_id: string; claim: RpaQueueClaim | null }
  | { ok: true; accepted: false; queue_id: string | null; claim: null }
  | { ok: false; error: string };

/** The action id is queued under ANOTHER organization (unique index on action_id alone): refused, no id returned. */
export const RPA_ACCEPT_ORG_MISMATCH = 'RPA_ACCEPT_ORG_MISMATCH';

/**
 * Durable, idempotent enqueue. With `claimFor` the row is born claimed by that
 * worker (the caller executes it now and must finalise it); without it the row
 * is due now and unclaimed (a later worker flush claims it).
 *
 * Idempotency: INSERT ... ON CONFLICT DO NOTHING on the unique action index. A
 * second accept of the same action (queued, running, finished, parked) returns
 * accepted=false and changes nothing.
 */
export async function acceptRpaTask(
  task: RpaTask,
  opts?: { claimFor?: string | null; leaseSeconds?: number },
): Promise<RpaAcceptResult> {
  try {
    const { data, error } = await ownedDbRpc('rpa_retry_queue_accept', {
      p_organization_id: task.organization_id,
      p_action_id: task.action_id,
      p_platform: task.platform,
      p_action_type: task.action_type,
      p_target_url: task.target_url,
      p_text: task.text ?? null,
      p_claimed_by: opts?.claimFor ?? null,
      p_lease_seconds: opts?.claimFor ? (opts.leaseSeconds ?? RPA_CLAIM_LEASE_SECONDS) : null,
    });
    if (error) {
      const msg = firstLine((error as any)?.message || 'RPA_ACCEPT_FAILED');
      // Review N-1: a cross-organization duplicate is a distinct, stable refusal.
      if (msg.includes(RPA_ACCEPT_ORG_MISMATCH)) return { ok: false, error: RPA_ACCEPT_ORG_MISMATCH };
      return { ok: false, error: msg };
    }
    const row = (Array.isArray(data) ? data[0] : data) as
      | { accepted?: boolean; queue_id?: string | null; claim_token?: string | null }
      | null
      | undefined;
    // A null error is not an answer: no row back means we do not know.
    if (!row || typeof row.accepted !== 'boolean') return { ok: false, error: 'RPA_ACCEPT_NO_RESULT' };
    if (row.accepted !== true) {
      return { ok: true, accepted: false, queue_id: row.queue_id ?? null, claim: null };
    }
    if (!row.queue_id) return { ok: false, error: 'RPA_ACCEPT_NO_RESULT' };
    if (opts?.claimFor && !row.claim_token) return { ok: false, error: 'RPA_ACCEPT_CLAIM_MISSING' };
    return {
      ok: true,
      accepted: true,
      queue_id: row.queue_id,
      claim: row.claim_token ? { queue_id: row.queue_id, claim_token: row.claim_token } : null,
    };
  } catch (err: any) {
    return { ok: false, error: firstLine(err || 'RPA_ACCEPT_FAILED') };
  }
}

export type ClaimedRpaRow = {
  id: string;
  action_id: string;
  organization_id: string;
  platform: string;
  action_type: string;
  target_url: string;
  text: string | null;
  attempts: number;
  max_attempts: number;
  claim_token: string;
};

/** Claim up to `limit` due rows (optionally for one org). Disjoint across concurrent callers. */
export async function claimRpaRetryRows(input: {
  worker: string;
  limit: number;
  organization_id?: string | null;
  leaseSeconds?: number;
}): Promise<{ rows: ClaimedRpaRow[]; error: string | null }> {
  try {
    const { data, error } = await ownedDbRpc('claim_rpa_retry_queue', {
      p_claimed_by: input.worker,
      p_lease_seconds: input.leaseSeconds ?? RPA_CLAIM_LEASE_SECONDS,
      p_limit: input.limit,
      p_organization_id: input.organization_id ?? null,
    });
    if (error) return { rows: [], error: firstLine((error as any)?.message || 'RPA_CLAIM_FAILED') };
    if (!Array.isArray(data)) return { rows: [], error: 'RPA_CLAIM_NO_RESULT' };
    return { rows: data as ClaimedRpaRow[], error: null };
  } catch (err: any) {
    return { rows: [], error: firstLine(err || 'RPA_CLAIM_FAILED') };
  }
}

export type RpaFinalizeOutcome = 'succeeded' | 'failed' | 'unknown';

/**
 * Record a claimed row's outcome. 'finalized' only when the token matched;
 * 'token_mismatch' means the claim was lost (parked after expiry, or never
 * ours) and NOTHING was written.
 */
export async function finalizeRpaClaim(
  claim: RpaQueueClaim,
  outcome: RpaFinalizeOutcome,
  opts?: { error?: string | null; retryDelaySeconds?: number | null; terminal?: boolean },
): Promise<'finalized' | 'token_mismatch' | 'finalize_failed'> {
  try {
    const delay = opts?.retryDelaySeconds;
    const { data, error } = await ownedDbRpc('finalize_rpa_retry_queue_claim', {
      p_queue_id: claim.queue_id,
      p_claim_token: claim.claim_token,
      p_outcome: outcome,
      p_error: opts?.error ? firstLine(opts.error, 480) : null,
      p_retry_delay_seconds: typeof delay === 'number' && delay >= 1 ? Math.min(86400, Math.floor(delay)) : null,
      p_terminal: opts?.terminal === true,
    });
    if (error) return 'finalize_failed';
    if (data === true) return 'finalized';
    if (data === false) return 'token_mismatch';
    return 'finalize_failed';
  } catch {
    return 'finalize_failed';
  }
}

/**
 * Lease check immediately before running (review S-1). 'renewed' only when the
 * token still holds and the lease had not expired (the lease is extended).
 * 'lost' = expired, parked, or never ours: the row must NOT be run.
 * 'renew_failed' = no answer: treated exactly like 'lost' (not run).
 */
export async function renewRpaClaim(
  claim: RpaQueueClaim,
  leaseSeconds: number = RPA_CLAIM_LEASE_SECONDS,
): Promise<'renewed' | 'lost' | 'renew_failed'> {
  try {
    const { data, error } = await ownedDbRpc('renew_rpa_retry_queue_claim', {
      p_queue_id: claim.queue_id,
      p_claim_token: claim.claim_token,
      p_lease_seconds: leaseSeconds,
    });
    if (error) return 'renew_failed';
    if (data === true) return 'renewed';
    if (data === false) return 'lost';
    return 'renew_failed';
  } catch {
    return 'renew_failed';
  }
}

/**
 * Give back a claim this process never attempted (token-matched). attempts is
 * unchanged; the row is due again after `retryDelaySeconds`. 'released' = it
 * is queued again; 'not_held' = the token is gone (already parked by another
 * tick, or finalised): nothing written, and the row is NOT run.
 */
export async function releaseRpaClaimNotAttempted(
  claim: RpaQueueClaim,
  reason: string,
  retryDelaySeconds = 60,
): Promise<'released' | 'not_held' | 'release_failed'> {
  try {
    const { data, error } = await ownedDbRpc('release_rpa_retry_queue_claim', {
      p_queue_id: claim.queue_id,
      p_claim_token: claim.claim_token,
      p_reason: firstLine(reason, 200),
      p_retry_delay_seconds: Math.max(0, Math.min(86400, Math.floor(retryDelaySeconds))),
    });
    if (error) return 'release_failed';
    if (data === true) return 'released';
    if (data === false) return 'not_held';
    return 'release_failed';
  } catch {
    return 'release_failed';
  }
}

/**
 * Build the run context handed to a handler for one claimed row: `renewClaim`
 * re-checks (and extends) the lease. The handler calls it again right before
 * the browser is touched (inside the heavy-job slot), so a long slot wait
 * cannot run an expired claim.
 */
export const rpaRunContextForClaim = (claim: RpaQueueClaim): RpaRunContext => ({
  renewClaim: async () => (await renewRpaClaim(claim)) === 'renewed',
});

/** Error carried by a result whose row was never run because its claim was lost before the handler. */
export const RPA_CLAIM_LOST = 'RPA_CLAIM_LOST';

/** Park every expired claim as outcome-unknown (never re-run). Returns the count or an error. */
export async function parkExpiredRpaClaims(): Promise<{ parked: number; error: string | null }> {
  try {
    const { data, error } = await ownedDbRpc('park_expired_rpa_retry_claims', {});
    if (error) return { parked: 0, error: firstLine((error as any)?.message || 'RPA_PARK_FAILED') };
    if (typeof data !== 'number') return { parked: 0, error: 'RPA_PARK_NO_RESULT' };
    return { parked: data, error: null };
  } catch (err: any) {
    return { parked: 0, error: firstLine(err || 'RPA_PARK_FAILED') };
  }
}

/**
 * Cheap pre-check for the scheduler: how many rows need the flush now — due,
 * unclaimed, live rows, plus expired claims waiting to be parked. A head-only
 * count, no rows returned. The flush calls this BEFORE the platform policy read
 * and BEFORE the Chromium readiness probe, so an empty queue never launches a
 * browser. A read error is returned as `error`, never as "0 due".
 */
export async function countDueRpaRetries(): Promise<{ due: number; error: string | null }> {
  try {
    const nowIso = new Date().toISOString();
    const { count, error } = await ownedDbTable('rpa_retry_queue')
      .select('id', { count: 'exact', head: true })
      .lte('next_retry_at', nowIso)
      .lt('attempts', MAX_ATTEMPTS)
      .or(`claim_token.is.null,claim_expires_at.lte.${nowIso}`);
    if (error) return { due: 0, error: (error as any)?.message || 'RPA_RETRY_COUNT_FAILED' };
    if (typeof count !== 'number') return { due: 0, error: 'RPA_RETRY_COUNT_MISSING' };
    return { due: count, error: null };
  } catch (err: any) {
    return { due: 0, error: err?.message || 'RPA_RETRY_COUNT_FAILED' };
  }
}

type PerOrgFlushOutcome = {
  organization_id: string;
  claimed: number;
  succeeded: number;
  failed: number;
  /** Executed with an unknown outcome — parked, not failed, not retried. */
  unknown: number;
  /** Claimed but NOT run: the lease check before the handler failed (released or left parked). */
  claim_lost: number;
  errors: number;
};

/**
 * Claim and run up to `limit` rows for ONE organization, ONE ROW AT A TIME
 * (review S-1: a batch claim let later rows' leases run out while earlier rows
 * executed). Each row is claimed, its lease re-checked (renew) immediately
 * before the handler, run, and finalised through the token-matched finaliser.
 * Success = tombstone; definite failure = attempts + 1 with exponential backoff
 * (or retired when terminal); unknown / handler throw = parked, never re-run.
 * A lost lease before the handler = not run (released as never attempted when
 * the token is still held). A finaliser that cannot write leaves the claim in
 * place: it expires and is parked as unknown, so the row is never run twice.
 */
export async function flushRpaRetryQueueForOrg(input: {
  organization_id: string;
  handler: (task: RpaTask, ctx?: RpaRunContext) => Promise<RpaResult>;
  limit?: number;
  worker?: string;
}): Promise<PerOrgFlushOutcome> {
  const { organization_id: orgId, handler } = input;
  const limit = input.limit ?? DEFAULT_PER_ORG_LIMIT;
  const worker = input.worker ?? rpaWorkerIdentity();
  let claimed = 0, succeeded = 0, failed = 0, unknown = 0, claimLost = 0, errors = 0;
  const out = () => ({ organization_id: orgId, claimed, succeeded, failed, unknown, claim_lost: claimLost, errors });

  for (let i = 0; i < limit; i += 1) {
    const claim = await claimRpaRetryRows({ worker, limit: 1, organization_id: orgId });
    if (claim.error) {
      console.warn('[rpaRetryQueue] claim failed:', claim.error, 'org=', orgId);
      errors += 1;
      return out();
    }
    const row = claim.rows[0];
    if (!row) break;
    claimed += 1;
    const token: RpaQueueClaim = { queue_id: String(row.id), claim_token: String(row.claim_token) };
    const note = (r: 'finalized' | 'token_mismatch' | 'finalize_failed') => {
      if (r === 'finalized') return;
      errors += 1;
      console.warn(`[rpaRetryQueue] finalise ${r} org=${orgId} row=${row.id}`);
    };
    const notRun = async (why: string) => {
      claimLost += 1;
      const rel = await releaseRpaClaimNotAttempted(token, why);
      console.warn(`[rpaRetryQueue] claim lost before run (${why}); row NOT run, release=${rel} org=${orgId} row=${row.id}`);
    };
    const ctx = rpaRunContextForClaim(token);
    // Lease check immediately before the handler.
    if (!(await ctx.renewClaim!())) {
      await notRun('LEASE_CHECK_BEFORE_HANDLER');
      continue;
    }
    let result: RpaResult;
    try {
      const task: RpaTask = {
        tenant_id: row.organization_id,
        organization_id: row.organization_id,
        platform: row.platform,
        action_type: row.action_type as RpaTask['action_type'],
        target_url: row.target_url,
        text: row.text ?? null,
        action_id: row.action_id,
      };
      result = await handler(task, ctx);
    } catch (err: any) {
      // The handler may have thrown mid-action (after a click/submit): unknown.
      unknown += 1;
      const msg = firstLine(err || 'HANDLER_THREW', 200);
      console.warn(`[rpaRetryQueue] handler threw; outcome unknown, row parked org=${orgId} row=${row.id}: ${msg}`);
      note(await finalizeRpaClaim(token, 'unknown', { error: `HANDLER_THREW:${msg}` }));
      continue;
    }
    if (result?.claim_lost === true) {
      // The handler's own lease check (inside the heavy-job slot) failed: not run.
      await notRun('LEASE_CHECK_IN_HANDLER');
    } else if (result?.success) {
      succeeded += 1;
      note(await finalizeRpaClaim(token, 'succeeded'));
    } else if (result?.outcome_unknown) {
      unknown += 1;
      note(await finalizeRpaClaim(token, 'unknown', { error: result.error ?? 'UNKNOWN' }));
    } else {
      failed += 1;
      // Round 26: a terminal refusal (e.g. RPA_RETRY_CONTACT_SUPPRESSED) is retired at once, not retried.
      note(await finalizeRpaClaim(token, 'failed', {
        error: (result?.error ?? 'unknown').toString(),
        terminal: result?.terminal === true,
      }));
    }
  }

  return out();
}

/**
 * Fair round-robin retry flush. Parks expired claims first (lost-response
 * rule), then enumerates organization_ids with at least one due, unclaimed
 * row and visits each one with a bounded per-org claim limit. No org can
 * monopolise the sweep.
 */
export async function flushRpaRetryQueueRoundRobin(input: {
  handler: (task: RpaTask, ctx?: RpaRunContext) => Promise<RpaResult>;
  limitPerOrg?: number;
  maxOrgs?: number;
}): Promise<{
  orgs_visited: number;
  claimed: number;
  succeeded: number;
  failed: number;
  unknown: number;
  /** Claimed but not run (lease lost before the handler). */
  claim_lost: number;
  errors: number;
  /** Rows still eligible to run later: unclaimed, not completed, attempts < max (due now or backed off). */
  remaining: number;
  /** Expired claims parked as outcome-unknown this tick. */
  parked_expired: number;
  per_org?: PerOrgFlushOutcome[];
}> {
  const limitPerOrg = input.limitPerOrg ?? DEFAULT_PER_ORG_LIMIT;
  const maxOrgs = input.maxOrgs ?? 100;
  const worker = rpaWorkerIdentity();
  let errors = 0;

  const park = await parkExpiredRpaClaims();
  if (park.error) {
    errors += 1;
    console.warn('[rpaRetryQueue] expired-claim park failed:', park.error);
  } else if (park.parked > 0) {
    console.warn(`[rpaRetryQueue] parked ${park.parked} expired claim(s) as ${RPA_OUTCOME_UNKNOWN_PREFIX} (never re-run)`);
  }

  // Distinct org enumeration from the queue itself — orgs with no due,
  // unclaimed rows are skipped. Up to 10× maxOrgs candidate rows, deduped.
  let orgIds: string[] = [];
  try {
    const { data, error } = await ownedDbTable('rpa_retry_queue')
      .select('organization_id')
      .lte('next_retry_at', new Date().toISOString())
      .lt('attempts', MAX_ATTEMPTS)
      .is('claim_token', null)
      .order('next_retry_at', { ascending: true })
      .limit(maxOrgs * 10);
    if (error) throw error;
    const seen = new Set<string>();
    for (const r of (data || []) as Array<{ organization_id: string }>) {
      if (r.organization_id && !seen.has(r.organization_id)) {
        seen.add(r.organization_id);
        if (seen.size >= maxOrgs) break;
      }
    }
    orgIds = Array.from(seen);
  } catch (err: any) {
    console.warn('[rpaRetryQueue] org enumeration failed:', err?.message || err);
    return { orgs_visited: 0, claimed: 0, succeeded: 0, failed: 0, unknown: 0, claim_lost: 0, errors: errors + 1, remaining: 0, parked_expired: park.parked };
  }

  const perOrg: PerOrgFlushOutcome[] = [];
  let claimed = 0, succeeded = 0, failed = 0, unknown = 0, claimLost = 0;
  let budget = MAX_TASKS_PER_TICK;
  for (const orgId of orgIds) {
    if (budget <= 0) break; // per-tick cap reached — remaining orgs drain next tick
    const outcome = await flushRpaRetryQueueForOrg({
      organization_id: orgId,
      handler: input.handler,
      limit: Math.min(limitPerOrg, budget),
      worker,
    });
    perOrg.push(outcome);
    claimed += outcome.claimed;
    succeeded += outcome.succeeded;
    failed += outcome.failed;
    unknown += outcome.unknown;
    claimLost += outcome.claim_lost;
    errors += outcome.errors;
    budget -= outcome.claimed;
  }

  // Remaining backlog across all orgs (review N-6): only rows that can still
  // run — not claimed (in flight), not a success tombstone, attempts left. Rows
  // backed off to a later next_retry_at are still backlog. Parked
  // outcome-unknown rows and tombstones (attempts = max) are excluded.
  let remaining = 0;
  try {
    const { count, error } = await ownedDbTable('rpa_retry_queue')
      .select('id', { count: 'exact', head: true })
      .is('claim_token', null)
      .is('completed_at', null)
      .lt('attempts', MAX_ATTEMPTS);
    if (error || typeof count !== 'number') errors += 1;
    else remaining = count;
  } catch {
    errors += 1;
  }

  return {
    orgs_visited: orgIds.length,
    claimed,
    succeeded,
    failed,
    unknown,
    claim_lost: claimLost,
    errors,
    remaining,
    parked_expired: park.parked,
    per_org: perOrg,
  };
}
