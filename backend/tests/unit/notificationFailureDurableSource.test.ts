/**
 * The durable source behind the notification alert rules (b3 ruling (B), a9 2026-11-20):
 *   - recordNotificationFailure: bounded (timeout), coalesced, fail-open, never rejects, logged + counted on failure;
 *   - exportNotificationFailures (WORKER): windowed counts from the table; a dropped series reads 0; a read failure
 *     sets `unreadable` and NEVER writes zeros it did not read (error object AND thrown rejection);
 *   - pruneNotificationFailures: batched, idempotent, a failed read / delete is { ok: false }, never "done";
 *   - REGISTRATION: the prune is a cron job in ALWAYS_RUN_JOBS; the exporter is started by the worker after env
 *     validation (an unregistered job silently never runs) - each with a control.
 */
import fs from 'fs';
import path from 'path';

type Result = { data?: unknown; error?: { message: string } | null };
const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
let next: Array<Result | 'throw' | 'hang'> = [];
function builder(table: string) {
  const b: Record<string, unknown> = {};
  let op = 'select';
  const settle = () => {
    const r = next.shift() ?? { data: [], error: null };
    if (r === 'throw') return Promise.reject(new Error('socket hang up'));
    if (r === 'hang') return new Promise(() => undefined);
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
  };
  for (const m of ['select', 'insert', 'delete', 'gte', 'lt', 'order', 'limit', 'in']) {
    b[m] = (...args: unknown[]) => {
      if (m === 'select' || m === 'insert' || m === 'delete') op = m;
      calls.push({ table, op: m, args });
      return b;
    };
  }
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
  return b;
}
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => builder(t) }));
const gauges: Array<[string, number, Record<string, string> | undefined]> = [];
const counters: Array<[string, number, Record<string, string> | undefined]> = [];
jest.mock('../../observability/metrics', () => ({
  recordRawGauge: (n: string, v: number, l?: Record<string, string>) => { gauges.push([n, v, l]); },
}));
jest.mock('../../observability', () => ({
  recordRawCounter: (n: string, v: number, l?: Record<string, string>) => { counters.push([n, v, l]); },
}));

import { recordNotificationFailure, __resetNotificationFailureCoalesce, RECORD_TIMEOUT_MS, COALESCE_MS } from '../../services/notificationFailureRecord';
import { exportNotificationFailures, __resetNotificationFailureExporter } from '../../observability/notificationFailureExporter';
import { pruneNotificationFailures, BATCH, MAX_BATCHES, RETENTION_DAYS } from '../../jobs/notificationFailurePrune';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
let err: jest.SpyInstance;
beforeEach(() => {
  calls.length = 0; next = []; gauges.length = 0; counters.length = 0;
  __resetNotificationFailureCoalesce(); __resetNotificationFailureExporter();
  err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { err.mockRestore(); jest.useRealTimers(); });

describe('recordNotificationFailure', () => {
  it('inserts reason / type / company_id', async () => {
    await expect(recordNotificationFailure({ reason: 'no_active_recipient', type: 'credit_alert', companyId: 'co-1', now: NOW })).resolves.toBe('recorded');
    expect(calls).toEqual([{ table: 'notification_delivery_failures', op: 'insert', args: [{ reason: 'no_active_recipient', type: 'credit_alert', company_id: 'co-1' }] }]);
  });

  it('coalesces the same (company, type, reason) inside COALESCE_MS; a different key or a later minute writes', async () => {
    const r = (companyId: string, now: number) => recordNotificationFailure({ reason: 'no_active_recipient', type: 'credit_alert', companyId, now });
    expect(await r('co-1', NOW)).toBe('recorded');
    expect(await r('co-1', NOW + COALESCE_MS - 1)).toBe('coalesced');
    expect(await r('co-2', NOW + 1)).toBe('recorded');
    expect(await r('co-1', NOW + COALESCE_MS)).toBe('recorded');
    expect(calls.filter((c) => c.op === 'insert')).toHaveLength(3);
  });

  it.each([
    ['an error object', { error: { message: 'permission denied' } } as Result],
    ['a thrown rejection', 'throw' as const],
  ])('%s: resolves "failed", logs + counts, and frees the slot so the next event retries', async (_n, outcome) => {
    next = [outcome];
    await expect(recordNotificationFailure({ reason: 'insert_failed', type: 'assignment', now: NOW })).resolves.toBe('failed');
    expect(err).toHaveBeenCalledWith('NOTIFICATION_FAILURE_RECORD_FAILED', expect.stringContaining('assignment'));
    expect(counters).toEqual([['notification_failure_record_failed', 1, { reason: 'insert_failed' }]]);
    await expect(recordNotificationFailure({ reason: 'insert_failed', type: 'assignment', now: NOW + 1 })).resolves.toBe('recorded');
  });

  it('a write that never answers is abandoned after RECORD_TIMEOUT_MS: the caller is not held', async () => {
    jest.useFakeTimers();
    next = ['hang'];
    const p = recordNotificationFailure({ reason: 'no_active_recipient', type: 'credit_alert', companyId: 'co-1', now: NOW });
    await jest.advanceTimersByTimeAsync(RECORD_TIMEOUT_MS);
    await expect(p).resolves.toBe('failed');
    expect(err).toHaveBeenCalledWith('NOTIFICATION_FAILURE_RECORD_FAILED', expect.stringContaining('timed out'));
  });
});

describe('exportNotificationFailures (worker)', () => {
  const g = (name: string, labels?: Record<string, string>) =>
    gauges.filter(([n, , l]) => n === name && JSON.stringify(l) === JSON.stringify(labels)).map(([, v]) => v).pop();

  it('counts rows per (reason, type) in the 15m and 30m windows; unreadable = 0', async () => {
    next = [{ data: [
      { reason: 'no_active_recipient', type: 'credit_alert', created_at: minsAgo(1) },
      { reason: 'no_active_recipient', type: 'credit_alert', created_at: minsAgo(20) },
      { reason: 'insert_failed', type: 'assignment', created_at: minsAgo(29) },
    ] }];
    await expect(exportNotificationFailures(NOW)).resolves.toBe('exported');
    expect(g('notification_undeliverable_recent', { reason: 'no_active_recipient', type: 'credit_alert', window: '15m' })).toBe(1);
    expect(g('notification_undeliverable_recent', { reason: 'no_active_recipient', type: 'credit_alert', window: '30m' })).toBe(2);
    expect(g('notification_undeliverable_recent', { reason: 'insert_failed', type: 'assignment', window: '15m' })).toBe(0);
    expect(g('notification_undeliverable_recent', { reason: 'insert_failed', type: 'assignment', window: '30m' })).toBe(1);
    expect(g('notification_undeliverable_recent_unreadable')).toBe(0);
    expect(g('notification_undeliverable_recent_truncated')).toBe(0);
    const sel = calls.find((c) => c.op === 'gte');
    expect(sel?.args).toEqual(['created_at', minsAgo(30)]);
  });

  it('a series that leaves the window reads 0 on the next tick (not a stale count)', async () => {
    next = [{ data: [{ reason: 'no_active_recipient', type: 'credit_alert', created_at: minsAgo(1) }] }, { data: [] }];
    await exportNotificationFailures(NOW);
    gauges.length = 0;
    await exportNotificationFailures(NOW + 60_000);
    expect(g('notification_undeliverable_recent', { reason: 'no_active_recipient', type: 'credit_alert', window: '15m' })).toBe(0);
    expect(g('notification_undeliverable_recent', { reason: 'no_active_recipient', type: 'credit_alert', window: '30m' })).toBe(0);
  });

  it.each([
    ['an error object', { error: { message: 'connection reset' } } as Result],
    ['a thrown rejection', 'throw' as const],
  ])('a READ FAILURE (%s) sets unreadable = 1 and writes NO count - never a false zero', async (_n, outcome) => {
    next = [{ data: [{ reason: 'no_active_recipient', type: 'credit_alert', created_at: minsAgo(1) }] }, outcome];
    await exportNotificationFailures(NOW);
    gauges.length = 0;
    await expect(exportNotificationFailures(NOW + 60_000)).resolves.toBe('unreadable');
    expect(gauges).toEqual([['notification_undeliverable_recent_unreadable', 1, undefined]]);
    expect(err).toHaveBeenCalledWith('NOTIFICATION_FAILURE_EXPORT_UNREADABLE', expect.any(String));
  });

  it('a full page sets truncated = 1 (the counts are a floor)', async () => {
    next = [{ data: Array.from({ length: 5000 }, () => ({ reason: 'insert_failed', type: 't', created_at: minsAgo(1) })) }];
    await exportNotificationFailures(NOW);
    expect(g('notification_undeliverable_recent_truncated')).toBe(1);
  });
});

describe('pruneNotificationFailures', () => {
  const ids = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ id: `r${i}` })) });

  it('deletes exactly the selected ids older than the cutoff, in batches, until a short batch', async () => {
    next = [ids(BATCH), { error: null }, ids(3), { error: null }];
    await expect(pruneNotificationFailures(NOW)).resolves.toEqual({ ok: true, deleted: BATCH + 3, batches: 2, more: false });
    expect(calls.find((c) => c.op === 'lt')?.args).toEqual(['created_at', new Date(NOW - RETENTION_DAYS * 86_400_000).toISOString()]);
    expect(calls.filter((c) => c.op === 'in')[1].args).toEqual(['id', ['r0', 'r1', 'r2']]);
  });

  it('nothing old: ok, 0 deleted (idempotent re-run)', async () => {
    next = [ids(0)];
    await expect(pruneNotificationFailures(NOW)).resolves.toEqual({ ok: true, deleted: 0, batches: 0, more: false });
  });

  it('stops after MAX_BATCHES and says more remain', async () => {
    next = Array.from({ length: MAX_BATCHES }, () => [ids(BATCH), { error: null }]).flat() as Result[];
    await expect(pruneNotificationFailures(NOW)).resolves.toEqual({ ok: true, deleted: BATCH * MAX_BATCHES, batches: MAX_BATCHES, more: true });
  });

  it.each([
    ['read error', [{ error: { message: 'timeout' } }], 'read'],
    ['read throw', ['throw'], 'read'],
    ['delete error', [ids(2), { error: { message: 'lock timeout' } }], 'delete'],
    ['delete throw', [ids(2), 'throw'], 'delete'],
  ])('%s -> { ok: false, stage } and logged, NEVER reported as done', async (_n, outcomes, stage) => {
    next = outcomes as Array<Result | 'throw'>;
    const r = await pruneNotificationFailures(NOW);
    expect(r).toMatchObject({ ok: false, stage, deleted: 0 });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('NOT done'), expect.any(Object));
  });
});

describe('REGISTRATION: an unregistered job silently never runs', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');

  it('the prune is in ALWAYS_RUN_JOBS (control: a job key that is not, is not)', () => {
    const { ALWAYS_RUN_JOBS } = jest.requireActual('../../services/intentExecutionService');
    expect(ALWAYS_RUN_JOBS.has('notificationFailurePrune')).toBe(true);
    expect(ALWAYS_RUN_JOBS.has('notificationFailurePruneX')).toBe(false);
  });

  it('cron.ts runs the prune under shouldRunCronJob with that key, and a failed run is not "done"', () => {
    const cron = read('backend/scheduler/cron.ts');
    expect(cron).toMatch(/shouldRunCronJob\("notificationFailurePrune", NOTIFICATION_FAILURE_PRUNE_INTERVAL_MS, lastNotificationFailurePruneRun\)/);
    expect(cron).toMatch(/const result = await pruneNotificationFailures\(\);\s*if \(!result\.ok\) \{\s*lastNotificationFailurePruneRun = Date\.now\(\) - NOTIFICATION_FAILURE_PRUNE_INTERVAL_MS \+ NOTIFICATION_FAILURE_PRUNE_RETRY_MS;/);
    expect(cron.split('notificationFailurePrune:     lastNotificationFailurePruneRun,').length - 1).toBe(3); // persisted like its siblings
  });

  it('the worker starts the exporter, AFTER env validation', () => {
    const main = read('backend/workers/main.ts');
    const v = main.indexOf('validateWorkerEnv();');
    const s = main.indexOf('startNotificationFailureExporter();');
    expect(v).toBeGreaterThan(0);
    expect(s).toBeGreaterThan(v);
  });
});
