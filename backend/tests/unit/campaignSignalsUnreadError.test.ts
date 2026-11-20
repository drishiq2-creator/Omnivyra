/**
 * Unread-error census: GET /api/engagement/campaign-signals. With no campaign/activity filter the
 * route first reads the company's campaign_versions; a FAILED read was taken as "no campaigns" and
 * answered 200 { signals: [] } - an empty inbox presented as the truth. It now answers 503 + Retry-After +
 * CAMPAIGN_SIGNALS_UNREADABLE (b3 read-failure rule), for an error object AND a thrown rejection.
 */
const mockDb = { versionsFail: false, versionsThrow: false };

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/userContextService', () => ({ enforceCompanyAccess: async () => ({ userId: 'u1' }) }));
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      const b: any = {};
      for (const m of ['select', 'order', 'limit', 'eq', 'in', 'gte', 'lte']) b[m] = () => b;
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => (table === 'campaign_versions' && mockDb.versionsThrow
        ? Promise.reject(new Error('socket hang up'))
        : Promise.resolve(
        table === 'campaign_versions'
          ? (mockDb.versionsFail ? { data: null, error: { code: '08006', message: 'connection reset' } } : { data: [{ campaign_id: 'cmp1' }], error: null })
          : { data: [{ id: 's1', signal_type: 'comment' }], error: null },
      )).then(res, rej);
      return b;
    },
  },
}));

import handler from '../../../pages/api/engagement/campaign-signals';

function call(query: Record<string, string>) {
  const res: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> };
  res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; return res; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: unknown) => { res.body = p; return res; };
  return (handler as any)({ method: 'GET', query, headers: {} }, res).then(() => res);
}

beforeEach(() => { mockDb.versionsFail = false; mockDb.versionsThrow = false; jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());

it.each([
  ['an error object', () => { mockDb.versionsFail = true; }],
  ['a thrown rejection', () => { mockDb.versionsThrow = true; }],
])('a FAILED campaign_versions read (%s) is not "no campaigns": 503 + Retry-After + a distinct code, never an empty inbox', async (_n, arrange) => {
  arrange();
  const res = await call({ companyId: 'co-a' });
  expect(res.statusCode).toBe(503);
  expect(res.body).toMatchObject({ code: 'CAMPAIGN_SIGNALS_UNREADABLE' });
  expect(res.headers['retry-after']).toBe('5');
  expect(res.body).not.toHaveProperty('signals');
});

it('NEGATIVE CONTROL: the read succeeds - 200 with the signals', async () => {
  const res = await call({ companyId: 'co-a' });
  expect(res.statusCode).toBe(200);
  expect(res.body.signals).toHaveLength(1);
});
