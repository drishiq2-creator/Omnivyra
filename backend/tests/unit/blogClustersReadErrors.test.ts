/**
 * GET /api/track/clusters: a failed read is UNAVAILABLE, never "no clusters" (b3 standing rule, 2026-11-19).
 *
 * The route read `data ?? []` for all four reads, so a failed read rendered as an empty cluster list -
 * which the panel also sent to AI insights as real data. Each read now fails on its own, in both forms
 * (an error object AND a thrown rejection), and must answer 503 + Retry-After CLUSTERS_UNAVAILABLE.
 */
const mockDb = {
  blogs: [] as Record<string, unknown>[],
  pageviews: [] as Record<string, unknown>[],
  leaves: [] as Record<string, unknown>[],
  intent: [] as Record<string, unknown>[],
  /** Which ONE read fails: 'blogs' | 'pageview' | 'pageleave' | 'intent'. */
  fail: null as string | null,
  failMode: 'error' as 'error' | 'throw',
  hits: [] as string[],
};

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/userContextService', () => ({ enforceCompanyAccess: async () => ({ userId: 'u1' }) }));
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      const f: Record<string, unknown> = {};
      const b: any = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { f[c] = v; return b; };
      b.in = (c: string, v: unknown) => { f[c] = v; return b; };
      b.gte = () => b;
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        const name = table === 'blogs' ? 'blogs' : Array.isArray(f.event_type) ? 'intent' : String(f.event_type);
        mockDb.hits.push(name);
        if (mockDb.fail === name && mockDb.failMode === 'throw') return Promise.reject(new Error('socket hang up')).then(res, rej);
        if (mockDb.fail === name) {
          return Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } }).then(res);
        }
        const data = name === 'blogs' ? mockDb.blogs : name === 'pageview' ? mockDb.pageviews
          : name === 'pageleave' ? mockDb.leaves : mockDb.intent;
        return Promise.resolve({ data, error: null }).then(res);
      };
      return b;
    },
  },
}));

import handler from '../../../pages/api/track/clusters';

async function call() {
  const res: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: unknown) => { res.body = p; return res; };
  await (handler as any)({ method: 'GET', query: { account_id: 'co-a', days: '30' }, headers: {} }, res);
  return res;
}

let errSpy: jest.SpyInstance;
beforeEach(() => {
  mockDb.fail = null;
  mockDb.failMode = 'error';
  mockDb.hits = [];
  mockDb.blogs = [{ id: 'b1', slug: 'post-a', tags: ['seo'], category: 'Guides' }];
  mockDb.pageviews = Array.from({ length: 4 }, () => ({ url_slug: '/blog/post-a' }));
  mockDb.leaves = [{ url_slug: '/blog/post-a', time_on_page: 30, scroll_depth: 50 }];
  mockDb.intent = [{ url_slug: '/blog/post-a' }];
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const READS = ['blogs', 'pageview', 'pageleave', 'intent'] as const;

it.each(READS.flatMap((r) => [[r, 'error'], [r, 'throw']] as const))(
  'the %s read fails (%s) -> 503 + Retry-After CLUSTERS_UNAVAILABLE, logged - never an empty cluster list',
  async (which, mode) => {
    mockDb.fail = which;
    mockDb.failMode = mode;
    const res = await call();
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('5');
    expect(res.body).toEqual({ code: 'CLUSTERS_UNAVAILABLE', error: expect.any(String) });
    expect(errSpy).toHaveBeenCalledWith('[track/clusters] read failed', expect.objectContaining({ account_id: 'co-a' }));
  },
);

it('NEGATIVE CONTROL: every read succeeds -> 200 with the real clusters, nothing logged', async () => {
  const res = await call();
  expect(res.statusCode).toBe(200);
  expect(res.body.clusters.map((c: { name: string }) => c.name).sort()).toEqual(['Guides', 'seo']);
  expect(res.body.clusters[0].total_views).toBe(4);
  expect(errSpy).not.toHaveBeenCalled();
});

it('NEGATIVE CONTROL: a SUCCESSFUL read with no published posts is genuinely empty -> 200, not 503', async () => {
  mockDb.blogs = [];
  const res = await call();
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({ clusters: [], top_cluster: null, bottom_cluster: null });
});

it('the mock routes every read by name - each of the 4 is hit exactly once per request', async () => {
  await call();
  expect([...mockDb.hits].sort()).toEqual(['blogs', 'intent', 'pageleave', 'pageview']);
});
