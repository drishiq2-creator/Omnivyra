/**
 * GET /api/track/analytics serves RAW blog_analytics events (e9, 2026-11-12). Its rollup table,
 * blog_analytics_daily, has no writer since the never-scheduled aggregate-blog-analytics cron was
 * retired; with no daily rows the totals come from the raw events. The reader's preference for the
 * rollup is all-or-nothing - the second test pins that hazard, so re-introducing a partial rollup
 * without fixing the reader is caught here.
 *
 * Every read's error is read (e9): a failed read - error object OR thrown rejection (b3) - answers
 * 503 + Retry-After ANALYTICS_UNAVAILABLE, never 0 views.
 */
import fs from 'fs';
import path from 'path';

const mockDb = {
  daily: [] as Record<string, unknown>[], pageviews: [] as Record<string, unknown>[], leaves: [] as Record<string, unknown>[],
  /** Which ONE read fails: 'daily', or `${event}:${window}` - event pageview|pageleave, window 30d|7d|prior. */
  fail: null as string | null,
  failMode: 'error' as 'error' | 'throw',
};

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/userContextService', () => ({ enforceCompanyAccess: async () => ({ userId: 'u1' }) }));
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const b: any = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { filters[c] = v; return b; };
      b.order = () => b;
      b.gte = (_c: string, v: string) => { filters.since = v; return b; };
      b.lt = () => { filters.prior = true; return b; };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        // The window is keyed on the dates the route passes: .lt => the prior 7d; else the
        // lower bound's age says 30d or 7d. Each of the 7 reads can fail on its own.
        const ageDays = (Date.now() - Date.parse(String(filters.since))) / 86_400_000;
        const win = filters.prior ? 'prior' : ageDays > 20 ? '30d' : '7d';
        const name = table === 'blog_analytics_daily' ? 'daily' : `${String(filters.event_type)}:${win}`;
        if (mockDb.fail === name && mockDb.failMode === 'throw') return Promise.reject(new Error('socket hang up')).then(res, rej);
        if (mockDb.fail === name) {
          return Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } }).then(res);
        }
        const data = table === 'blog_analytics_daily' ? mockDb.daily
          : filters.event_type === 'pageview' ? mockDb.pageviews : mockDb.leaves;
        return Promise.resolve({ data, error: null }).then(res);
      };
      return b;
    },
  },
}));

import handler from '../../../pages/api/track/analytics';

async function call() {
  const res: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: unknown) => { res.body = p; return res; };
  await (handler as any)({ method: 'GET', query: { account_id: 'co-a', days: '30' }, headers: {} }, res);
  return res;
}

beforeEach(() => {
  mockDb.fail = null;
  mockDb.failMode = 'error';
  mockDb.daily = [];
  mockDb.pageviews = Array.from({ length: 7 }, () => ({ url_slug: 'post-a' }));
  mockDb.leaves = [{ url_slug: 'post-a', time_on_page: 30, scroll_depth: 50 }];
});

it('no rollup rows (the table has no writer): the totals come from the RAW events', async () => {
  const res = await call();
  expect(res.statusCode).toBe(200);
  expect(res.body.total_views).toBe(7);
});

it('HAZARD CLOSED (7c): a partial rollup row is IGNORED - the totals stay the complete raw events', async () => {
  mockDb.daily = [{ url_slug: 'post-a', views: 1, avg_time: 0, avg_scroll: 0, sessions: 1, date: '2026-11-11' }];
  const res = await call();
  // 7, not 1: the reader no longer reads blog_analytics_daily at all.
  expect(res.body.total_views).toBe(7);
});

it('the retired cron route is gone, and nothing schedules it', () => {
  const root = path.resolve(__dirname, '../../..');
  expect(fs.existsSync(path.join(root, 'pages/api/cron/aggregate-blog-analytics.ts'))).toBe(false);
  const vercel = fs.existsSync(path.join(root, 'vercel.json')) ? fs.readFileSync(path.join(root, 'vercel.json'), 'utf8') : '';
  expect(vercel).not.toContain('aggregate-blog-analytics');
  const allowlist = fs.readFileSync(path.join(root, 'scripts/route-auth-allowlist.json'), 'utf8');
  expect(allowlist).not.toContain('aggregate-blog-analytics');
});

describe('a failed read is UNAVAILABLE, never zero views', () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => errSpy.mockRestore());

  const READS = ['pageview:30d', 'pageleave:30d', 'pageview:7d', 'pageleave:7d', 'pageview:prior', 'pageleave:prior'];
  it.each(READS.flatMap((r) => [[r, 'error'], [r, 'throw']] as const))('%s read fails (%s) -> 503 + Retry-After ANALYTICS_UNAVAILABLE, logged', async (which, mode) => {
    mockDb.fail = which;
    mockDb.failMode = mode;
    const res = await call();
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('5');
    expect(res.body).toEqual(expect.objectContaining({ code: 'ANALYTICS_UNAVAILABLE' }));
    expect(res.body.total_views).toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith('[track/analytics] read failed', expect.objectContaining({ account_id: 'co-a' }));
  });

  it('NEGATIVE CONTROL: every read succeeds -> 200 with the real totals, nothing logged', async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.total_views).toBe(7);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

it('the mock keys every read on its own window - each of the 6 names is hit exactly once per request; the daily table is never read', async () => {
  const seen: string[] = [];
  for (const which of ['daily', 'pageview:30d', 'pageleave:30d', 'pageview:7d', 'pageleave:7d', 'pageview:prior', 'pageleave:prior']) {
    mockDb.fail = which;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await call();
    spy.mockRestore();
    if (res.statusCode === 503) seen.push(which);
  }
  mockDb.fail = null;
  expect(seen).toEqual(['pageview:30d', 'pageleave:30d', 'pageview:7d', 'pageleave:7d', 'pageview:prior', 'pageleave:prior']);
});
