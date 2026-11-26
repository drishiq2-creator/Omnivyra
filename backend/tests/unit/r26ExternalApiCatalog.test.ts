/**
 * Round 26 final (Agent B) — the catalog route /api/external-apis (indexMutations / indexRead).
 *
 * At aa3cc2bc6:
 *   - POST (tenant) stored `is_preset` from the body (H-5: the row then appears in every
 *     tenant's preset picker) and stored `headers` / `query_params` unvalidated (H-2);
 *   - GET (catalog=1 and the company list) redacted only `api_key_env_name`, so a literal key
 *     in `headers` / `query_params` / `api_key_name` reached every company role.
 * NOW: a tenant cannot create a preset (403) or choose the company (the role-checked companyId
 * is used, a body `company_id` is ignored); a literal credential in the maps is refused with
 * key names only; every catalog read serves the shared marker instead.
 *
 * The REAL route shell + handlers run; auth/RBAC/capabilities, the facade and the data layer
 * are scripted. FAKE fixtures only.
 */
export {};

type Row = Record<string, any>;

const FAKE_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // fake 32-hex fixture
const FAKE_SECRET = 'fake_client_secret_fixture_0123456789'; // fake
const FAKE_NAME_KEY = 'c3d4e5f60718293a4b5c6d7e8f90a1b2'; // fake, pasted into api_key_name
const FAKE_CIPHERTEXT = '0123456789abcdef01234567:0123456789abcdef0123456789abcdef:deadbeef'; // fake
const ALL_FAKES = [FAKE_KEY, FAKE_SECRET, FAKE_NAME_KEY, FAKE_CIPHERTEXT];
const SECRET_MARKER = '__REDACTED_SECRET_VALUE__';
const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

const POISONED_PLATFORM_ROW: Row = {
  id: 'src-platform', company_id: null, name: 'Unsplash', is_active: true, is_preset: true,
  base_url: 'https://api.unsplash.com/search/photos', method: 'GET', auth_type: 'none',
  api_key_env_name: 'UNSPLASH_ACCESS_KEY', api_key_name: FAKE_NAME_KEY,
  headers: { Accept: 'application/json', _client_secret_env: FAKE_SECRET },
  query_params: { per_page: '10', client_id: FAKE_KEY },
  oauth_client_id_encrypted: FAKE_CIPHERTEXT, oauth_client_secret_encrypted: FAKE_CIPHERTEXT,
};

let currentUser = 'admin-a';
let tableRows: Row[] = [];
const inserts: Array<{ table: string; payload: Row }> = [];

jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: jest.fn(async () => ({ user: { id: currentUser }, error: null })),
}));
jest.mock('../../services/superAdminSession', () => ({ getLegacySuperAdminSession: jest.fn(() => null) }));
jest.mock('../../services/rbacService', () => ({
  Role: { SUPER_ADMIN: 'SUPER_ADMIN', COMPANY_ADMIN: 'COMPANY_ADMIN', ADMIN: 'ADMIN' },
  isPlatformSuperAdmin: jest.fn(async (id: string) => id === 'super-admin'),
  isSuperAdmin: jest.fn(async (id: string) => id === 'super-admin'),
  getUserRole: jest.fn(async (id: string, companyId: string) => {
    if (id === 'admin-a' && companyId === 'company-a') return { role: 'COMPANY_ADMIN', error: null };
    if (id === 'viewer-a' && companyId === 'company-a') return { role: 'VIEW_ONLY', error: null };
    return { role: null, error: 'COMPANY_ACCESS_DENIED' };
  }),
  getCompanyRoleIncludingInvited: jest.fn(async () => null),
  hasPermission: jest.fn(async (r: string) => r === 'COMPANY_ADMIN'),
}));
jest.mock('../../security/requireCapability', () => ({
  requireCapability: jest.fn(async () => ({ ok: true, principal: { userId: 'super-admin', capabilities: [] } })),
}));
jest.mock('../../security/IdentityResolver', () => ({ resolvePrincipal: jest.fn(async () => ({ ok: false })) }));
jest.mock('../../security/AuthorizationService', () => ({ hasCapability: jest.fn(() => false) }));
jest.mock('../../services/earnCreditsService', () => ({ checkAndGrantSetupCredits: jest.fn(async () => undefined) }));
jest.mock('../../services/externalApiService', () => ({
  getPlatformConfigs: jest.fn(async () => tableRows.map((r) => ({ ...r }))),
  getExternalApiRuntimeSnapshot: jest.fn(async () => ({})),
  savePlatformConfig: jest.fn(async (row: Row) => ({ id: 'new-platform', ...row })),
  validatePlatformConfig: jest.fn(() => ({ ok: true })),
  VALID_API_CATEGORIES: ['social', 'others', 'news'],
}));
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      let op = 'select';
      let payload: Row | undefined;
      const b: any = {};
      for (const m of ['select', 'eq', 'is', 'in', 'gte', 'order', 'limit', 'neq', 'or']) b[m] = () => b;
      b.insert = (p: Row) => { op = 'insert'; payload = p; return b; };
      b.upsert = (p: Row) => { op = 'upsert'; payload = p; return b; };
      const resolve = () => {
        if (op === 'insert') {
          inserts.push({ table, payload: payload! });
          return { data: { id: 'new-row', ...payload }, error: null };
        }
        if (op === 'upsert') return { data: null, error: null };
        if (table === 'external_api_sources') return { data: tableRows.map((r) => ({ ...r })), error: null };
        return { data: [], error: null };
      };
      b.single = () => Promise.resolve(resolve());
      b.maybeSingle = () => Promise.resolve(resolve());
      b.then = (r: any, j: any) => Promise.resolve(resolve()).then(r, j);
      return b;
    },
  },
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../../../pages/api/external-apis/index').default;

function mockRes() {
  const res: any = { statusCode: 0, body: undefined, headersSent: false, sends: 0 };
  res.status = (c: number) => { if (!res.headersSent) res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.sends += 1; if (!res.headersSent) res.body = b; res.headersSent = true; return res; };
  res.setHeader = () => undefined;
  return res;
}
async function call(user: string, method: string, query: Row, body?: Row) {
  currentUser = user;
  const res = mockRes();
  await handler({ method, query, body: body ?? {}, headers: {}, url: '/api/external-apis' }, res);
  return res;
}
const tenantCreate = (body: Row, user = 'admin-a') =>
  call(user, 'POST', { companyId: COMPANY_A }, { name: 'A feed', base_url: 'https://feeds.example.com/a', ...body });
function expectNoFixture(body: unknown) {
  const json = JSON.stringify(body);
  for (const f of ALL_FAKES) expect(json).not.toContain(f);
}

beforeEach(() => {
  tableRows = [{ ...POISONED_PLATFORM_ROW }];
  inserts.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('POST (tenant create) — H-5', () => {
  it('a company admin cannot create a preset (403, nothing inserted)', async () => {
    const res = await tenantCreate({ is_preset: true });
    expect(res.statusCode).toBe(403);
    expect(inserts.filter((i) => i.table === 'external_api_sources')).toHaveLength(0);
  });

  it('a body company_id naming another tenant is ignored: the row lands in the caller\'s company', async () => {
    const res = await tenantCreate({ company_id: COMPANY_B, companyId: COMPANY_A });
    expect(res.statusCode).toBe(201);
    const row = inserts.find((i) => i.table === 'external_api_sources')!.payload;
    expect(row.company_id).toBe(COMPANY_A);
    expect(row.is_preset).toBe(false);
  });

  it('unauthorised tenant role (VIEW_ONLY) cannot create at all', async () => {
    const res = await tenantCreate({}, 'viewer-a');
    expect(res.statusCode).toBe(403);
    expect(res.sends).toBe(1); // exactly one response (the shell used to append a 405)
    expect(inserts).toHaveLength(0);
  });

  it('positive control: a plain tenant create succeeds as a non-preset row', async () => {
    const res = await tenantCreate({ is_preset: false, headers: { Accept: 'application/json' }, query_params: { q: '{{TOPIC}}' } });
    expect(res.statusCode).toBe(201);
    expect(inserts.find((i) => i.table === 'external_api_sources')!.payload.is_preset).toBe(false);
  });

  it('positive control: a Super Admin may still create a preset in a company context', async () => {
    const res = await call('super-admin', 'POST', { companyId: COMPANY_A }, { name: 'Preset', base_url: 'https://x.example', is_preset: true });
    expect(res.statusCode).toBe(201);
    expect(inserts.find((i) => i.table === 'external_api_sources')!.payload.is_preset).toBe(true);
  });
});

describe('POST — H-2 literal credentials in headers / query_params (malformed metadata)', () => {
  it('tenant: a key in headers → 400 with key names only, nothing inserted', async () => {
    const res = await tenantCreate({ headers: { 'X-Api-Key': FAKE_KEY } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'SECRET_VALUE_NOT_ALLOWED', field: 'headers', keys: ['X-Api-Key'] });
    expectNoFixture(res.body);
    expect(inserts).toHaveLength(0);
  });

  it('platform (Super Admin): the Unsplash-style _client_secret_env literal → 400, nothing saved', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { savePlatformConfig } = require('../../services/externalApiService');
    const res = await call('super-admin', 'POST', { scope: 'platform' }, {
      name: 'Unsplash', base_url: 'https://api.unsplash.com/search/photos', headers: { _client_secret_env: FAKE_SECRET },
    });
    expect(res.statusCode).toBe(400);
    expectNoFixture(res.body);
    expect(savePlatformConfig).not.toHaveBeenCalled();
  });

  it('tenant: a key in query_params → 400', async () => {
    const res = await tenantCreate({ query_params: { api_key: FAKE_KEY } });
    expect(res.statusCode).toBe(400);
    expect(res.body.field).toBe('query_params');
    expect(inserts).toHaveLength(0);
  });
});

describe('GET — H-2 / S-9 catalog reads never serve a credential', () => {
  it('catalog=1 (any company role): headers / query_params / api_key_name secrets are markers', async () => {
    const res = await call('viewer-a', 'GET', { companyId: COMPANY_A, catalog: '1' });
    expect(res.statusCode).toBe(200);
    const api = res.body.apis.find((a: Row) => a.id === 'src-platform');
    expect(api).toBeDefined(); // precondition: the poisoned row was served
    expect(api.headers).toEqual({ Accept: 'application/json', _client_secret_env: SECRET_MARKER });
    expect(api.query_params).toEqual({ per_page: '10', client_id: SECRET_MARKER });
    expect(api.has_oauth_credentials).toBe(true); // the "configured" flag survives redaction
    expectNoFixture(res.body);
  });

  it('the company list (getPlatformConfigs branch) is redacted the same way', async () => {
    const res = await call('viewer-a', 'GET', { companyId: COMPANY_A });
    expect(res.statusCode).toBe(200);
    expect(res.body.apis).toHaveLength(1);
    expectNoFixture(res.body);
  });

  it('the Super Admin platform list is redacted too', async () => {
    const res = await call('super-admin', 'GET', { scope: 'platform' });
    expect(res.statusCode).toBe(200);
    expect(res.body.apis).toHaveLength(1);
    expectNoFixture(res.body);
  });
});
