/**
 * Round 23 B/C — NewsAPI leak: a secret in a credential-REFERENCE field never leaves via
 * `missingEnv`.
 *
 * THE DEFECT (origin/main 2bc52db7a): production `external_api_sources` row "NewsAPI" holds
 * a plaintext 32-character key in `api_key_env_name`. `buildExternalApiRequest` refuses to
 * resolve it (it is not an env-var name), and then pushed the refused "name" — the key
 * itself — into `missingEnv` (execution.ts:303, and through the `{{apiKey}}` template path
 * at :84/:323). `missingEnv` feeds console logs, Super Admin test responses,
 * `missing_env` / `missing_env_placeholders` (trendFetching) and from there recommendation
 * `omnivyra_metadata.placeholders`.
 *
 * NOW: a reference that fails `isEnvVarName` is reported as
 * `<invalid credential reference on source <id>>`. Valid names are reported unchanged, and
 * resolution of valid env names / account keys is unchanged (positive controls below).
 *
 * The secret below is a FAKE 32-hex fixture shaped like a NewsAPI key; it is not a key.
 */
import { buildExternalApiRequest } from '../../services/externalApi/execution';

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: () => ({ select: async () => ({ data: [], error: null }) }),
}));

const FAKE_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // fake 32-hex fixture, not a real key
const SOURCE_ID = 'src-newsapi-platform';
const MARKER = `<invalid credential reference on source ${SOURCE_ID}>`;

const newsRow = (over: Record<string, unknown> = {}) => ({
  id: SOURCE_ID,
  name: 'NewsAPI',
  base_url: 'https://newsapi.org/v2/top-headlines',
  method: 'GET',
  auth_type: 'api_key',
  company_id: null,
  is_whitelisted: true,
  category: 'news',
  api_key_env_name: FAKE_KEY,
  api_key_name: null,
  headers: {},
  query_params: { country: 'us' },
  ...over,
}) as any;

const savedNews = process.env.NEWS_API_KEY;
afterEach(() => {
  if (savedNews === undefined) delete process.env.NEWS_API_KEY;
  else process.env.NEWS_API_KEY = savedNews;
});

describe('execution.ts:303 — source-level secret in api_key_env_name', () => {
  it('is not reported in missingEnv; a fixed diagnostic naming the source id is', () => {
    const out = buildExternalApiRequest(newsRow(), { accountCredentials: null });
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    expect(out.missingEnv).toEqual([MARKER]);
  });

  it('api_key_name fallback (api_key_env_name null) is treated the same', () => {
    const out = buildExternalApiRequest(
      newsRow({ api_key_env_name: null, api_key_name: FAKE_KEY }),
      { accountCredentials: null },
    );
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    expect(out.missingEnv).toEqual([MARKER]);
  });
});

describe('execution.ts:84/:323 — {{apiKey}} template resolves to the secret "name"', () => {
  it('is not reported in missingEnv', () => {
    const out = buildExternalApiRequest(
      newsRow({ auth_type: 'query', query_params: { apiKey: '{{apiKey}}', country: 'us' } }),
      { accountCredentials: null },
    );
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    expect(out.missingEnv).toEqual([MARKER]);
  });
});

describe('provider account whose api_key_env_name holds a secret', () => {
  it('is not reported in missingEnv', () => {
    const out = buildExternalApiRequest(newsRow({ api_key_env_name: 'NEWS_API_KEY' }), {
      accountCredentials: {
        source: 'account', accountId: 'acct-1', api_key_env_name: FAKE_KEY, api_key_value: null,
        oauth_client_id: null, oauth_client_secret: null,
      } as any,
    });
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    expect(out.missingEnv).toEqual([MARKER]);
  });
});

describe('positive controls — valid configuration is unchanged', () => {
  it('a VALID missing env name is still reported verbatim', () => {
    delete process.env.NEWS_API_KEY;
    const out = buildExternalApiRequest(newsRow({ api_key_env_name: 'NEWS_API_KEY' }), { accountCredentials: null });
    expect(out.missingEnv).toEqual(['NEWS_API_KEY']);
  });

  it('a valid env name still resolves and is injected (and masked)', () => {
    process.env.NEWS_API_KEY = 'fake-env-news-value-r23';
    const out = buildExternalApiRequest(newsRow({ api_key_env_name: 'NEWS_API_KEY' }), { accountCredentials: null });
    expect(out.missingEnv).toEqual([]);
    expect(out.details.url).toContain('apiKey=fake-env-news-value-r23');
    expect(out.details.maskedUrl).not.toContain('fake-env-news-value-r23');
  });

  it('an account api_key_value still wins even when the row holds a bad reference', () => {
    const out = buildExternalApiRequest(newsRow(), {
      accountCredentials: {
        source: 'account', accountId: 'acct-2', api_key_env_name: null, api_key_value: 'fake-account-value-r23',
        oauth_client_id: null, oauth_client_secret: null,
      } as any,
    });
    expect(out.missingEnv).toEqual([]);
    expect(out.details.url).toContain('apiKey=fake-account-value-r23');
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
  });

  it('the secret is never used as a credential (no literal-key fallback)', () => {
    const out = buildExternalApiRequest(newsRow(), { accountCredentials: null });
    expect(out.details.url).not.toContain(FAKE_KEY);
    expect(JSON.stringify(out.details.headers)).not.toContain(FAKE_KEY);
  });
});
