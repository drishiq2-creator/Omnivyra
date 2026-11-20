/**
 * systemHealthMetricsService.recordMetric (a9, 2026-11-20). It never read the insert's RETURNED error - only a thrown
 * one - so a refused write vanished. Callers that treat the row as a DURABLE count (e.g. c6's PL-114
 * billing/price_catalog_unavailable) would then see nothing. Now a refused OR thrown write is logged at error level
 * and counted; it still never throws.
 */
type R = { error: { message: string } | null } | 'throw';
let next: R = { error: null };
const inserts: Array<Record<string, unknown>> = [];
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: () => ({
    insert: (row: Record<string, unknown>) => {
      inserts.push(row);
      return next === 'throw' ? Promise.reject(new Error('socket hang up')) : Promise.resolve(next);
    },
  }),
}));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: jest.fn() } }));
const counters: Array<[string, number, Record<string, string>]> = [];
jest.mock('../../observability', () => ({
  recordRawCounter: (n: string, v: number, l: Record<string, string>) => { counters.push([n, v, l]); },
}));

import { recordMetric } from '../../services/systemHealthMetricsService';

let err: jest.SpyInstance;
beforeEach(() => { next = { error: null }; inserts.length = 0; counters.length = 0; err = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => err.mockRestore());

it.each([
  ['an error object', { error: { message: 'permission denied' } } as R],
  ['a thrown rejection', 'throw' as R],
])('a lost write (%s) -> SYSTEM_HEALTH_METRIC_WRITE_FAILED + counter; never throws', async (_n, outcome) => {
  next = outcome;
  await expect(recordMetric('billing', 'price_catalog_unavailable', 1, 'count')).resolves.toBeUndefined();
  expect(err).toHaveBeenCalledWith('SYSTEM_HEALTH_METRIC_WRITE_FAILED', expect.stringContaining('price_catalog_unavailable'));
  expect(counters).toEqual([['system_health_metric_write_failed', 1, { component: 'billing', metric_name: 'price_catalog_unavailable' }]]);
});

it('CONTROL: a successful write is inserted as given and counts nothing', async () => {
  await recordMetric('billing', 'price_catalog_unavailable', 1, 'count', { a: 1 });
  expect(counters).toEqual([]);
  expect(inserts[0]).toMatchObject({ component: 'billing', metric_name: 'price_catalog_unavailable', metric_value: 1, metric_unit: 'count', metadata: { a: 1 } });
});
