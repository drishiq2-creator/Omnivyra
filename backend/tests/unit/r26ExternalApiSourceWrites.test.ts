/**
 * Round 26 (Agent B) — GET / PUT / DELETE /api/external-apis/[id] after aa3cc2bc6.
 *
 *   H-4  A platform-privileged PUT could repoint a PLATFORM row's base_url (or attach another
 *        credential / {{ENV}} template) and DELETE could cascade away its provider accounts
 *        with no capability and no step-up — the legacy bridge cookie sufficed — while writing
 *        the credential itself (/api/provider-accounts) needs INTEGRATION_PLATFORM_OAUTH_MANAGE
 *        + step-up + platform write authority. NOW: the same gate guards those changes.
 *   H-2  headers / query_params accepted and served raw (and OAuth ciphertext served). NOW:
 *        refused on write (names only), redacted on read, the read marker round-trips as
 *        "unchanged".
 *   H-5  A tenant could mark its own row `is_preset` (listed in other tenants' preset pickers
 *        at 2bc52db7a / aa3cc2bc6). NOW: Super Admin only.
 *
 * The REAL route runs; auth/RBAC, the capability gate, the data layer are scripted (the gate
 * is the shared, separately tested requireCapability — here we prove the route CALLS it and
 * honours its refusal). FAKE fixtures only.
 */
export {};

type Row = Record<string, any>;

const FAKE_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // fake 32-hex fixture, not a real key
const FAKE_SECRET = 'fake_client_secret_fixture_0123456789'; // fake
const FAKE_CIPHERTEXT = '0123456789abcdef01234567:0123456789abcdef0123456789abcdef:deadbeef'; // fake
const ALL_FAKES = [FAKE_KEY, FAKE_SECRET, FAKE_CIPHERTEXT];
const SECRET_MARKER = '__REDACTED_SECRET_VALUE__';
const COMPANY_A = 'company-a';
const CAPABILITY = 'integration.platform.oauth.manage';

const PLATFORM_ROW: Row = {
  id: 'src-platform-serp', company_id: null, name: 'SerpAPI', category: 'news', is_whitelisted: true,
  is_preset: true, base_url: 'https://serpapi.com/search', method: 'GET', auth_type: 'api_key',
  api_key_env_name: 'SERPAPI_KEY', api_key_name: null, platform_type: 'social',
  headers: { Accept: 'application/json' }, query_params: { engine: 'google' },
};
const TENANT_ROW: Row = {
  ...PLATFORM_ROW, id: 'src-tenant-a', company_id: COMPANY_A, name: 'A feed', is_preset: false,
  is_whitelisted: false, category: 'others', base_url: 'https://feeds.example.com/a', auth_type: 'none',
  api_key_env_name: null,
};

let store: Record<string, Row> = {};
const updates: Row[] = [];
const deletes: string[] = [];
let currentUser = 'super-admin';
let legacyBridge = false;
let stepUp: 'ok' | 'step_up_required' | 'not_held' = 'ok';
let writeAuthority = true;
const capabilityCalls: Row[] = [];

jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: jest.fn(async () => ({ user: { id: currentUser }, error: null })),
}));
jest.mock('../../services/superAdminSession', () => ({
  getLegacySuperAdminSession: jest.fn(() => (legacyBridge ? { userId: 'bridge-user' } : null)),
}));
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: jest.fn(async () => ({ userId: currentUser, role: 'user', companyIds: [], defaultCompanyId: '', authenticated: true })),
}));
jest.mock('../../services/rbacService', () => ({
  isPlatformSuperAdmin: jest.fn(async (id: string) => id === 'super-admin'),
  isSuperAdmin: jest.fn(async (id: string) => id === 'super-admin'),
  getUserRole: jest.fn(async (id: string, companyId: string) =>
    (id === 'admin-a' && companyId === 'company-a' ? { role: 'COMPANY_ADMIN', error: null } : { role: null, error: 'COMPANY_ACCESS_DENIED' })),
  getCompanyRoleIncludingInvited: jest.fn(async () => null),
  hasPermission: jest.fn(async (r: string) => r === 'COMPANY_ADMIN'),
}));
jest.mock('../../security/requireCapability', () => ({
  requireCapability: jest.fn(async (_req: unknown, res: any, options: Row) => {
    capabilityCalls.push(options);
    if (stepUp === 'ok') return { ok: true, principal: { userId: 'super-admin', organizations: [], legacyCookieSuperAdmin: false } };
    res.status(403).json(stepUp === 'step_up_required'
      ? { error: 'Step-up required', code: 'STEP_UP_REQUIRED', capability: options.capability }
      : { error: 'Forbidden', code: 'CAPABILITY_NOT_HELD', capability: options.capability });
    return { ok: false, sent: true };
  }),
}));
jest.mock('../../security/platformWriteAuthority', () => ({
  enforcePlatformWriteAuthority: jest.fn(async (_req: unknown, res: any) => {
    if (writeAuthority) return true;
    res.status(403).json({ error: 'Forbidden', code: 'PLATFORM_SUPER_ADMIN_REQUIRED' });
    return false;
  }),
}));
jest.mock('../../services/externalApiService', () => ({
  validatePlatformConfig: jest.fn(() => ({ ok: true })),
  VALID_API_CATEGORIES: ['social', 'others', 'news'],
}));
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
      b.delete = () => { op = 'delete'; return b; };
      const resolve = () => {
        if (table !== 'external_api_sources') return { data: null, error: null };
        const row = store[String(filters.id)];
        const visible = row && (!('company_id' in filters) || row.company_id === filters.company_id);
        if (!visible) return { data: null, error: { message: 'no rows' } };
        if (op === 'update') {
          const clean = JSON.parse(JSON.stringify(payload)); // undefined keys are not sent
          updates.push(clean);
          store[row.id] = { ...row, ...clean };
        }
        if (op === 'delete') { deletes.push(row.id); delete store[row.id]; return { data: null, error: null }; }
        return { data: { ...store[row.id] }, error: null };
      };
      b.single = () => Promise.resolve(resolve());
      b.then = (r: any, j: any) => Promise.resolve(resolve()).then(r, j);
      return b;
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../../../pages/api/external-apis/[id]').default;

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => undefined;
  return res;
}
async function call(user: string, method: string, id: string, query: Row, body?: Row) {
  currentUser = user;
  const res = mockRes();
  await handler({ method, query: { id, ...query }, body: body ?? {}, headers: {}, url: `/api/external-apis/${id}` }, res);
  return res;
}
const platformPut = (body: Row) => call('super-admin', 'PUT', PLATFORM_ROW.id, { scope: 'platform' }, { name: 'SerpAPI', ...body });
function expectNoFixture(body: unknown) {
  const json = JSON.stringify(body);
  for (const f of ALL_FAKES) expect(json).not.toContain(f);
}

beforeEach(() => {
  store = { [PLATFORM_ROW.id]: { ...PLATFORM_ROW }, [TENANT_ROW.id]: { ...TENANT_ROW } };
  updates.length = 0;
  deletes.length = 0;
  capabilityCalls.length = 0;
  currentUser = 'super-admin';
  legacyBridge = false;
  stepUp = 'ok';
  writeAuthority = true;
});

describe('H-4: destination / credential changes on a PLATFORM row need the provider-account gate', () => {
  it('a Super Admin session WITHOUT step-up cannot repoint base_url (403, nothing written)', async () => {
    stepUp = 'step_up_required';
    const res = await platformPut({ base_url: 'https://attacker.example/collect' });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('STEP_UP_REQUIRED');
    expect(capabilityCalls).toEqual([expect.objectContaining({ capability: CAPABILITY })]);
    expect(updates).toHaveLength(0);
    expect(store[PLATFORM_ROW.id].base_url).toBe(PLATFORM_ROW.base_url);
  });

  it('the legacy bridge cookie cannot repoint base_url (capability not held)', async () => {
    legacyBridge = true;
    stepUp = 'not_held';
    const res = await platformPut({ base_url: 'https://attacker.example/collect' });
    expect(res.statusCode).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it('a step-up principal WITHOUT platform write authority is refused', async () => {
    writeAuthority = false;
    const res = await platformPut({ base_url: 'https://attacker.example/collect' });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('PLATFORM_SUPER_ADMIN_REQUIRED');
    expect(updates).toHaveLength(0);
  });

  it('attaching another credential template ({{OPENAI_API_KEY}}) is a credential change: gated', async () => {
    stepUp = 'step_up_required';
    const res = await platformPut({ query_params: { engine: 'google', api_key: '{{OPENAI_API_KEY}}' } });
    expect(res.statusCode).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it('switching the env reference is a credential change: gated', async () => {
    stepUp = 'step_up_required';
    const res = await platformPut({ api_key_env_name: 'OPENAI_API_KEY' });
    expect(res.statusCode).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it('positive control: with step-up + authority the base_url change is written', async () => {
    const res = await platformPut({ base_url: 'https://serpapi.com/search.json' });
    expect(res.statusCode).toBe(200);
    expect(capabilityCalls).toHaveLength(1);
    expect(updates[0].base_url).toBe('https://serpapi.com/search.json');
  });

  it('positive control: a name-only edit needs no step-up (no gate call)', async () => {
    stepUp = 'step_up_required';
    const res = await platformPut({ name: 'SerpAPI (Google)', base_url: PLATFORM_ROW.base_url, method: 'get' });
    expect(res.statusCode).toBe(200);
    expect(capabilityCalls).toHaveLength(0);
    expect(updates).toHaveLength(1);
  });

  it('DELETE with platform privilege but without step-up is refused; nothing deleted', async () => {
    stepUp = 'step_up_required';
    const res = await call('super-admin', 'DELETE', PLATFORM_ROW.id, { scope: 'platform' });
    expect(res.statusCode).toBe(403);
    expect(deletes).toHaveLength(0);
  });

  it('positive control: DELETE with step-up + authority', async () => {
    const res = await call('super-admin', 'DELETE', PLATFORM_ROW.id, { scope: 'platform' });
    expect(res.statusCode).toBe(200);
    expect(deletes).toEqual([PLATFORM_ROW.id]);
  });

  it('positive control: a tenant admin editing its OWN row is unaffected by the platform gate', async () => {
    stepUp = 'step_up_required';
    const res = await call('admin-a', 'PUT', TENANT_ROW.id, { companyId: COMPANY_A }, { name: 'A feed', base_url: 'https://feeds.example.com/a2' });
    expect(res.statusCode).toBe(200);
    expect(capabilityCalls).toHaveLength(0);
    expect(updates[0].base_url).toBe('https://feeds.example.com/a2');
  });
});

describe('H-2: headers / query_params', () => {
  it('a key pasted into headers is refused (400, key names only); nothing written', async () => {
    const res = await platformPut({ headers: { Accept: 'application/json', 'X-Api-Key': FAKE_KEY } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'SECRET_VALUE_NOT_ALLOWED', field: 'headers', keys: ['X-Api-Key'] });
    expectNoFixture(res.body);
    expect(updates).toHaveLength(0);
  });

  it('the Unsplash-style _client_secret_env literal is refused too', async () => {
    const res = await platformPut({ headers: { _client_secret_env: FAKE_SECRET } });
    expect(res.statusCode).toBe(400);
    expectNoFixture(res.body);
    expect(updates).toHaveLength(0);
  });

  it('a tenant cannot paste a key into its own row\'s query_params either', async () => {
    const res = await call('admin-a', 'PUT', TENANT_ROW.id, { companyId: COMPANY_A }, { name: 'A feed', query_params: { key: FAKE_KEY } });
    expect(res.statusCode).toBe(400);
    expectNoFixture(res.body);
    expect(updates).toHaveLength(0);
  });

  it('GET redacts secret-shaped map values and OAuth ciphertext', async () => {
    store[PLATFORM_ROW.id] = {
      ...PLATFORM_ROW,
      headers: { Accept: 'application/json', _client_secret_env: FAKE_SECRET },
      query_params: { engine: 'google', api_key: FAKE_KEY },
      oauth_client_secret_encrypted: FAKE_CIPHERTEXT,
    };
    const res = await call('super-admin', 'GET', PLATFORM_ROW.id, { scope: 'platform' });
    expect(res.statusCode).toBe(200);
    expect(res.body.api.headers).toEqual({ Accept: 'application/json', _client_secret_env: SECRET_MARKER });
    expect(res.body.api.query_params).toEqual({ engine: 'google', api_key: SECRET_MARKER });
    expect(res.body.api.oauth_client_secret_encrypted).toBe(SECRET_MARKER);
    expectNoFixture(res.body);
  });

  it('the read marker round-trips as "unchanged": the legacy value stays stored, nothing leaks, no step-up', async () => {
    store[PLATFORM_ROW.id] = { ...PLATFORM_ROW, headers: { Accept: 'application/json', _client_secret_env: FAKE_SECRET } };
    stepUp = 'step_up_required';
    const read = await call('super-admin', 'GET', PLATFORM_ROW.id, { scope: 'platform' });
    const res = await platformPut({ name: 'SerpAPI renamed', headers: read.body.api.headers });
    expect(res.statusCode).toBe(200);
    expect(updates[0].headers._client_secret_env).toBe(FAKE_SECRET); // not the marker, not lost
    expect(capabilityCalls).toHaveLength(0);
    expectNoFixture(res.body);
  });
});

describe('H-5: a tenant cannot mark a row as a preset', () => {
  it('tenant PUT is_preset:true on its own row → 403, nothing written', async () => {
    const res = await call('admin-a', 'PUT', TENANT_ROW.id, { companyId: COMPANY_A }, { name: 'A feed', is_preset: true });
    expect(res.statusCode).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it('positive control: an unchanged is_preset:false round-trips', async () => {
    const res = await call('admin-a', 'PUT', TENANT_ROW.id, { companyId: COMPANY_A }, { name: 'A feed', is_preset: false });
    expect(res.statusCode).toBe(200);
  });

  it('positive control: the Super Admin may set it', async () => {
    store[TENANT_ROW.id] = { ...TENANT_ROW };
    const res = await call('super-admin', 'PUT', TENANT_ROW.id, { companyId: COMPANY_A }, { name: 'A feed', is_preset: true });
    expect(res.statusCode).toBe(200);
    expect(updates[0].is_preset).toBe(true);
  });
});
