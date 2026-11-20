/**
 * Durable record of an UNDELIVERABLE notification (b3 ruling (B), a9 2026-11-20).
 *
 * WHY: notification_undeliverable is an in-memory, per-process counter. Credit alerts are raised on Vercel too, where
 * each serverless instance keeps its own registry and is usually recycled before any scrape reaches it - so the
 * alert rules could not see most events. Each undeliverable event is therefore ALSO written as one row of
 * public.notification_delivery_failures; the WORKER exports windowed counts computed from that table
 * (backend/observability/notificationFailureExporter.ts), and the alert rules read those.
 *
 * NEVER BREAKS THE CALLER (notifyCompanyEvent runs inside credit paths): the write is bounded by
 * RECORD_TIMEOUT_MS, and any failure - an error, a throw, a timeout - is logged (NOTIFICATION_FAILURE_RECORD_FAILED)
 * and counted (notification_failure_record_failed), then the function returns normally.
 *
 * WRITE RATE IS BOUNDED: at most ONE row per (company, type, reason) per COALESCE_MS in a process. Worst case, an
 * admin-less company consuming credits in a loop writes <= 1 row/min per process for that (type, reason); across
 * Vercel that is <= 1 row/min per live instance. The in-memory counter still counts every event.
 */
import { ownedDbTable } from '../db/writeOwner';
import { recordRawCounter } from '../observability';

export type UndeliverableReason = 'no_active_recipient' | 'membership_unreadable' | 'insert_failed' | 'invalid_input';

export const RECORD_TIMEOUT_MS = 1500;
export const COALESCE_MS = 60_000;
const COALESCE_MAX_KEYS = 5000;

const lastWrite = new Map<string, number>();

/** Test seam: forget the coalesce window. */
export function __resetNotificationFailureCoalesce(): void {
  lastWrite.clear();
}

function coalesced(key: string, now: number): boolean {
  const prev = lastWrite.get(key);
  if (prev !== undefined && now - prev < COALESCE_MS) return true;
  if (lastWrite.size >= COALESCE_MAX_KEYS) {
    for (const [k, t] of lastWrite) if (now - t >= COALESCE_MS) lastWrite.delete(k);
    if (lastWrite.size >= COALESCE_MAX_KEYS) lastWrite.clear(); // bounded memory; worst case one extra row per key
  }
  lastWrite.set(key, now);
  return false;
}

function failed(type: string, reason: string, message: string): void {
  console.error('NOTIFICATION_FAILURE_RECORD_FAILED', JSON.stringify({ type, reason, message: message.slice(0, 200) }));
  try { recordRawCounter('notification_failure_record_failed', 1, { reason }); } catch { /* never break the caller */ }
}

/**
 * Record one undeliverable event. Resolves in at most ~RECORD_TIMEOUT_MS and NEVER rejects.
 * Returns what happened, for tests and callers that want to know; no caller has to read it.
 */
export async function recordNotificationFailure(input: {
  reason: UndeliverableReason;
  type: unknown;
  companyId?: string | null;
  now?: number;
}): Promise<'recorded' | 'coalesced' | 'failed'> {
  const type = String(input.type ?? 'unknown').slice(0, 60) || 'unknown';
  const companyId = typeof input.companyId === 'string' && input.companyId.trim() ? input.companyId.trim() : null;
  const now = input.now ?? Date.now();
  const key = `${companyId ?? '-'}|${type}|${input.reason}`;
  if (coalesced(key, now)) return 'coalesced';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const write = (async () => {
      const { error } = await ownedDbTable('notification_delivery_failures')
        .insert({ reason: input.reason, type, company_id: companyId });
      return error ? String(error.message ?? 'insert error') : null;
    })().catch((err: unknown) => (err instanceof Error ? err.message : String(err))); // a late rejection after the timeout is handled here
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(`timed out after ${RECORD_TIMEOUT_MS} ms`), RECORD_TIMEOUT_MS);
    });
    const problem = await Promise.race([write, timeout]);
    if (problem) { lastWrite.delete(key); failed(type, input.reason, problem); return 'failed'; } // a failed write frees the slot: the next event retries
    return 'recorded';
  } catch (err) {
    lastWrite.delete(key);
    failed(type, input.reason, err instanceof Error ? err.message : String(err));
    return 'failed';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
