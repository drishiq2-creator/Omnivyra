/**
 * api_idempotency_keys Cleaner — Stuck-Row Remediation Phase B
 *
 * The `withIdempotency` middleware (backend/middleware/withIdempotency.ts)
 * tracks request-level idempotency in a separate table from the billing
 * surface. When a handler crashes between `createRecord('processing')` and
 * the `res.json()` capture, the row is left in `'processing'` forever,
 * causing subsequent requests with the SAME idempotency key to fail with
 * HTTP 409 `IDEMPOTENCY_IN_PROGRESS`.
 *
 * This is exactly the same lifecycle problem we already solved for
 * `billing_operations` — but it lives in a different table that the
 * orchestrator's finally block doesn't reach (because the middleware sits
 * OUTSIDE the orchestrator scope).
 *
 * This module reuses the same approach:
 *   - Find `'processing'` rows older than the SLA window (default 10 min).
 *   - Transition them to `'failed'` with `last_error` documenting the
 *     auto-expiry.
 *   - Emit anomaly + counter so ops sees the signal.
 *
 * Critical invariant: this NEVER touches the ledger. The middleware records
 * only request-hashes + captured responses — no financial state lives here.
 *
 * Wired into the existing `/api/cron/billing-idempotency-expire` cron via
 * `idempotencyExpiryJob.ts`.
 */

import { supabase } from '../../../db/supabaseClient';
import { ownedDbTable } from '../../../db/writeOwner';
import { logger } from '../../logger';
import { emitAnomaly } from '../billingAuditEmitter';
import { incrCounter } from '../billingMetrics';

const DEFAULT_STUCK_WINDOW_SEC = 10 * 60; // 10 minutes

export interface ApiIdempotencyCleanResult {
  scanned:    number;
  cleaned:    number;
  errors:     number;
  staleKeys:  Array<{ scope: string; idempotency_key: string; locked_at: string | null }>;
}

export async function cleanStaleApiIdempotencyKeys(opts?: {
  stuckWindowSec?: number;
  limit?:          number;
  dryRun?:         boolean;
}): Promise<ApiIdempotencyCleanResult> {
  const stuckWindowSec = opts?.stuckWindowSec ?? DEFAULT_STUCK_WINDOW_SEC;
  const limit          = opts?.limit ?? 200;
  const dryRun         = opts?.dryRun ?? false;
  const cutoff         = new Date(Date.now() - stuckWindowSec * 1000).toISOString();

  const result: ApiIdempotencyCleanResult = {
    scanned: 0, cleaned: 0, errors: 0, staleKeys: [],
  };

  // 1. Find stale 'processing' rows. Prefer `locked_at` (set when the row
  //    enters 'processing'); fall back to `updated_at` if `locked_at` is null.
  const { data, error } = await supabase
    .from('api_idempotency_keys')
    .select('id, scope, idempotency_key, locked_at, updated_at, request_id')
    .eq('status', 'processing')
    .or(`locked_at.lt.${cutoff},and(locked_at.is.null,updated_at.lt.${cutoff})`)
    .order('locked_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) {
    logger.error('api_idempotency_clean_scan_failed', { message: error.message });
    return { scanned: 0, cleaned: 0, errors: 1, staleKeys: [] };
  }

  const rows = (data ?? []) as Array<{
    id: string;
    scope: string;
    idempotency_key: string;
    locked_at: string | null;
    updated_at: string | null;
    request_id: string | null;
  }>;
  result.scanned = rows.length;

  for (const row of rows) {
    result.staleKeys.push({
      scope:           row.scope,
      idempotency_key: row.idempotency_key,
      locked_at:       row.locked_at ?? row.updated_at,
    });

    if (dryRun) continue;

    // Transition the row to 'failed' with an audit-able last_error. The
    // update is guarded by status='processing' so we can't accidentally
    // overwrite a row that completed since the scan.
    try {
      const { data: updated, error: updErr } = await ownedDbTable('api_idempotency_keys')
        .update({
          status:       'failed',
          last_error:   'auto_expired_by_idempotency_cron',
          locked_at:    null,
          updated_at:   new Date().toISOString(),
        })
        .eq('id', row.id)
        .eq('status', 'processing')
        .select('id')
        .maybeSingle();

      if (updErr) {
        result.errors += 1;
        logger.warn('api_idempotency_clean_update_failed', {
          id: row.id, scope: row.scope, message: updErr.message,
        });
        continue;
      }
      if (!updated) {
        // Row transitioned to a terminal state between our scan and update.
        // Treat as already-clean; not an error.
        continue;
      }
      result.cleaned += 1;
    } catch (err: unknown) {
      result.errors += 1;
      logger.warn('api_idempotency_clean_threw', {
        id: row.id, message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.cleaned > 0 && !dryRun) {
    incrCounter('stale_operation_recovered_total', result.cleaned);
    incrCounter('idempotency_expired_total', result.cleaned);
    incrCounter('recovery_action_total', result.cleaned);
    emitAnomaly({
      kind: 'reservation_orphan_reaped',
      severity: result.cleaned > 50 ? 'critical' : 'warn',
      message: `api_idempotency_keys cleaner expired ${result.cleaned} stale 'processing' row(s)`,
      metadata: {
        scanned: result.scanned,
        cleaned: result.cleaned,
        errors:  result.errors,
        sample:  result.staleKeys.slice(0, 5),
      },
    });
  }

  logger.info('api_idempotency_clean_completed', {
    scanned: result.scanned,
    cleaned: result.cleaned,
    errors:  result.errors,
    dryRun,
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROPOSAL — terminal-row retention (NOT ENABLED; nothing calls this)
//
// `api_idempotency_keys` has no retention today: the cleaner above only moves
// stale 'processing' rows to 'failed', and no code deletes 'completed' or
// 'failed' rows. No retention interval is established anywhere in the repo
// (code, migrations, docs), and the replay window is a product decision: once a
// 'completed' row is deleted, a client retry with the same key RE-EXECUTES the
// handler instead of replaying the stored response.
//
// This function is therefore inert until an owner decides the interval:
//   • it has NO default retention — without an explicit `retentionSec` it
//     returns `enabled:false` and touches nothing;
//   • a retention below MIN_API_IDEMPOTENCY_RETENTION_SEC is refused;
//   • it is not wired into `runIdempotencyExpiryJob` or any route.
//
// Semantics when enabled:
//   • only terminal rows ('completed' | 'failed') whose `updated_at` (the last
//     state transition) is older than the cutoff; 'processing' rows are never
//     selected and never deleted, stale or not;
//   • criteria never reference caller_id / scope — no tenant-dependent policy,
//     and only `api_idempotency_keys` is touched;
//   • one bounded batch per call, deterministic order (updated_at, id);
//   • the DELETE re-asserts the full predicate (status terminal AND
//     updated_at < cutoff) next to the id list, so a row a concurrent retry
//     re-claimed ('failed' → 'processing', updated_at = now) between the scan
//     and the delete survives;
//   • repeated execution converges (already-deleted ids simply do not match).
// ─────────────────────────────────────────────────────────────────────────────

/** Floor: a retention shorter than one day would cut the replay window below
 *  any reasonable client retry horizon. Refused, not clamped. */
export const MIN_API_IDEMPOTENCY_RETENTION_SEC = 24 * 60 * 60;
const DEFAULT_PURGE_BATCH = 200;
// The id list travels in the PostgREST DELETE URL (~37 bytes per uuid), so the
// batch is capped to keep the request line well under common proxy limits.
const MAX_PURGE_BATCH     = 250;
const TERMINAL_STATUSES   = ['completed', 'failed'] as const;

export interface ApiIdempotencyPurgeResult {
  enabled:      boolean;
  reason?:      'retention_not_configured' | 'retention_below_minimum';
  dryRun:       boolean;
  retentionSec: number | null;
  cutoff:       string | null;
  batchLimit:   number;
  /** Terminal rows older than the cutoff found by the scan (≤ batchLimit). */
  scanned:      number;
  /** Rows actually removed by the guarded DELETE. */
  deleted:      number;
  /** Scanned rows the guarded DELETE did not remove (re-claimed or already gone). */
  skipped:      number;
  errors:       number;
  byStatus:     { completed: number; failed: number };
}

export async function purgeExpiredApiIdempotencyKeys(opts?: {
  /** Required. No default: the retention interval is an owner decision. */
  retentionSec?: number;
  limit?:        number;
  dryRun?:       boolean;
  now?:          () => number;
}): Promise<ApiIdempotencyPurgeResult> {
  const dryRun     = opts?.dryRun ?? false;
  const rawLimit   = Math.floor(opts?.limit ?? DEFAULT_PURGE_BATCH);
  const batchLimit = Math.min(MAX_PURGE_BATCH, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_PURGE_BATCH));
  const retention  = opts?.retentionSec;

  const base: ApiIdempotencyPurgeResult = {
    enabled: false, dryRun, retentionSec: retention ?? null, cutoff: null, batchLimit,
    scanned: 0, deleted: 0, skipped: 0, errors: 0, byStatus: { completed: 0, failed: 0 },
  };

  if (retention === undefined || retention === null || !Number.isFinite(retention)) {
    return { ...base, retentionSec: null, reason: 'retention_not_configured' };
  }
  if (retention < MIN_API_IDEMPOTENCY_RETENTION_SEC) {
    logger.warn('api_idempotency_purge_refused', { retentionSec: retention, minimumSec: MIN_API_IDEMPOTENCY_RETENTION_SEC });
    return { ...base, reason: 'retention_below_minimum' };
  }

  const nowMs  = (opts?.now ?? Date.now)();
  const cutoff = new Date(nowMs - retention * 1000).toISOString();
  const result: ApiIdempotencyPurgeResult = { ...base, enabled: true, cutoff };

  const { data, error } = await supabase
    .from('api_idempotency_keys')
    .select('id, status, updated_at')
    .in('status', [...TERMINAL_STATUSES])
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(batchLimit);

  if (error) {
    logger.error('api_idempotency_purge_scan_failed', { message: error.message });
    return { ...result, errors: 1 };
  }

  const rows = ((data ?? []) as Array<{ id: string; status: string; updated_at: string }>).slice(0, batchLimit);
  result.scanned = rows.length;

  if (rows.length > 0 && !dryRun) {
    const { data: removed, error: delErr } = await ownedDbTable('api_idempotency_keys')
      .delete()
      .in('id', rows.map((r) => r.id))
      // Re-assert the predicate in the DELETE itself (see header).
      .in('status', [...TERMINAL_STATUSES])
      .lt('updated_at', cutoff)
      .select('id, status');

    if (delErr) {
      result.errors += 1;
      logger.warn('api_idempotency_purge_delete_failed', { message: delErr.message, batch: rows.length });
    } else {
      const deletedRows = (removed ?? []) as Array<{ id: string; status: string }>;
      result.deleted = deletedRows.length;
      for (const r of deletedRows) {
        if (r.status === 'completed') result.byStatus.completed += 1;
        else if (r.status === 'failed') result.byStatus.failed += 1;
      }
      result.skipped = result.scanned - result.deleted;
    }
  } else if (dryRun) {
    for (const r of rows) {
      if (r.status === 'completed') result.byStatus.completed += 1;
      else if (r.status === 'failed') result.byStatus.failed += 1;
    }
  }

  logger.info('api_idempotency_purge_completed', {
    dryRun, retentionSec: retention, cutoff, batchLimit,
    scanned: result.scanned, deleted: result.deleted, skipped: result.skipped,
    errors: result.errors, byStatus: result.byStatus,
  });

  return result;
}
