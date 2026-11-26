/**
 * Round 23 B/C — the Super Admin "test" surfaces echoed a secret held in api_key_env_name.
 *
 * At 2bc52db7a:
 *   - GET /api/external-apis/[id]/test logged `EXTERNAL_API_TEST_MISSING_ENV { missing }`
 *     (test.ts:81) and returned `missing: [<the key>]` (test.ts:84);
 *   - testApiConnection (POST /api/external-apis/[id]/test-connection) returned
 *     `message: "Missing: <the key>"` (apiConnectionTestService.ts:97).
 * Both come from buildExternalApiRequest's `missingEnv`; the real executor runs here, only
 * auth and the data layer are scripted. FAKE 32-hex fixture.
 */
export {};

const FAKE_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // fake fixture, not a real key
const SOURCE_ID = 'src-newsapi-platform';
const MARKER = `<invalid credential reference on source ${SOURCE_ID}>`;

const ROW = {
  id: SOURCE_ID, company_id: null, name: 'NewsAPI', category: 'news', is_whitelisted: true,
  base_url: 'https://newsapi.org/v2/top-headlines', method: 'GET', auth_type: 'api_key',
  api_key_env_name: FAKE_KEY, api_key_name: null, headers: {}, query_params: { country: 'us' },
};

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: () => ({ select: async () => ({ data: [], error: null }) }),
}));
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: () => {
      const b: any = {};
      b.select = () => b;
      b.eq = () => b;
      b.or = () => b;
      b.single = async () => ({ data: { ...ROW }, error: null });
      return b;
    },
  },
}));
jest.mock('../../services/externalApiService', () => {
  const exec = jest.requireActual('../../services/externalApi/execution');
  return {
    buildExternalApiRequest: exec.buildExternalApiRequest,
    executeExternalApiRequest: jest.fn(async () => { throw new Error('must not be called'); }),
  };
});
jest.mock('../../services/externalApiHealthService', () => ({ updateApiHealth: jest.fn(async () => null) }));
jest.mock('../../services/redisExternalApiCache', () => ({
  buildCacheKey: jest.fn(() => 'k'), getCacheStats: jest.fn(() => ({})),
  getCachedResponse: jest.fn(async () => null), setCachedResponse: jest.fn(async () => {}),
}));
jest.mock('../../services/trendNormalizationService', () => ({ normalizeExternalTrends: jest.fn(() => []) }));
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: jest.fn(async () => ({ userId: 'u', role: 'user', companyIds: [], defaultCompanyId: '', authenticated: true })),
}));
jest.mock('../../services/superAdminSession', () => ({ getLegacySuperAdminSession: jest.fn(() => ({ userId: 'legacy-admin' })) }));
jest.mock('../../services/supabaseAuthService', () => ({ getSupabaseUserFromRequest: jest.fn(async () => ({ user: null, error: 'x' })) }));
jest.mock('../../middleware/withRBAC', () => ({ withRBAC: (h: any) => h }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

it('GET /api/external-apis/[id]/test: neither the log nor the 400 body carries the secret', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const handler = require('../../../pages/api/external-apis/[id]/test').default;
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const res = mockRes();
    await handler({ method: 'GET', query: { id: SOURCE_ID, scope: 'platform' }, headers: {}, body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Missing environment variables'); // the leak branch ran
    expect(res.body.missing).toEqual([MARKER]);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
    const logged = warn.mock.calls.filter((c) => c[0] === 'EXTERNAL_API_TEST_MISSING_ENV');
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain(FAKE_KEY);
  } finally {
    warn.mockRestore();
  }
});

it('testApiConnection (test-connection route): the "Missing: …" message does not carry the secret', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { testApiConnection } = require('../../services/apiConnectionTestService');
  const result = await testApiConnection({ apiId: SOURCE_ID, platformScope: true });
  expect(result.success).toBe(false);
  expect(result.message).toBe(`Missing: ${MARKER}`);
  expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
});
