/**
 * Round 26 (Agent B) — tenant-reachable shared endpoints after aa3cc2bc6.
 *
 *   H-5  GET /api/external-apis/presets?companyId= listed the is_preset rows of EVERY company
 *        (at 2bc52db7a and aa3cc2bc6). NOW: platform rows + the caller's own company only.
 *   H-2  headers / query_params (and request / override maps) were accepted and served raw,
 *        so a key pasted into them (the Super Admin UI invited `_client_secret_env`) reached
 *        every tenant. NOW: refused on write (key NAMES in the error, never values) and
 *        replaced by a marker on read; OAuth ciphertext is never served.
 *   H-6  PUT /requests/[id] {action:'approve'} was open to the requesting company's admin
 *        (self-approval). NOW: Super Admin only.
 *
 * The REAL routes run; auth/RBAC, the data layer and the externalApiService facade are
 * scripted. The data layer honours eq / is / in / or, so scoping is exercised. FAKE fixtures.
 */
export {};

type Row = Record<string, any>;

const FAKE_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // fake 32-hex fixture, not a real key
const FAKE_SECRET = 'fake_client_secret_fixture_0123456789'; // fake, not a real secret
const FAKE_A_KEY = 'b2c3d4e5f60718293a4b5c6d7e8f90a1'; // fake: company A's own key
const FAKE_CIPHERTEXT = '0123456789abcdef01234567:0123456789abcdef0123456789abcdef:deadbeef'; // fake
const ALL_FAKES = [FAKE_KEY, FAKE_SECRET, FAKE_A_KEY, FAKE_CIPHERTEXT];
const SECRET_MARKER = '__REDACTED_SECRET_VALUE__';
const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

const PLATFORM_PRESET: Row = {
  id: 'src-platform-news', company_id: null, name: 'NewsAPI', is_preset: true, is_active: true,
  category: 'news', is_whitelisted: true, is_enabled_global: true,
  base_url: 'https://newsapi.org/v2/top-headlines', method: 'GET', auth_type: 'api_key',
  api_key_env_name: 'NEWS_API_KEY', api_key_name: null,
  headers: { Accept: 'application/json', Authorization: 'Bearer {{NEWS_API_KEY}}', _client_secret_env: FAKE_SECRET },
  query_params: { country: 'us', apiKey: FAKE_KEY },
  oauth_client_secret_encrypted: FAKE_CIPHERTEXT, created_at: '2026-01-01',
};
const PRESET_A: Row = {
  ...PLATFORM_PRESET, id: 'src-a-private', company_id: COMPANY_A, name: 'A private preset',
  base_url: 'https://attacker.example/a', headers: { 'X-Api-Key': FAKE_A_KEY }, query_params: {},
  oauth_client_secret_encrypted: null,
};
const PRESET_B: Row = {
  ...PRESET_A, id: 'src-b-own', company_id: COMPANY_B, name: 'B own preset',
  base_url: 'https://feeds.example.com/b', headers: { Accept: 'text/csv' },
};

let tables: Record<string, Row[]> = {};
const writes: Array<{ table: string; op: string; payload: unknown }> = [];
let currentUser = 'viewer-b';
const SUPER_ADMINS = new Set(['super-admin']);
const MEMBERSHIPS: Record<string, Record<string, string>> = {
  'viewer-b': { [COMPANY_B]: 'VIEW_ONLY' },
  'admin-a': { [COMPANY_A]: 'COMPANY_ADMIN' },
  'super-admin': {},
};
const saveTenantPlatformConfig = jest.fn(async (row: Row) => ({ id: 'new-src', ...row }));

function parseOr(expr: string): (r: Row) => boolean {
  const parts = expr.split(',').map((p) => {
    const [col, op, ...rest] = p.split('.');
    const val = rest.join('.');
    if (op === 'is' && val === 'null') return (r: Row) => r[col] == null;
    if (op === 'eq') return (r: Row) => String(r[col]) === val;
    if (op === 'like') {
      const parts = val.split('%');
      return (r: Row) => {
        const v = String(r[col] ?? '');
        if (parts.length === 1) return v === val;
        return v.startsWith(parts[0]) && v.endsWith(parts[parts.length - 1]);
      };
    }
    throw new Error(`unsupported or-filter ${p}`);
  });
  return (r: Row) => parts.some((f) => f(r));
}
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      let op = 'select';
      let payload: unknown;
      const filters: Array<(r: Row) => boolean> = [];
      const b: any = {};
      for (const m of ['select', 'gte', 'order', 'limit']) b[m] = () => b;
      b.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; };
      b.neq = (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return b; };
      b.is = (c: string, v: unknown) => { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; };
      b.in = (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return b; };
      b.or = (expr: string) => { filters.push(parseOr(expr)); return b; };
      b.insert = (p: unknown) => { op = 'insert'; payload = p; return b; };
      b.upsert = (p: unknown) => { op = 'upsert'; payload = p; return b; };
      b.update = (p: unknown) => { op = 'update'; payload = p; return b; };
      const resolve = (single: boolean) => {
        if (op !== 'select') {
          writes.push({ table, op, payload });
          return { data: Array.isArray(payload) ? payload : { id: 'w1', ...(payload as Row) }, error: null };
        }
        const hit = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return { data: single ? (hit[0] ?? null) : hit, error: null };
      };
      b.single = () => Promise.resolve(resolve(true));
      b.maybeSingle = () => Promise.resolve(resolve(true));
      b.then = (r: any, j: any) => Promise.resolve(resolve(false)).then(r, j);
      return b;
    },
  },
}));
jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: jest.fn(async () => ({ user: { id: currentUser }, error: null })),
}));
jest.mock('../../services/superAdminSession', () => ({ getLegacySuperAdminSession: jest.fn(() => null) }));
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: jest.fn(async () => ({ userId: currentUser, role: 'user', companyIds: [], defaultCompanyId: '', authenticated: true })),
}));
jest.mock('../../services/rbacService', () => ({
  Role: { SUPER_ADMIN: 'SUPER_ADMIN', COMPANY_ADMIN: 'COMPANY_ADMIN', ADMIN: 'ADMIN' },
  isPlatformSuperAdmin: jest.fn(async (id: string) => SUPER_ADMINS.has(id)),
  isSuperAdmin: jest.fn(async (id: string) => SUPER_ADMINS.has(id)),
  getUserRole: jest.fn(async (id: string, companyId: string) => {
    const role = MEMBERSHIPS[id]?.[companyId] ?? null;
    return role ? { role, error: null } : { role: null, error: 'COMPANY_ACCESS_DENIED' };
  }),
  getCompanyRoleIncludingInvited: jest.fn(async () => null),
  hasPermission: jest.fn(async (r: string) => r === 'COMPANY_ADMIN'),
}));
jest.mock('../../security/requireCapability', () => ({ requireCapability: jest.fn(async () => ({ ok: false })) }));
jest.mock('../../services/externalApiService', () => ({
  getAvailableApis: jest.fn(async () => [{ ...PLATFORM_PRESET }]),
  getEnabledApis: jest.fn(async () => [{ ...PLATFORM_PRESET }]),
  getCompanyDefaultApiIds: jest.fn(async () => []),
  getEnabledApiIdsFromCompanyConfig: jest.fn(async () => []),
  getUserApiAccess: jest.fn(async () => []),
  validatePlatformConfig: jest.fn(() => ({ ok: true })),
  saveTenantPlatformConfig: (row: Row) => saveTenantPlatformConfig(row),
}));
jest.mock('../../services/companyApiConfigCache', () => ({
  invalidateCompanyConfigCache: jest.fn(), getCompanyConfigRows: jest.fn(async () => []),
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => undefined;
  return res;
}
async function call(user: string, route: string, req: Row) {
  currentUser = user;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const handler = require(`../../../pages/api/external-apis/${route}`).default;
  const res = mockRes();
  await handler({ headers: {}, body: {}, url: `/api/external-apis/${route}`, ...req }, res);
  return res;
}
/** Credential-extraction sweep: no fixture value anywhere in the serialized response. */
function expectNoFixture(body: unknown) {
  const json = JSON.stringify(body);
  for (const f of ALL_FAKES) expect(json).not.toContain(f);
}

beforeEach(() => {
  tables = {
    external_api_sources: [{ ...PLATFORM_PRESET }, { ...PRESET_A }, { ...PRESET_B }],
    company_api_configs: [],
    external_api_source_requests: [],
  };
  writes.length = 0;
  saveTenantPlatformConfig.mockClear();
});

describe('H-5 GET /presets (tenant branch) — different tenant', () => {
  it('company B never sees company A\'s preset row (id, base_url, its key)', async () => {
    const res = await call('viewer-b', 'presets', { method: 'GET', query: { companyId: COMPANY_B } });
    expect(res.statusCode).toBe(200);
    const ids = res.body.presets.map((p: Row) => p.id);
    expect(ids).toEqual(expect.arrayContaining([PLATFORM_PRESET.id, PRESET_B.id])); // precondition: rows served
    expect(ids).not.toContain(PRESET_A.id);
    expect(JSON.stringify(res.body)).not.toContain('attacker.example');
    expectNoFixture(res.body);
  });

  it('a filter-breaking companyId is refused (no PostgREST filter injection)', async () => {
    MEMBERSHIPS['viewer-b']['company-b,company_id.not.is.null'] = 'VIEW_ONLY';
    try {
      const res = await call('viewer-b', 'presets', { method: 'GET', query: { companyId: 'company-b,company_id.not.is.null' } });
      expect(res.statusCode).toBe(400);
    } finally {
      delete MEMBERSHIPS['viewer-b']['company-b,company_id.not.is.null'];
    }
  });
});

describe('H-2 read redaction of headers / query_params (malformed preset metadata)', () => {
  it('GET /presets serves markers in place of secret-shaped values; normal values unchanged', async () => {
    const res = await call('viewer-b', 'presets', { method: 'GET', query: { companyId: COMPANY_B } });
    const news = res.body.presets.find((p: Row) => p.id === PLATFORM_PRESET.id);
    expect(news.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer {{NEWS_API_KEY}}', _client_secret_env: SECRET_MARKER });
    expect(news.query_params).toEqual({ country: 'us', apiKey: SECRET_MARKER });
    expectNoFixture(res.body);
  });

  it('GET /presets?scope=platform (Super Admin) is redacted the same way', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireCapability } = require('../../security/requireCapability');
    requireCapability.mockImplementationOnce(async () => ({ ok: true, principal: { userId: 'super-admin' } }));
    const res = await call('super-admin', 'presets', { method: 'GET', query: { scope: 'platform' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.presets.some((p: Row) => p.id === PLATFORM_PRESET.id)).toBe(true);
    expectNoFixture(res.body);
  });

  it('GET /access (any company role) never serves the secrets or the OAuth ciphertext', async () => {
    const res = await call('viewer-b', 'access', { method: 'GET', query: { companyId: COMPANY_B } });
    expect(res.statusCode).toBe(200);
    expect(res.body.availableApis[0].id).toBe(PLATFORM_PRESET.id); // precondition
    expect(res.body.availableApis[0].oauth_client_secret_encrypted).toBe(SECRET_MARKER);
    expectNoFixture(res.body);
  });

  it('GET /requests never serves a secret held in a request\'s headers', async () => {
    tables.external_api_source_requests = [{
      id: 'req-b', company_id: COMPANY_B, created_by_user_id: 'viewer-b', status: 'pending_admin_review',
      name: 'B feed', headers: { 'X-Api-Key': FAKE_KEY }, query_params: { token: FAKE_SECRET }, api_key_env_name: null,
    }];
    const res = await call('viewer-b', 'requests', { method: 'GET', query: { companyId: COMPANY_B } });
    expect(res.statusCode).toBe(200);
    expect(res.body.requests).toHaveLength(1); // precondition
    expectNoFixture(res.body);
  });
});

describe('H-2 write validation (secret in headers / query params)', () => {
  it('POST /requests with a key in headers is refused (400, names only), nothing written', async () => {
    const res = await call('viewer-b', 'requests', {
      method: 'POST', query: { companyId: COMPANY_B },
      body: { companyId: COMPANY_B, name: 'My feed', base_url: 'https://newsapi.org/v2/everything', auth_type: 'none', headers: { 'X-Api-Key': FAKE_KEY } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'SECRET_VALUE_NOT_ALLOWED', field: 'headers', keys: ['X-Api-Key'] });
    expectNoFixture(res.body);
    expect(writes).toHaveLength(0);
  });

  it('positive control: POST /requests with templates and ordinary values is accepted', async () => {
    const res = await call('viewer-b', 'requests', {
      method: 'POST', query: { companyId: COMPANY_B },
      body: {
        companyId: COMPANY_B, name: 'My feed', base_url: 'https://newsapi.org/v2/everything', auth_type: 'api_key',
        api_key_env_name: 'NEWS_API_KEY', headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; OmnivyraBot/1.0)' },
        query_params: { q: 'ai', apiKey: '{{NEWS_API_KEY}}', channelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(writes).toHaveLength(1);
  });

  it('POST /access rejects a key in headers_override / query_params_override, nothing written', async () => {
    for (const body of [
      { headers_override: { Authorization: ['Bearer', FAKE_KEY].join(' ') } },
      { query_params_override: { api_key: FAKE_KEY } },
    ]) {
      writes.length = 0;
      const res = await call('admin-a', 'access', {
        method: 'POST', query: { companyId: COMPANY_A },
        body: { companyId: COMPANY_A, api_source_id: PLATFORM_PRESET.id, ...body },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('SECRET_VALUE_NOT_ALLOWED');
      expectNoFixture(res.body);
      expect(writes.filter((w) => w.table === 'external_api_user_access')).toHaveLength(0);
    }
  });
});

describe('H-6 PUT /requests/[id] approve — Super Admin only (separation of duties)', () => {
  const request = (over: Row = {}): Row => ({
    id: 'req-a', company_id: COMPANY_A, status: 'pending_admin_review', name: 'A feed',
    base_url: 'https://feeds.example.com/a', auth_type: 'api_key', api_key_env_name: 'NEWS_API_KEY',
    headers: {}, query_params: {}, ...over,
  });

  it('the requesting company\'s ADMIN cannot approve its own request (403, nothing written)', async () => {
    tables.external_api_source_requests = [request()];
    const res = await call('admin-a', 'requests/[id]', { method: 'PUT', query: { id: 'req-a', companyId: COMPANY_A }, body: { action: 'approve' } });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('SUPER_ADMIN_APPROVAL_REQUIRED');
    expect(saveTenantPlatformConfig).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('… nor via the legacy action alias "approved"', async () => {
    tables.external_api_source_requests = [request()];
    const res = await call('admin-a', 'requests/[id]', { method: 'PUT', query: { id: 'req-a', companyId: COMPANY_A }, body: { status: 'approved' } });
    expect(res.statusCode).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('positive control: the company admin can still forward it (send_to_super_admin)', async () => {
    tables.external_api_source_requests = [request()];
    const res = await call('admin-a', 'requests/[id]', { method: 'PUT', query: { id: 'req-a', companyId: COMPANY_A }, body: { action: 'send_to_super_admin' } });
    expect(res.statusCode).toBe(200);
  });

  it('positive control: a Super Admin approves and the source is provisioned', async () => {
    tables.external_api_source_requests = [request()];
    const res = await call('super-admin', 'requests/[id]', { method: 'PUT', query: { id: 'req-a', scope: 'platform' }, body: { action: 'approve' } });
    expect(res.statusCode).toBe(200);
    expect(saveTenantPlatformConfig).toHaveBeenCalledWith(expect.objectContaining({ company_id: COMPANY_A, api_key_env_name: 'NEWS_API_KEY' }));
  });

  it('a Super Admin approving a legacy request with a key in its headers is refused, nothing written', async () => {
    tables.external_api_source_requests = [request({ headers: { 'X-Api-Key': FAKE_KEY } })];
    const res = await call('super-admin', 'requests/[id]', { method: 'PUT', query: { id: 'req-a', scope: 'platform' }, body: { action: 'approve' } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('SECRET_VALUE_NOT_ALLOWED');
    expectNoFixture(res.body);
    expect(saveTenantPlatformConfig).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});
