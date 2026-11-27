/**
 * Round 28 — the ONLY statuses `community_ai_actions.status` may hold.
 *
 * Production's `community_ai_actions_status_check` admits exactly
 *   pending | approved | executed | failed | skipped
 * (CT-verified; repo baseline `supabase/_schema/baseline.sql:205`). The
 * executor's in-memory vocabulary is wider (`dispatched`, `blocked`,
 * `sent_unverified`), and a write of any of those is rejected by the CHECK:
 * the row then stays `pending` and is re-offered. Every persistence path maps
 * through `toPersistedCommunityActionStatus`; the in-memory/API status the
 * caller sees is unchanged.
 *
 * Lost-response class (never `failed`, which is retryable; never `executed`,
 * which claims platform confirmation):
 *   - `sent_unverified` (the send was issued, confirmation not observable)
 *     → `skipped` + skip_reason `SENT_UNVERIFIED`;
 *   - an RPA outcome the executor cannot know (timeout / post-interaction
 *     crash) arrives as `skipped` + reason `OUTCOME_UNKNOWN`
 *     → `skipped` + skip_reason `OUTCOME_UNKNOWN`.
 * `skipped` is terminal for every automated reader: the extension hand-out
 * offers only `pending`, the scheduler only `approved`, the RPA retry only
 * `approved`/`failed`, and the manual execute route only
 * `pending`/`approved`/`scheduled`.
 */

export const COMMUNITY_AI_ACTION_DB_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'approved',
  'executed',
  'failed',
  'skipped',
]);

export type CommunityAiActionDbStatus = 'pending' | 'approved' | 'executed' | 'failed' | 'skipped';

export const SENT_UNVERIFIED_SKIP_REASON = 'SENT_UNVERIFIED';
export const OUTCOME_UNKNOWN_SKIP_REASON = 'OUTCOME_UNKNOWN';

/** skip_reason values that mean "a send may have happened" (never re-send). */
export const LOST_RESPONSE_SKIP_REASONS: ReadonlySet<string> = new Set([
  SENT_UNVERIFIED_SKIP_REASON,
  OUTCOME_UNKNOWN_SKIP_REASON,
]);

type ResultLike = { status?: unknown; reason?: unknown; error?: unknown };

const reasonOf = (result: ResultLike): string | null => {
  const errorCode =
    result.error && typeof result.error === 'object' ? (result.error as { code?: unknown }).code : result.error;
  const raw = result.reason ?? errorCode ?? '';
  const text = String(raw ?? '').slice(0, 200);
  return text || null;
};

export function toPersistedCommunityActionStatus(result: ResultLike): {
  status: CommunityAiActionDbStatus;
  skip_reason: string | null;
} {
  const status = String(result?.status ?? '');
  switch (status) {
    case 'dispatched':
      // Queued for the extension; the lease fields (not the status) prove ownership.
      return { status: 'pending', skip_reason: null };
    case 'sent_unverified':
      return { status: 'skipped', skip_reason: SENT_UNVERIFIED_SKIP_REASON };
    case 'blocked':
    case 'skipped':
      return { status: 'skipped', skip_reason: reasonOf(result) };
    case 'pending':
    case 'approved':
    case 'executed':
    case 'failed':
      return { status, skip_reason: null };
    default:
      // An unmapped executor status must never reach the CHECK (rejected →
      // row stays pending → re-offered) and must never become retryable.
      return { status: 'skipped', skip_reason: `UNMAPPED_STATUS:${status}`.slice(0, 200) };
  }
}

/**
 * The status to SHOW for a stored row (API responses, dedup results): a
 * lost-response `skipped` row is presented as `sent_unverified`, the
 * vocabulary the inbox UI and webhooks already understand ("ran, not
 * confirmed"). Never used for a DB write.
 */
export function presentCommunityActionStatus(row: { status?: unknown; skip_reason?: unknown } | null | undefined): string {
  const status = String(row?.status ?? '');
  if (status === 'skipped' && LOST_RESPONSE_SKIP_REASONS.has(String(row?.skip_reason ?? ''))) return 'sent_unverified';
  return status;
}
