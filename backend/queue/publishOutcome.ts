/**
 * Publish outcome evidence — when may a publish be attempted (again)?
 *
 * No platform adapter here can make post creation idempotent: none sends an
 * idempotency key or a client request id, so calling the platform twice for
 * one scheduled post can publish it twice. A retry is therefore only safe when
 * there is EVIDENCE that the previous attempt did not create a post. Absence of
 * evidence is not evidence: an attempt whose outcome cannot be shown to be a
 * rejection is recorded as PUBLISH_OUTCOME_UNCERTAIN and is never retried
 * automatically. A person reconciles it against the platform first (see
 * backend/services/publishOutcomeReconciliation.ts).
 *
 * Durable state lives in `scheduled_posts.error_code` (an existing column — no
 * migration), per row, so the queue worker, the thread orchestrator (queue
 * re-delivery AND operator resume), the stuck-publishing sweeper and the
 * blueprint guard all read the same fact:
 *
 *   PUBLISH_CLAIMED:<token>   — written WITH status 'publishing' by the claim
 *                               (single posts and thread nodes). No platform
 *                               call has started. The token fences the claim:
 *                               only the execution holding it can move the row
 *                               on to PUBLISH_CALL_STARTED.
 *   PUBLISH_CALL_STARTED      — written, compare-and-set FROM the holder's own
 *                               PUBLISH_CLAIMED:<token>, immediately before the
 *                               platform call. A row still carrying it was
 *                               interrupted at or after the call. It never
 *                               means "published", and it is never taken over.
 *   PUBLISH_OUTCOME_UNCERTAIN — the attempt may have created the post.
 *   PUBLISH_RECONCILED_NOT_PUBLISHED
 *                             — a person checked the platform and found no
 *                               post; the row may be retried.
 *   any other code            — a classified failure (retry follows the
 *                               ordinary policy).
 */

import { PUBLISH_OUTCOME_UNCERTAIN } from './publishRetryState';

export { PUBLISH_OUTCOME_UNCERTAIN };
export const PUBLISH_CALL_STARTED = 'PUBLISH_CALL_STARTED' as const;
export const PUBLISH_RECONCILED_NOT_PUBLISHED = 'PUBLISH_RECONCILED_NOT_PUBLISHED' as const;
/** A failure recorded before any platform request was sent — safe to retry. */
export const PUBLISH_NOT_ATTEMPTED = 'PUBLISH_NOT_ATTEMPTED' as const;
/** Prefix of the claim token stored in error_code while 'publishing', pre-call. */
export const PUBLISH_CLAIMED_PREFIX = 'PUBLISH_CLAIMED:' as const;

/** The error_code value that records a claim held under `token`. */
export function publishClaimCode(token: string): string {
  return `${PUBLISH_CLAIMED_PREFIX}${token}`;
}

/**
 * Marker at the start of the claim TOKEN taken by a manual publish-now that
 * supersedes the post's queued publish jobs (publishNowService
 * `supersede_queued_jobs`). The stored claim then reads
 * `PUBLISH_CLAIMED:SUPERSEDE:<uuid>`: it is still an ordinary pre-call claim
 * (isPreCallClaim, publishClaimCode and every compare-and-set on the token
 * treat it exactly like `PUBLISH_CLAIMED:<uuid>`), and it carries, in the SAME
 * write that took the post, the evidence that a supersede was in progress.
 *
 * Why the marker must travel with the first write: while such a claim is still
 * pre-call, the post's queued job may be ALIVE (its cancel failed, and the
 * fence write that would have taken the row out of reach failed too, or the
 * holder died before the cancel finished). A marked pre-call claim must
 * therefore never become claimable again: it is not taken over when stale
 * (claimScheduledPostForPublish) and the stuck-publishing sweeper fences it to
 * 'cancelled' / PRIOR_JOB_CANCEL_FAILED, never 'failed' / PUBLISH_NOT_ATTEMPTED.
 * No second write is needed to record it, so no second write can fail.
 */
export const PUBLISH_SUPERSEDE_CLAIM_MARK = 'SUPERSEDE:' as const;
/** `PUBLISH_CLAIMED:SUPERSEDE:` — the error_code prefix of a marked claim. */
export const PUBLISH_SUPERSEDE_CLAIM_PREFIX = `${PUBLISH_CLAIMED_PREFIX}${PUBLISH_SUPERSEDE_CLAIM_MARK}` as const;

/** The claim token a superseding publish-now holds: `SUPERSEDE:<nonce>`. */
export function supersedeClaimToken(nonce: string): string {
  return `${PUBLISH_SUPERSEDE_CLAIM_MARK}${nonce}`;
}

/**
 * Terminal fence for a post whose queued publish job could not be shown
 * retired: status 'cancelled' (no publisher claims it, the publish
 * authorization gate does not release it, the cron never selects it) with this
 * code. Written by publishNow (from its own marked claim) and by the
 * stuck-publishing sweeper (for a marked claim left pre-call).
 */
export const PRIOR_JOB_CANCEL_FAILED = 'PRIOR_JOB_CANCEL_FAILED' as const;
export const PRIOR_JOB_CANCEL_FAILED_MESSAGE =
  'Not posted: its queued publish job could not be retired, so it was cancelled to prevent a later or duplicate post.';

/**
 * Prefix of the claim a tenant retry (POST /api/scheduler/retry) writes on a
 * 'failed' post BEFORE it touches the post's queue jobs:
 * RETRY_PREPARING:<epochMs>:<uuid>, compare-and-set on the error_code it read.
 * The post stays 'failed' (not claimable by any publisher), and only the holder
 * may cancel the prior jobs and reset the post — a losing concurrent retry is
 * refused before it can cancel anything (Closure-014C). A claim older than
 * RETRY_CLAIM_STALE_MS is dead (its request outlived every function timeout)
 * and may be taken over.
 */
export const RETRY_PREPARING_PREFIX = 'RETRY_PREPARING:' as const;
export const RETRY_CLAIM_STALE_MS = 15 * 60 * 1000;

export function retryPreparingCode(nowMs: number, token: string): string {
  return `${RETRY_PREPARING_PREFIX}${nowMs}:${token}`;
}

/** 'live' while a retry may still be acting on the post, 'stale' once it is provably dead, null if not a retry claim. */
export function retryClaimState(errorCode: string | null | undefined, nowMs: number): 'live' | 'stale' | null {
  return timedFenceState(errorCode, RETRY_PREPARING_PREFIX, nowMs);
}

/**
 * Did a `cancelScheduledPostQueueEntry` run (backend/scheduler) leave a publish
 * job whose state is UNDECIDED, i.e. one that may still publish? True when any
 * `queue_jobs` step reported an error: the old job's database state is then
 * unknown. A BullMQ removal error alone does not count, because the row is
 * already 'cancelled' and the worker obeys that (publishProcessor refuses a
 * cancelled row).
 *
 * Shared by every caller that supersedes a post's queued attempt with its own:
 * the tenant retry (pages/api/scheduler/retry.ts, Closure-014C) and the manual
 * publish-now (publishNowService `supersede_queued_jobs`). It lives in this pure
 * module, not beside the cancel helper, so suites that stub the scheduler
 * module keep the real predicate.
 */
export function queueCancelLeftJobUndecided(cancel: { errors: string[] }): boolean {
  return cancel.errors.some((e) => e.startsWith('queue_jobs'));
}

/**
 * Prefix of the fence an activity-workspace reschedule writes on a single post
 * TOGETHER WITH the new time (one compare-and-set), holds while it writes the
 * plan row and re-queues, and clears last: RESCHEDULING:<epochMs>:<uuid>.
 * Another reschedule that reads a live fence is refused before it writes
 * anything, so reschedules of one post serialize and no compensating undo can
 * restore another request's transient write (Closure-014C). Not a publisher
 * block: a publisher's claim pins the error_code it read, exactly as before.
 * A fence older than RETRY_CLAIM_STALE_MS is dead and may be taken over.
 */
export const RESCHEDULING_PREFIX = 'RESCHEDULING:' as const;

export function reschedulingCode(nowMs: number, token: string): string {
  return `${RESCHEDULING_PREFIX}${nowMs}:${token}`;
}

export function reschedulingFenceState(errorCode: string | null | undefined, nowMs: number): 'live' | 'stale' | null {
  return timedFenceState(errorCode, RESCHEDULING_PREFIX, nowMs);
}

function timedFenceState(errorCode: string | null | undefined, prefix: string, nowMs: number): 'live' | 'stale' | null {
  if (typeof errorCode !== 'string' || !errorCode.startsWith(prefix)) return null;
  const at = Number(errorCode.slice(prefix.length).split(':')[0]);
  if (!Number.isFinite(at)) return 'live';
  return nowMs - at > RETRY_CLAIM_STALE_MS ? 'stale' : 'live';
}

/**
 * Prefix of the fence a thread re-schedule writes on every child it is about
 * to replace (THREAD_RESCHEDULING:<token>), compare-and-set on the state it
 * read. A publisher reads a fenced child as held (publishOutcomeBlocksAttempt
 * → 'in_flight') and never claims it; a publisher that claimed the child
 * first makes the fence write miss, and the re-schedule is refused.
 */
export const THREAD_RESCHEDULING_PREFIX = 'THREAD_RESCHEDULING:' as const;

export function threadReschedulingCode(token: string): string {
  return `${THREAD_RESCHEDULING_PREFIX}${token}`;
}

/** How a thread re-schedule must treat an existing node (root or child). */
export type ThreadNodeIdentity =
  /** Has an external identity (platform_post_id) or is recorded published. */
  | 'published'
  /** A publisher holds it, or a call may be in flight, or a re-schedule fences it. */
  | 'in_flight'
  /** Its last attempt may have published it; only reconciliation resolves it. */
  | 'uncertain'
  /** Never reached the platform as far as its own row proves. */
  | 'replaceable';

/**
 * Classify an existing thread node for a re-schedule. Only a 'replaceable'
 * node may be deleted, rewritten or re-published by a re-schedule: it has no
 * external identity to lose. Everything else is refused, never silently
 * converted into a new publishable node.
 */
export function classifyThreadNodeIdentity(row: PostOutcomeEvidence): ThreadNodeIdentity {
  return classifyPublishIdentity(row, { missingCodeIsUncertain: true });
}

/**
 * The same classification for a standalone post (unschedule / re-time): a
 * code-less failure of a SINGLE post is an ordinary legacy failure, not an
 * uncertain one (only thread nodes were written without codes).
 */
export function classifySinglePostIdentity(row: PostOutcomeEvidence): ThreadNodeIdentity {
  return classifyPublishIdentity(row, { missingCodeIsUncertain: false });
}

function classifyPublishIdentity(row: PostOutcomeEvidence, options: { missingCodeIsUncertain: boolean }): ThreadNodeIdentity {
  const status = String(row.status ?? '').toLowerCase();
  if (row.platform_post_id || status === 'published') return 'published';
  const blocked = publishOutcomeBlocksAttempt(row, options);
  if (blocked === 'in_flight') return 'in_flight';
  if (blocked === 'uncertain') return 'uncertain';
  return 'replaceable';
}

/**
 * True when the row records a claim taken by the current protocol and NO
 * platform call has started under it. Only such a claim may ever be taken
 * over (by a stale-claim takeover or the sweeper): replacing its token fences
 * the previous holder out of the marker write, so that holder can never start
 * a call afterwards. Elapsed time alone proves nothing.
 */
export function isPreCallClaim(row: { status?: string | null; error_code?: string | null }): boolean {
  return String(row.status ?? '').toLowerCase() === 'publishing'
    && typeof row.error_code === 'string'
    && row.error_code.startsWith(PUBLISH_CLAIMED_PREFIX)
    && row.error_code.length > PUBLISH_CLAIMED_PREFIX.length;
}

/**
 * A pre-call claim taken by a superseding publish-now
 * (PUBLISH_CLAIMED:SUPERSEDE:...): its post may still have a live queued job.
 * Fails closed: anything carrying the marker prefix counts, nonce or not.
 */
export function isSupersedePreCallClaim(row: { status?: string | null; error_code?: string | null }): boolean {
  return isPreCallClaim(row)
    && (row.error_code as string).startsWith(PUBLISH_SUPERSEDE_CLAIM_PREFIX);
}

/**
 * Adapter failure codes that PROVE no post was created: the failure happened
 * before the create-post request was sent, or the platform answered that
 * request with an explicit rejection (400/401/403/422/429, quota). Anything not
 * listed here — 5xx, network errors, the generic *_API_ERROR codes (which mix
 * 5xx, unmapped 4xx, network resets and malformed 2xx bodies), the generic
 * TikTok/Pinterest/Spotify codes (step unknown), an escaped throw — is
 * ambiguous. `retryable: true` is NOT evidence and is ignored here.
 */
const NO_POST_CREATED_CODES: ReadonlySet<string> = new Set([
  // Pre-send (before the create-post request).
  'MEDIA_WOULD_BE_STRIPPED',
  'LINKEDIN_NO_USER_ID',
  'LINKEDIN_MIXED_MEDIA_UNSUPPORTED',
  'LINKEDIN_MEDIA_CACHE_WRITE_FAILED',
  'LINKEDIN_MEDIA_FETCH_FAILED',
  'LINKEDIN_MEDIA_KIND_UNSUPPORTED',
  'LINKEDIN_MEDIA_PUT_FAILED',
  'LINKEDIN_MEDIA_REGISTER_FAILED',
  'LINKEDIN_MEDIA_TOO_LARGE',
  'LINKEDIN_VIDEO_FINALIZE_FAILED',
  'LINKEDIN_VIDEO_PROCESSING_FAILED',
  'FACEBOOK_NO_PAGE_TARGET',
  'FACEBOOK_NO_PAGE_TOKEN',
  'FACEBOOK_PAGE_SELECTION_REQUIRED',
  'YOUTUBE_NO_TITLE',
  'API_NOT_AVAILABLE',
  // Explicit HTTP rejection of the create-post request.
  'LINKEDIN_VERSION_EXPIRED',
  'LINKEDIN_UNAUTHORIZED',
  'LINKEDIN_FORBIDDEN',
  'LINKEDIN_VALIDATION',
  'LINKEDIN_RATE_LIMIT',
  'TWITTER_UNAUTHORIZED',
  'TWITTER_VALIDATION_ERROR',
  'TWITTER_RATE_LIMIT',
  'FACEBOOK_UNAUTHORIZED',
  'FACEBOOK_PERMISSION_DENIED',
  'FACEBOOK_VALIDATION_ERROR',
  'FACEBOOK_RATE_LIMIT',
  'INSTAGRAM_UNAUTHORIZED',
  'INSTAGRAM_PERMISSION_DENIED',
  'INSTAGRAM_VALIDATION_ERROR',
  'INSTAGRAM_RATE_LIMIT',
  'YOUTUBE_UNAUTHORIZED',
  'YOUTUBE_PERMISSION_DENIED',
  'YOUTUBE_VALIDATION_ERROR',
  'YOUTUBE_RATE_LIMIT',
  'YOUTUBE_QUOTA_EXCEEDED',
]);

export type PublishAttemptOutcome =
  /** Confirmed: the platform returned the new post's id. */
  | 'published'
  /** Confirmed: no post was created. Ordinary retry policy applies. */
  | 'not_created'
  /** The post may exist. Never retry automatically. */
  | 'ambiguous';

export type PublishAttemptResult = {
  success?: boolean;
  platform_post_id?: string | null;
  error?: { code?: string | null; delivery?: 'not_sent' } | null;
} | null | undefined;

/**
 * Classify one adapter result. A success WITHOUT a post id (Instagram and
 * Pinterest can return one) is ambiguous — the post may be live but cannot be
 * recorded — and so is a missing or malformed result.
 */
export function classifyPublishAttempt(result: PublishAttemptResult): PublishAttemptOutcome {
  if (!result || typeof result !== 'object') return 'ambiguous';
  if (result.success === true) {
    return typeof result.platform_post_id === 'string' && result.platform_post_id.trim() !== ''
      ? 'published'
      : 'ambiguous';
  }
  const error = result.error;
  if (!error || typeof error !== 'object') return 'ambiguous';
  if (error.delivery === 'not_sent') return 'not_created';
  return typeof error.code === 'string' && NO_POST_CREATED_CODES.has(error.code) ? 'not_created' : 'ambiguous';
}

export type PostOutcomeEvidence = {
  status?: string | null;
  error_code?: string | null;
  platform_post_id?: string | null;
};

/**
 * Does the row record that a previous attempt may have published it?
 * Decided by the error_code, NOT by the status: a writer that moves the row to
 * 'scheduled' (an edit, a re-schedule, a "publish now" that only re-queues)
 * without reconciling it does not make the post any less possibly-live. Only
 * a 'publishing' row (held — see publishOutcomeBlocksAttempt) and a row with a
 * platform_post_id (published) are excluded.
 */
export function hasUncertainOutcome(row: PostOutcomeEvidence): boolean {
  if (row.platform_post_id) return false;
  const status = String(row.status ?? '').toLowerCase();
  if (status === 'publishing' || status === 'published') return false;
  return row.error_code === PUBLISH_OUTCOME_UNCERTAIN || row.error_code === PUBLISH_CALL_STARTED;
}

/**
 * May a publish attempt start for this row, as far as its OWN durable evidence
 * goes? Refuses:
 *   - 'publishing' — another execution holds it, or one died holding it; the
 *     sweeper owns labelling a dead hold, never a re-run.
 *   - any status carrying PUBLISH_OUTCOME_UNCERTAIN or PUBLISH_CALL_STARTED
 *     (hasUncertainOutcome; the marker survives the previous sweeper, which set
 *     only status/message).
 *   - with `missingCodeIsUncertain`, 'failed' with no code at all. Thread nodes
 *     use this: before this change the orchestrator wrote node failures with no
 *     code, and the previous sweeper did too, so a code-less failed node cannot
 *     be told apart from one swept after its call reached the platform.
 * A row with a platform_post_id is published, not uncertain (callers skip it).
 */
export function publishOutcomeBlocksAttempt(
  row: PostOutcomeEvidence,
  options: { missingCodeIsUncertain?: boolean } = {},
): 'in_flight' | 'uncertain' | null {
  if (row.platform_post_id) return null;
  const status = String(row.status ?? '').toLowerCase();
  if (status === 'publishing') return 'in_flight';
  // Fenced by a thread re-schedule that is about to replace it.
  if (typeof row.error_code === 'string' && row.error_code.startsWith(THREAD_RESCHEDULING_PREFIX)) return 'in_flight';
  if (hasUncertainOutcome(row)) return 'uncertain';
  if (status === 'failed' && !row.error_code && options.missingCodeIsUncertain) return 'uncertain';
  return null;
}

/** A failed row whose outcome is recorded as possibly live (guard / UI use). */
export function isUncertainFailedPost(row: PostOutcomeEvidence): boolean {
  if (row.platform_post_id) return false;
  if (String(row.status ?? '').toLowerCase() !== 'failed') return false;
  return row.error_code === PUBLISH_OUTCOME_UNCERTAIN || row.error_code === PUBLISH_CALL_STARTED;
}

/** Operator-facing message stored with an uncertain outcome. */
export const PUBLISH_OUTCOME_UNCERTAIN_MESSAGE =
  'Publish outcome unknown: the request may have reached the platform but no result was saved. ' +
  'It may already be live — check the platform, then reconcile before retrying.';
