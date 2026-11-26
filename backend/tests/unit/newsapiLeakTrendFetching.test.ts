/**
 * Round 23 B/C — NewsAPI leak through the trend pipeline.
 *
 * `fetchExternalTrends` (trendFetching.ts) turns the executor's `missingEnv` into
 * `results[].missing_env` and `missing_env_placeholders` (`missing_env:<name>`). The
 * recommendation engine copies `missing_env_placeholders` verbatim into a console.warn
 * (engine.ts:475) and into `omnivyra_metadata.placeholders` (engine.ts:589), which is
 * returned by POST /api/recommendations/generate and sent in the OmniVyra learning snapshot.
 *
 * At 2bc52db7a a platform NewsAPI row whose api_key_env_name holds a key (and no account
 * key) produced `missing_env:<the key>` here. The real executor runs; only I/O is mocked.
 * The key is a FAKE 32-hex fixture.
 */
import { fetchExternalTrends } from '../../services/externalApi/trendFetching';

const FAKE_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // fake fixture, not a real key
const SOURCE_ID = 'src-newsapi-platform';
const MARKER = `<invalid credential reference on source ${SOURCE_ID}>`;

let sources: any[] = [];
const fetchCalls: string[] = [];

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: () => ({ select: async () => ({ data: [], error: null }) }),
}));
jest.mock('../../services/externalApi/userAccess', () => ({
  getExternalApiSourcesForUser: jest.fn(async () => sources),
}));
jest.mock('../../services/providerAccountService', () => ({
  resolveAllAccountsForRequest: jest.fn(async () => []),
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
}));
jest.mock('../../services/externalApiHealthService', () => ({ updateApiHealth: jest.fn(async () => null) }));
jest.mock('../../services/intelligenceSignalStore', () => ({ insertFromTrendApiResults: jest.fn() }));
jest.mock('../../services/omnivyraClientV1', () => ({
  getTrendRanking: jest.fn(), getTrendRelevance: jest.fn(), isOmnivyraEnabled: jest.fn(() => false),
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
      return new Response(JSON.stringify({ status: 'error', code: 'apiKeyMissing' }), { status: 401 });
    }),
  };
});

beforeEach(() => {
  fetchCalls.length = 0;
  sources = [{
    id: SOURCE_ID, name: 'NewsAPI', base_url: 'https://newsapi.org/v2/top-headlines', method: 'GET',
    auth_type: 'api_key', company_id: null, is_whitelisted: true, is_active: true, category: 'news',
    api_key_env_name: FAKE_KEY, api_key_name: null, headers: {}, query_params: { country: 'us' },
  }];
});

it('missing_env and missing_env_placeholders never carry the secret', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const summary = await fetchExternalTrends('company-a', 'us', undefined, { userId: 'user-1' });
    // The row was attempted (precondition: the leak scenario actually ran).
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).not.toContain(FAKE_KEY);
    expect(summary.missing_env_placeholders).toEqual([`missing_env:${MARKER}`]);
    expect(summary.results[0]?.missing_env).toEqual([MARKER]);
    // Everything in the summary except the in-process `results[].source` row object (its
    // consumers — engine normalizeTrends, recommendationExecutionService — read only
    // name/id; it is not serialised to a client) must be clean.
    const { results, ...rest } = summary;
    expect(JSON.stringify(rest)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(results.map(({ source: _s, ...r }) => r))).not.toContain(FAKE_KEY);
    const logged = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
    expect(logged).not.toContain(FAKE_KEY);
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
});

it('positive control: a valid but unset env name is still reported verbatim', async () => {
  const saved = process.env.ZZ_R23_UNSET_NEWS_KEY;
  delete process.env.ZZ_R23_UNSET_NEWS_KEY;
  sources[0].api_key_env_name = 'ZZ_R23_UNSET_NEWS_KEY';
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const summary = await fetchExternalTrends('company-a', 'us', undefined, { userId: 'user-1' });
    expect(summary.missing_env_placeholders).toEqual(['missing_env:ZZ_R23_UNSET_NEWS_KEY']);
  } finally {
    warn.mockRestore();
    log.mockRestore();
    if (saved !== undefined) process.env.ZZ_R23_UNSET_NEWS_KEY = saved;
  }
});
