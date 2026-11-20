import { ownedDbTable } from '../db/writeOwner';
import { recordRawCounter } from '../observability';
/**
 * System Health Metrics Service
 * Records operational health metrics for the engagement system.
 */

import { supabase } from '../db/supabaseClient';

export async function recordMetric(
  component: string,
  metric_name: string,
  metric_value: number,
  metric_unit?: string | null,
  metadata?: Record<string, unknown> | null
): Promise<void> {
  // A refused insert used to be DROPPED (the returned error was never read): callers that rely on this row as a
  // DURABLE count (e.g. market_pulse/run_start_unconfirmed, which a paging rule keys on) would see nothing. Now a lost
  // write is logged at error level and counted in memory (a9, 2026-11-20).
  // NEVER THROWS - LOAD-BEARING, relied on off-file (7c): pages/api/market-pulse/run.ts awaits this inside a try
  // before answering 202; a rejection escaping here would surface as a 500 and turn a kept-key 202 into a re-run
  // (a second, possibly charged scan). Do not make this function throw or rethrow.
  // The in-memory counter is visible only from the worker scrape; on Vercel the SYSTEM_HEALTH_METRIC_WRITE_FAILED log
  // line is the only reliable signal of a lost write.
  let message: string | null = null;
  try {
    const { error } = await ownedDbTable('system_health_metrics').insert({
      component,
      metric_name,
      metric_value,
      metric_unit: metric_unit ?? null,
      observed_at: new Date().toISOString(),
      metadata: metadata ?? null,
    });
    if (error) message = String(error.message ?? 'insert error');
  } catch (err) {
    message = (err as Error)?.message ?? String(err);
  }
  if (message !== null) {
    console.error('SYSTEM_HEALTH_METRIC_WRITE_FAILED', JSON.stringify({ component, metric_name, message: message.slice(0, 200) }));
    try { recordRawCounter('system_health_metric_write_failed', 1, { component, metric_name }); } catch { /* never break the caller */ }
  }
}

export type HealthMetricRow = {
  id: string;
  component: string;
  metric_name: string;
  metric_value: number;
  metric_unit: string | null;
  observed_at: string;
  metadata: Record<string, unknown> | null;
};

export async function getMetrics(options: {
  component?: string | null;
  metric_name?: string | null;
  time_window_hours?: number | null;
  limit?: number;
}): Promise<HealthMetricRow[]> {
  const { component, metric_name, time_window_hours, limit = 500 } = options;
  let query = ownedDbTable('system_health_metrics')
    .select('id, component, metric_name, metric_value, metric_unit, observed_at, metadata')
    .order('observed_at', { ascending: false })
    .limit(limit);

  if (component) {
    query = query.eq('component', component);
  }
  if (metric_name) {
    query = query.eq('metric_name', metric_name);
  }
  if (time_window_hours && time_window_hours > 0) {
    const since = new Date(Date.now() - time_window_hours * 60 * 60 * 1000).toISOString();
    query = query.gte('observed_at', since);
  }

  const { data, error } = await query;
  if (error) {
    console.warn('[systemHealthMetrics] getMetrics error', error.message);
    return [];
  }
  return (data ?? []) as HealthMetricRow[];
}
