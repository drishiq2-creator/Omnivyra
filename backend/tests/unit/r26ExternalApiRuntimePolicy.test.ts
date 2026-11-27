/**
 * Round 26 final (Agent B, at Agent E's request) — runtime credential policy at Agent B's seams.
 *
 *   B-3 (S-12): the intelligence poller (`fetchSingleSourceWithQueryBuilder` →
 *        `getIntelligenceApiOverrides`) injected `process.env.NEWS_API_KEY` / `YOUTUBE_API_KEY`
 *        for ANY source whose NAME contained "news" / "youtube" — a tenant-owned, unapproved
 *        row included — outside the env policy. NOW the fallback goes through
 *        `createSourceEnvResolver`, judged for the original row's ownership / approval.
 *   B-1 (S-3): `executeWithAccountLoop` resolved account credentials without the destination
 *        row, so E's destination check could not run. NOW the row is passed.
 *
 * NOTE: the tenant-row refusal relies on Agent E's policy (r26-e, envResolutionPolicy P2: a
 * tenant-owned row needs is_whitelisted). Against the pre-r26-e policy a tenant preset-origin
 * row is still allowed, so these refusals pass only on the r26-b + r26-e combination.
 *
 * The REAL poller, executor and env policy run; I/O and the account store are scripted.
 */
export {};

type Row = Record<string, any>;

const FAKE_NEWS_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // fake fixture
const FAKE_YT_KEY = 'AIzaFakeFixture000000000000000000000000'; // fake fixture

let source: Row | null = null;
let accounts: Row[] = [];
const fetchCalls: string[] = [];

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: () => ({ select: async () => ({ data: [], error: null }) }),
}));
jest.mock('../../services/externalApi/userAccess', () => ({
  getExternalApiSourceById: jest.fn(async () => (source ? { ...source } : null)),
}));
jest.mock('../../services/intelligenceQueryBuilder', () => ({
  expand: jest.fn(async () => ({ queryParams: { q: 'ai' }, runtimeValues: {} })),
}));
jest.mock('../../services/providerAccountService', () => ({
  resolveAllAccountsForRequest: jest.fn(async () => accounts),
  resolveAccountCredentials: jest.fn(() => null),
}));
jest.mock('../../services/redisExternalApiCache', () => ({
  getCachedResponse: jest.fn(async () => null),
  setCachedResponse: jest.fn(async () => {}),
  buildCacheKey: jest.fn(() => 'k'),
  getCacheStats: jest.fn(() => ({})),
  clearLastRateLimitedSources: jest.fn(),
  getLastRateLimitedSources: jest.fn(() => []),
  addRateLimitedSource: jest.fn(),
  isRateLimited: jest.fn(async () => false),
  resetExternalApiRuntime: jest.fn(),
}));
jest.mock('../../services/externalApiHealthService', () => ({
  updateApiHealth: jest.fn(async () => null), getHealthSnapshot: jest.fn(() => ({})),
}));
jest.mock('../../services/externalApi/usageLogging', () => ({
  buildUsageUserId: () => 'u', logExternalApiUsage: jest.fn(async () => {}),
}));
jest.mock('../../services/externalApi/dbHelpers', () => ({ getHealthForSource: jest.fn(async () => null) }));
jest.mock('../../services/externalApi/internalHelpers', () => {
  const actual = jest.requireActual('../../services/externalApi/internalHelpers');
  return {
    ...actual,
    buildProfileRuntimeValues: jest.fn(async () => ({})),
    isRateLimited: jest.fn(async () => false),
    fetchWithRetry: jest.fn(async (url: string) => {
      fetchCalls.push(url);
      return new Response(JSON.stringify({ status: 'error' }), { status: 401 });
    }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetchSingleSourceWithQueryBuilder } = require('../../services/externalApi/singleSourceFetcher');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const providerAccounts = require('../../services/providerAccountService');

const row = (over: Row): Row => ({
  id: 'src-1', name: 'My news feed', base_url: 'https://newsapi.org/v2/everything', method: 'GET',
  auth_type: 'none', company_id: null, is_whitelisted: false, is_active: true, category: 'news',
  api_key_env_name: null, api_key_name: null, headers: {}, query_params: {}, ...over,
});

const saved = { news: process.env.NEWS_API_KEY, yt: process.env.YOUTUBE_API_KEY };
beforeEach(() => {
  fetchCalls.length = 0;
  accounts = [];
  providerAccounts.resolveAccountCredentials.mockClear();
  process.env.NEWS_API_KEY = FAKE_NEWS_KEY;
  process.env.YOUTUBE_API_KEY = FAKE_YT_KEY;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  if (saved.news === undefined) delete process.env.NEWS_API_KEY; else process.env.NEWS_API_KEY = saved.news;
  if (saved.yt === undefined) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = saved.yt;
});

describe('B-3: name-based platform-key injection obeys the env policy', () => {
  it('a tenant-owned, UNAPPROVED row named "…news…" never receives the platform NewsAPI key', async () => {
    source = row({ company_id: 'company-a', is_whitelisted: false });
    await fetchSingleSourceWithQueryBuilder('src-1', null);
    expect(fetchCalls.join(' ')).not.toContain(FAKE_NEWS_KEY);
  });

  it('… nor one named "…youtube…" the platform YouTube key', async () => {
    source = row({ name: 'my youtube picks', base_url: 'https://tenant.example/feed', company_id: 'company-a' });
    await fetchSingleSourceWithQueryBuilder('src-1', null);
    expect(fetchCalls.join(' ')).not.toContain(FAKE_YT_KEY);
  });

  it('positive control: a PLATFORM row still gets the platform key', async () => {
    source = row({ company_id: null, is_whitelisted: true, name: 'NewsAPI' });
    await fetchSingleSourceWithQueryBuilder('src-1', null);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain(FAKE_NEWS_KEY);
  });

  it('positive control: a Super-Admin-APPROVED tenant row (is_whitelisted) gets it', async () => {
    source = row({ company_id: 'company-a', is_whitelisted: true });
    await fetchSingleSourceWithQueryBuilder('src-1', null);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain(FAKE_NEWS_KEY);
  });
});

describe('B-1: account credentials are resolved FOR the destination row', () => {
  it('resolveAccountCredentials receives (account, source row)', async () => {
    source = row({ company_id: null, is_whitelisted: true, name: 'NewsAPI' });
    accounts = [{ id: 'acct-1', api_source_id: 'src-1', is_active: true, credentials_encrypted: '{}' }];
    await fetchSingleSourceWithQueryBuilder('src-1', null);
    expect(providerAccounts.resolveAccountCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acct-1' }),
      expect.objectContaining({ id: 'src-1', company_id: null, base_url: 'https://newsapi.org/v2/everything' }),
    );
  });
});
