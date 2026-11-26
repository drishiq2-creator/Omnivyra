/**
 * Round 23 B/C — GET / PUT /api/external-apis/[id] served and accepted secrets in the
 * credential-REFERENCE fields.
 *
 * At 2bc52db7a:
 *   - GET returned `select('*')` unredacted (Super Admin, platform rows): a key pasted into
 *     api_key_env_name was served back verbatim;
 *   - the PUT response returned the updated row unredacted;
 *   - PUT did NOT run `isEnvVarName` (POST does, indexMutations.ts:200), so a key could be
 *     (re)written into api_key_env_name / api_key_name.
 *
 * NOW: responses are redacted with credentialSafety's marker; PUT rejects a secret-shaped
 * value with 400 INVALID_ENV_VAR_NAME (never echoing it) and writes nothing; the marker
 * echoed back by a UI round-trip means "unchanged"; valid names keep working.
 * The real route runs; only auth, RBAC and the data layer are scripted. FAKE 32-hex fixture.
 */
export {};

type Row = Record<string, unknown>;

const FAKE_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // fake fixture, not a real key
const MARKER = '__REDACTED_INVALID_ENV_VAR_NAME__';
const PLATFORM_ADMIN = 'user-platform-admin';
const ROW_ID = 'src-newsapi-platform';

let stored: Row;
const updates: Row[] = [];

jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: jest.fn(async () => ({ user: { id: 'user-platform-admin' }, error: null })),
}));
jest.mock('../../services/superAdminSession', () => ({ getLegacySuperAdminSession: jest.fn(() => null) }));
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: jest.fn(async () => ({ userId: 'user-platform-admin', role: 'user', companyIds: [], defaultCompanyId: '', authenticated: true })),
}));
jest.mock('../../services/rbacService', () => ({
  isPlatformSuperAdmin: jest.fn(async (id: string) => id === 'user-platform-admin'),
  isSuperAdmin: jest.fn(async (id: string) => id === 'user-platform-admin'),
  getUserRole: jest.fn(async () => ({ role: null, error: 'COMPANY_ACCESS_DENIED' })),
  getCompanyRoleIncludingInvited: jest.fn(async () => null),
  hasPermission: jest.fn(async () => true),
}));
jest.mock('../../services/externalApiService', () => ({
  validatePlatformConfig: jest.fn(() => ({ ok: true })),
  VALID_API_CATEGORIES: ['social', 'others', 'news'],
}));
// Round 26 (H-4): a platform change of the credential reference now passes the provider-account
// write gate (capability + step-up + platform authority); this suite runs as a stepped-up
// platform Super Admin. The gate's refusals are covered by r26ExternalApiSourceWrites.test.ts.
jest.mock('../../security/requireCapability', () => ({
  requireCapability: jest.fn(async () => ({ ok: true, principal: { userId: 'user-platform-admin', organizations: [], legacyCookieSuperAdmin: false } })),
}));
jest.mock('../../security/platformWriteAuthority', () => ({ enforcePlatformWriteAuthority: jest.fn(async () => true) }));
jest.mock('../../auth/credentialEncryption', () => ({ encryptCredential: jest.fn((v: string) => v) }));
jest.mock('../../services/companyApiConfigCache', () => ({ invalidateCompanyConfigCacheForApiSource: jest.fn(async () => {}) }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let op = 'select';
      let payload: Row | undefined;
      const b: any = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { filters[c] = v; return b; };
      b.update = (p: Row) => { op = 'update'; payload = p; return b; };
      const resolve = () => {
        if (table !== 'external_api_sources') return { data: null, error: null };
        if (filters.id !== stored.id) return { data: null, error: { message: 'no rows' } };
        if (op === 'update') { updates.push(payload!); stored = { ...stored, ...payload }; }
        return { data: { ...stored }, error: null };
      };
      b.single = () => Promise.resolve(resolve());
      b.then = (r: any) => Promise.resolve(resolve()).then(r);
      return b;
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../../../pages/api/external-apis/[id]').default;

const LEGACY_ROW: Row = {
  id: ROW_ID, company_id: null, name: 'NewsAPI', category: 'news', is_whitelisted: true,
  base_url: 'https://newsapi.org/v2/top-headlines', method: 'GET', auth_type: 'api_key',
  api_key_env_name: FAKE_KEY, api_key_name: null,
  headers: {}, query_params: { country: 'us' }, platform_type: 'social',
};

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}
async function call(method: string, body?: Row) {
  const req: any = { method, query: { id: ROW_ID, scope: 'platform' }, body: body ?? {}, headers: {}, url: `/api/external-apis/${ROW_ID}` };
  const res = mockRes();
  await handler(req, res);
  return res;
}

beforeEach(() => { stored = { ...LEGACY_ROW }; updates.length = 0; });

describe('GET /api/external-apis/[id]', () => {
  it('redacts a secret in api_key_env_name', async () => {
    const res = await call('GET');
    expect(res.statusCode).toBe(200);
    expect(res.body.api.id).toBe(ROW_ID); // the row WAS served (precondition)
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
    expect(res.body.api.api_key_env_name).toBe(MARKER);
  });

  it('redacts a secret in api_key_name', async () => {
    stored = { ...LEGACY_ROW, api_key_env_name: 'NEWS_API_KEY', api_key_name: FAKE_KEY };
    const res = await call('GET');
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
    expect(res.body.api.api_key_name).toBe(MARKER);
  });

  it('positive control: valid names and a parameter-name api_key_name are served unchanged', async () => {
    stored = { ...LEGACY_ROW, api_key_env_name: 'NEWS_API_KEY', api_key_name: 'key' };
    const res = await call('GET');
    expect(res.body.api.api_key_env_name).toBe('NEWS_API_KEY');
    expect(res.body.api.api_key_name).toBe('key');
  });
});

describe('PUT /api/external-apis/[id]', () => {
  it('rejects a secret in api_key_env_name with 400, writes nothing, never echoes it', async () => {
    stored = { ...LEGACY_ROW, api_key_env_name: 'NEWS_API_KEY' };
    const res = await call('PUT', { name: 'NewsAPI', base_url: LEGACY_ROW.base_url as string, api_key_env_name: FAKE_KEY });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('INVALID_ENV_VAR_NAME');
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
    expect(updates).toHaveLength(0);
  });

  it('rejects a secret in api_key_name with 400 and writes nothing', async () => {
    stored = { ...LEGACY_ROW, api_key_env_name: 'NEWS_API_KEY' };
    const res = await call('PUT', { name: 'NewsAPI', base_url: LEGACY_ROW.base_url as string, api_key_name: FAKE_KEY });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
    expect(updates).toHaveLength(0);
  });

  it('PUT response is redacted (legacy row edited without touching the key field)', async () => {
    const res = await call('PUT', { name: 'NewsAPI', base_url: LEGACY_ROW.base_url as string, is_active: true });
    expect(res.statusCode).toBe(200);
    expect(updates).toHaveLength(1); // the edit happened (precondition)
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
    expect(res.body.api.api_key_env_name).toBe(MARKER);
  });

  it('the redaction marker echoed back means "unchanged" — it is never stored', async () => {
    stored = { ...LEGACY_ROW, api_key_env_name: 'NEWS_API_KEY', api_key_name: FAKE_KEY };
    const res = await call('PUT', {
      name: 'NewsAPI', base_url: LEGACY_ROW.base_url as string, api_key_env_name: 'NEWS_API_KEY', api_key_name: MARKER,
    });
    expect(res.statusCode).toBe(200);
    expect(updates[0].api_key_name).not.toBe(MARKER);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
  });

  it('positive control: fixing the row to a valid env-var name works', async () => {
    const res = await call('PUT', { name: 'NewsAPI', base_url: LEGACY_ROW.base_url as string, api_key_env_name: 'NEWS_API_KEY' });
    expect(res.statusCode).toBe(200);
    expect(updates[0].api_key_env_name).toBe('NEWS_API_KEY');
    expect(res.body.api.api_key_env_name).toBe('NEWS_API_KEY');
  });
});
