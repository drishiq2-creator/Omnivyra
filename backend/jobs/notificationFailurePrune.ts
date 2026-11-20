/**
 * Prune public.notification_delivery_failures rows older than RETENTION_DAYS (b3 ruling (B), a9 2026-11-20).
 *
 * BATCHED (no long lock): select up to BATCH ids older than the cutoff, delete exactly those ids, repeat - at most
 * MAX_BATCHES per run, so one run is bounded; the next run continues. IDEMPOTENT: it deletes by a cutoff, so a re-run
 * deletes nothing twice. Safe for the alerts: the exporter publishes WINDOWED counts (<= 30 minutes), never a running
 * total, so deleting 90-day-old rows cannot move a metric.
 *
 * A failed read or delete is LOGGED and returned as { ok: false } - it is never reported as "done" (b3: a read
 * failure is never absence). Registered in backend/scheduler/cron.ts (daily) and in ALWAYS_RUN_JOBS: it is
 * infrastructure, not feature work, and an unregistered job silently never runs.
 */
import { ownedDbTable } from '../db/writeOwner';

export const RETENTION_DAYS = 90;
export const BATCH = 1000;
export const MAX_BATCHES = 20;

export type PruneResult =
  | { ok: true; deleted: number; batches: number; more: boolean }
  | { ok: false; deleted: number; batches: number; stage: 'read' | 'delete'; error: string };

export async function pruneNotificationFailures(now: number = Date.now()): Promise<PruneResult> {
  const cutoff = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let deleted = 0;
  let batches = 0;
  for (; batches < MAX_BATCHES; batches++) {
    let ids: string[];
    try {
      const { data, error } = await ownedDbTable('notification_delivery_failures')
        .select('id')
        .lt('created_at', cutoff)
        .order('created_at', { ascending: true })
        .limit(BATCH);
      if (error) throw new Error(String(error.message ?? 'read error'));
      ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[notificationFailurePrune] read failed - NOT done', { deleted, batches, message: message.slice(0, 200) });
      return { ok: false, deleted, batches, stage: 'read', error: message };
    }
    if (ids.length === 0) return { ok: true, deleted, batches, more: false };
    try {
      const { error } = await ownedDbTable('notification_delivery_failures').delete().in('id', ids);
      if (error) throw new Error(String(error.message ?? 'delete error'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[notificationFailurePrune] delete failed - NOT done', { deleted, batches, message: message.slice(0, 200) });
      return { ok: false, deleted, batches, stage: 'delete', error: message };
    }
    deleted += ids.length;
    if (ids.length < BATCH) return { ok: true, deleted, batches: batches + 1, more: false };
  }
  return { ok: true, deleted, batches, more: true };
}
