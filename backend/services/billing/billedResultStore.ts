/**
 * Billed result store (b3 ruling + 7c invariant, 2026-11-18, BLOCKING for billing):
 *   NEVER CONFIRM A CHARGE FOR A WORK PRODUCT THAT EXISTS ONLY IN AN UNDELIVERED RESPONSE.
 * A billed generate-and-return route persists its result HERE, and reads it back, BEFORE the charge is confirmed; a
 * retry with the same request identity (the client's Idempotency-Key) replays it - 200, the same result, one charge.
 * If the result cannot be persisted AND read back, the caller must NOT confirm the charge (release instead).
 *
 * Storage: api_idempotency_keys (the existing response store of the withIdempotency middleware), a scope per billed
 * surface, caller_id 'org:<orgId>' - so replay is TENANT-SCOPED by the (scope, caller_id, idempotency_key) unique
 * index, and never collides with middleware rows (whose caller_id is a user id). status 'completed' only. No job
 * deletes completed rows, so a result stays replayable well beyond 24h. response_body = { value } (any JSON value).
 *
 * Lives on the base branch fix/billed-result-recovery-20261118 (cb: one owner of 061 and this module); the blog and
 * engagement-replies branches build on it.
 *
 * TERMINAL REPLAY (b3 ruling 2026-11-18, criteria from 7c): a replay whose stored result cannot be READ used to answer
 * "try again" forever. replayBilledResult counts each failed re-read DURABLY (billed_result_replay_failures, via the
 * atomic record_billed_result_replay_failure) - never in the client or a process - and turns TERMINAL after
 * REPLAY_TERMINAL_FAILURES failures or REPLAY_TERMINAL_MS from the FIRST failure. The caller then takes the refund path.
 */
import { createHash } from 'crypto';
import { ownedDbTable } from '../../db/writeOwner';
import { logger } from '../logger';
import { supabase } from '../../db/supabaseClient';
import { incrCounter } from './billingMetrics';

const TABLE = 'api_idempotency_keys';
const callerOf = (orgId: string) => `org:${orgId}`;

export type BilledResultLookup = { found: false } | { found: true; value: unknown };

/** The stored result for (scope, org, key). THROWS on a read error - a caller must answer 503 retryable, never "start a new request". */
export async function loadBilledResult(a: { scope: string; orgId: string; key: string }): Promise<BilledResultLookup> {
  const { data, error } = await ownedDbTable(TABLE)
    .select('response_body')
    .eq('scope', a.scope)
    .eq('caller_id', callerOf(a.orgId))
    .eq('idempotency_key', a.key)
    .eq('status', 'completed')
    .maybeSingle();
  if (error) throw new Error(`billed_result_read_failed: ${(error as { message?: string }).message ?? 'unknown'}`);
  if (!data) return { found: false };
  const body = (data as { response_body?: unknown }).response_body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('value' in (body as object))) {
    throw new Error('billed_result_read_failed: stored body has no value');
  }
  return { found: true, value: (body as { value: unknown }).value };
}

/**
 * Persist a result and READ IT BACK. True only when a later replay will find it. Never throws (false + logged): the
 * caller then releases instead of confirming. A row that already exists for the key (23505) is read back like any other.
 */
export async function persistBilledResult(a: { scope: string; orgId: string; key: string; value: unknown }): Promise<boolean> {
  try {
    if (a.value === undefined) throw new Error('undefined result');
    const now = new Date().toISOString();
    const { error } = await ownedDbTable(TABLE).insert({
      scope: a.scope,
      caller_id: callerOf(a.orgId),
      idempotency_key: a.key,
      request_hash: createHash('sha256').update(`${a.scope}:${a.orgId}:${a.key}`).digest('hex'),
      status: 'completed',
      response_status: 200,
      response_body: { value: a.value },
      created_at: now,
      updated_at: now,
    });
    if (error) {
      const e = error as { message?: string; code?: string };
      if (e.code !== '23505' && !/duplicate key/i.test(String(e.message ?? ''))) throw new Error(e.message ?? 'insert failed');
    }
    const back = await loadBilledResult(a);
    if (!back.found) throw new Error('not readable back');
    return true;
  } catch (err) {
    logger.error('billed_result_persist_failed', { scope: a.scope, orgId: a.orgId, message: (err as Error)?.message });
    return false;
  }
}

export const REPLAY_TERMINAL_FAILURES = 3;
export const REPLAY_TERMINAL_MS = 24 * 60 * 60 * 1000;

export type BilledReplayOutcome =
  | { kind: 'found'; value: unknown }
  | { kind: 'absent' }
  /** The read failed and the durable count is below the terminal bound (or could not be recorded): retry. */
  | { kind: 'transient'; failures: number | null }
  /** The read has failed REPLAY_TERMINAL_FAILURES times, or for REPLAY_TERMINAL_MS since the first failure: give up -> refund. */
  | { kind: 'terminal'; failures: number; firstFailedAt: string };

/** Replay a stored result; a failed read is counted durably and becomes terminal (b3/7c). Never throws. */
export async function replayBilledResult(a: { scope: string; orgId: string; key: string; now?: Date }): Promise<BilledReplayOutcome> {
  try {
    const r = await loadBilledResult(a);
    return r.found ? { kind: 'found', value: r.value } : { kind: 'absent' };
  } catch (readErr) {
    const message = (readErr as Error)?.message ?? 'unknown';
    try {
      const { data, error } = await supabase.rpc('record_billed_result_replay_failure', {
        p_scope: a.scope, p_caller_id: callerOf(a.orgId), p_key: a.key, p_error: message,
      });
      if (error) throw new Error(error.message);
      const row = (Array.isArray(data) ? data[0] : data) as { failures?: number; first_failed_at?: string } | null;
      const failures = Number(row?.failures);
      const first = row?.first_failed_at ? new Date(row.first_failed_at) : null;
      if (!Number.isFinite(failures) || !first || Number.isNaN(first.getTime())) throw new Error('replay failure count unreadable');
      const now = a.now ?? new Date();
      if (failures >= REPLAY_TERMINAL_FAILURES || now.getTime() - first.getTime() >= REPLAY_TERMINAL_MS) {
        incrCounter('billed_result_replay_terminal_total');
        logger.error('billed_result_replay_terminal', { scope: a.scope, orgId: a.orgId, failures, firstFailedAt: first.toISOString(), message });
        return { kind: 'terminal', failures, firstFailedAt: first.toISOString() };
      }
      logger.warn('billed_result_replay_read_failed', { scope: a.scope, orgId: a.orgId, failures, message });
      return { kind: 'transient', failures };
    } catch (countErr) {
      // The count itself could not be recorded: stay transient (never terminal on an unrecorded count), loudly.
      logger.error('billed_result_replay_failure_unrecorded', { scope: a.scope, orgId: a.orgId, message, countError: (countErr as Error)?.message });
      return { kind: 'transient', failures: null };
    }
  }
}
