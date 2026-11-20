/**
 * WORKER-side exporter for undeliverable notifications (b3 ruling (B), a9 2026-11-20).
 *
 * Every tick it reads public.notification_delivery_failures for the last 30 minutes and publishes, per (reason, type):
 *   notification_undeliverable_recent{reason, type, window="15m"|"30m"}   gauge = rows in that window
 * computed FROM THE DATABASE, so an event raised on Vercel counts exactly like one raised in the worker. A windowed
 * count has no first-sample or deploy-reset blind spot, and a later prune cannot fake a spike.
 *
 * READ FAILURE IS NOT ZERO (b3 read-failure rule): a failed read sets
 *   notification_undeliverable_recent_unreadable = 1
 * and leaves the last published counts in place (it never writes zeros it did not read); a successful read sets it
 * back to 0. monitoring/notifications-alerts.yml alerts on it.
 *
 * Series that drop out of the window are set to 0, not abandoned, so a resolved condition reads 0 rather than a stale
 * count. Labels: reason (4 values) and type (<= 60 chars) only - never a company id.
 *
 * Started from backend/workers/main.ts (the process Prometheus scrapes); the scheduler may run in a separate cron
 * service, so this is deliberately NOT a cron job.
 */
import { ownedDbTable } from '../db/writeOwner';
import { recordRawGauge } from './metrics';

export const EXPORT_INTERVAL_MS = 60_000;
const MAX_ROWS = 5000;
const WINDOWS: Array<{ label: '15m' | '30m'; ms: number }> = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '30m', ms: 30 * 60_000 },
];

const published = new Set<string>(); // `${reason}\u0000${type}` seen in any earlier tick

/** Test seam. */
export function __resetNotificationFailureExporter(): void {
  published.clear();
}

/** One tick. Never throws. Returns what it did, for tests. */
export async function exportNotificationFailures(now: number = Date.now()): Promise<'exported' | 'unreadable'> {
  try {
    const since = new Date(now - WINDOWS[WINDOWS.length - 1].ms).toISOString();
    const { data, error } = await ownedDbTable('notification_delivery_failures')
      .select('reason, type, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS);
    if (error) throw new Error(String(error.message ?? 'read error'));
    const rows = (data ?? []) as Array<{ reason: string; type: string; created_at: string }>;
    const counts = new Map<string, { reason: string; type: string; c: Record<string, number> }>();
    for (const k of published) {
      const [reason, type] = k.split('\u0000');
      counts.set(k, { reason, type, c: { '15m': 0, '30m': 0 } });
    }
    for (const r of rows) {
      const k = `${r.reason}\u0000${r.type}`;
      if (!counts.has(k)) counts.set(k, { reason: r.reason, type: r.type, c: { '15m': 0, '30m': 0 } });
      const age = now - Date.parse(r.created_at);
      for (const w of WINDOWS) if (age <= w.ms) counts.get(k)!.c[w.label] += 1;
    }
    for (const [k, v] of counts) {
      published.add(k);
      for (const w of WINDOWS) {
        recordRawGauge('notification_undeliverable_recent', v.c[w.label], { reason: v.reason, type: v.type, window: w.label });
      }
    }
    // A full page means the window may hold more rows than were read: the counts are a floor, never an all-clear.
    recordRawGauge('notification_undeliverable_recent_truncated', rows.length >= MAX_ROWS ? 1 : 0);
    recordRawGauge('notification_undeliverable_recent_unreadable', 0);
    return 'exported';
  } catch (err) {
    console.error('NOTIFICATION_FAILURE_EXPORT_UNREADABLE', err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200));
    try { recordRawGauge('notification_undeliverable_recent_unreadable', 1); } catch { /* never break the worker */ }
    return 'unreadable';
  }
}

/**
 * Checkout down (b3 / c6 PL-114): billingAmountResolver fails checkout CLOSED when hidden_billing_catalog is
 * unreadable and records system_health_metrics (component 'billing', metric 'price_catalog_unavailable', value 1).
 * Same durable-source pattern, in the SAME tick (no second exporter): sum of metric_value over the last 15 minutes,
 * read via idx_system_health_metrics_name (metric_name, observed_at). A failed read sets
 * billing_price_catalog_unavailable_unreadable = 1 and writes no count (never a false zero).
 */
export const BILLING_CATALOG_WINDOW_MS = 15 * 60_000;
export async function exportBillingCatalogUnavailable(now: number = Date.now()): Promise<'exported' | 'unreadable'> {
  try {
    const since = new Date(now - BILLING_CATALOG_WINDOW_MS).toISOString();
    const { data, error } = await ownedDbTable('system_health_metrics')
      .select('metric_value')
      .eq('metric_name', 'price_catalog_unavailable')
      .eq('component', 'billing')
      .gte('observed_at', since)
      .limit(MAX_ROWS);
    if (error) throw new Error(String(error.message ?? 'read error'));
    const rows = (data ?? []) as Array<{ metric_value: number | string | null }>;
    const total = rows.reduce((acc, r) => acc + (Number(r.metric_value) || 0), 0);
    recordRawGauge('billing_price_catalog_unavailable_recent', total, { window: '15m' });
    recordRawGauge('billing_price_catalog_unavailable_unreadable', 0);
    return 'exported';
  } catch (err) {
    console.error('BILLING_CATALOG_SIGNAL_UNREADABLE', err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200));
    try { recordRawGauge('billing_price_catalog_unavailable_unreadable', 1); } catch { /* never break the worker */ }
    return 'unreadable';
  }
}

/** Start the periodic export (one immediate tick, then every EXPORT_INTERVAL_MS). Returns a stop function. */
export function startNotificationFailureExporter(intervalMs: number = EXPORT_INTERVAL_MS): () => void {
  const tick = () => { void exportNotificationFailures(); void exportBillingCatalogUnavailable(); };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
