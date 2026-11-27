/**
 * Round 23 B/C — TENANT-visible and tenant-writable paths for a secret held in a
 * credential-REFERENCE field (not in round 21's list; found by the 23B/C exposure map).
 *
 * At 2bc52db7a:
 *   - GET /api/external-apis/presets?companyId=… (any company role) lists every is_preset row,
 *     platform rows included, with `api_key_env_name: preset.api_key_env_name || …` raw;
 *   - GET /api/external-apis/access?companyId=… (any company role) returns `apis`,
 *     `availableApis` and `global_presets` built from `select('*')` rows, unredacted;
 *   - POST /api/external-apis/access stores a per-company `api_key_env_name` override with no
 *     validation (it replaces the source's reference at execution time) and echoes it back;
 *   - POST /api/external-apis/requests stores `api_key_env_name` with no validation, and
 *     PUT /api/external-apis/requests/[id] {action:'approve'} copies it into
 *     external_api_sources.
 * The real routes run; only auth, RBAC and the data layer are scripted. FAKE 32-hex fixture.
 */
export {};

type Row = Record<string, any>;

const FAKE_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // fake fixture, not a real key
const MARKER = '__REDACTED_INVALID_ENV_VAR_NAME__';
const COMPANY = 'company-a';
const TENANT = 'user-tenant-viewer';

const NEWS_PRESET: Row = {
  id: 'src-newsapi-platform', company_id: null, name: 'NewsAPI', is_preset: true, is_active: true,
  category: 'news', is_whitelisted: true, is_enabled_global: true,
  base_url: 'https://newsapi.org/v2/top-headlines', method: 'GET', auth_type: 'api_key',
  api_key_env_name: FAKE_KEY, api_key_name: null, headers: {}, query_params: {},
};

/** table → rows the scripted PostgREST returns for any read. */
let tables: Record<string, Row[]> = {};
const writes: Array<{ table: string; op: string; payload: unknown }> = [];
let role = 'CONTENT_CREATOR';
// Round 26 (H-6): approve is Super Admin only, so the approve cases below run as a Super Admin.
let superAdmin = false;
const saveTenantPlatformConfig = jest.fn(async (row: Row) => ({ id: 'new-src', ...row }));

jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      let op = 'select';
      let payload: unknown;
      const b: any = {};
      for (const m of ['select', 'eq', 'is', 'in', 'gte', 'or', 'order', 'limit', 'neq']) b[m] = () => b;
      b.insert = (p: unknown) => { op = 'insert'; payload = p; return b; };
      b.upsert = (p: unknown) => { op = 'upsert'; payload = p; return b; };
      b.update = (p: unknown) => { op = 'update'; payload = p; return b; };
      const resolve = (single: boolean) => {
        if (op !== 'select') {
          writes.push({ table, op, payload });
          return { data: Array.isArray(payload) ? payload : { id: 'w1', ...(payload as Row) }, error: null };
        }
        const rows = tables[table] ?? [];
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      };
      b.single = () => Promise.resolve(resolve(true));
      b.maybeSingle = () => Promise.resolve(resolve(true));
      b.then = (r: any, j: any) => Promise.resolve(resolve(false)).then(r, j);
      return b;
    },
  },
}));
jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: jest.fn(async () => ({ user: { id: 'user-tenant-viewer' }, error: null })),
}));
jest.mock('../../services/superAdminSession', () => ({ getLegacySuperAdminSession: jest.fn(() => null) }));
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: jest.fn(async () => ({ userId: 'user-tenant-viewer', role: 'user', companyIds: ['company-a'], defaultCompanyId: 'company-a', authenticated: true })),
}));
jest.mock('../../services/rbacService', () => ({
  Role: { SUPER_ADMIN: 'SUPER_ADMIN', COMPANY_ADMIN: 'COMPANY_ADMIN', ADMIN: 'ADMIN' },
  isPlatformSuperAdmin: jest.fn(async () => superAdmin),
  isSuperAdmin: jest.fn(async () => superAdmin),
  getUserRole: jest.fn(async () => ({ role, error: null })),
  getCompanyRoleIncludingInvited: jest.fn(async () => null),
  hasPermission: jest.fn(async (r: string) => r === 'COMPANY_ADMIN'),
}));
jest.mock('../../security/requireCapability', () => ({ requireCapability: jest.fn(async () => ({ ok: false })) }));
jest.mock('../../services/externalApiService', () => ({
  getAvailableApis: jest.fn(async () => [NEWS_PRESET]),
  getEnabledApis: jest.fn(async () => [NEWS_PRESET]),
  getCompanyDefaultApiIds: jest.fn(async () => []),
  getEnabledApiIdsFromCompanyConfig: jest.fn(async () => []),
  getUserApiAccess: jest.fn(async () => [{ api_source_id: 'src-newsapi-platform', user_id: 'user-tenant-viewer', api_key_env_name: FAKE_KEY }]),
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
  return res;
}
async function call(route: string, req: Row) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const handler = require(`../../../pages/api/external-apis/${route}`).default;
  const res = mockRes();
  await handler({ headers: {}, body: {}, url: `/api/external-apis/${route}`, ...req }, res);
  return res;
}

beforeEach(() => {
  tables = { external_api_sources: [{ ...NEWS_PRESET }], company_api_configs: [] };
  writes.length = 0;
  role = 'CONTENT_CREATOR';
  superAdmin = false;
  saveTenantPlatformConfig.mockClear();
});

describe('tenant reads', () => {
  it('GET /presets (tenant branch) does not serve the secret', async () => {
    const res = await call('presets', { method: 'GET', query: { companyId: COMPANY } });
    expect(res.statusCode).toBe(200);
    const news = res.body.presets.find((p: Row) => p.id === NEWS_PRESET.id);
    expect(news).toBeDefined(); // the platform row WAS listed to the tenant (precondition)
    expect(news.api_key_env_name).toBe(MARKER);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
  });

  it('positive control: GET /presets still serves a valid env-var name', async () => {
    tables.external_api_sources = [{ ...NEWS_PRESET, api_key_env_name: 'NEWS_API_KEY' }];
    const res = await call('presets', { method: 'GET', query: { companyId: COMPANY } });
    const news = res.body.presets.find((p: Row) => p.id === NEWS_PRESET.id);
    expect(news.api_key_env_name).toBe('NEWS_API_KEY');
  });

  it('GET /access does not serve the secret (apis, availableApis, global_presets, user_access)', async () => {
    const res = await call('access', { method: 'GET', query: { companyId: COMPANY } });
    expect(res.statusCode).toBe(200);
    expect(res.body.apis[0].id).toBe(NEWS_PRESET.id); // precondition: rows were served
    expect(res.body.global_presets[0].id).toBe(NEWS_PRESET.id);
    expect(res.body.availableApis[0].api_key_env_name).toBe(MARKER);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
  });
});

describe('tenant writes', () => {
  it('POST /access rejects a secret as the per-company api_key_env_name override', async () => {
    role = 'COMPANY_ADMIN';
    const res = await call('access', {
      method: 'POST', query: { companyId: COMPANY },
      body: { companyId: COMPANY, api_source_id: NEWS_PRESET.id, api_key_env_name: FAKE_KEY },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('INVALID_ENV_VAR_NAME');
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
    expect(writes.filter((w) => w.table === 'external_api_user_access')).toHaveLength(0);
  });

  it('POST /requests rejects a secret in api_key_env_name and writes nothing', async () => {
    const res = await call('requests', {
      method: 'POST', query: { companyId: COMPANY },
      body: { companyId: COMPANY, name: 'My news', base_url: 'https://newsapi.org/v2/everything', auth_type: 'api_key', api_key_env_name: FAKE_KEY },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
    expect(writes).toHaveLength(0);
  });

  it('positive control: POST /requests with a valid env-var name is accepted', async () => {
    const res = await call('requests', {
      method: 'POST', query: { companyId: COMPANY },
      body: { companyId: COMPANY, name: 'My news', base_url: 'https://newsapi.org/v2/everything', auth_type: 'api_key', api_key_env_name: 'NEWS_API_KEY' },
    });
    expect(res.statusCode).toBe(201);
    expect(writes).toHaveLength(1);
  });

  it('PUT /requests/[id] approve refuses to copy a legacy secret into external_api_sources', async () => {
    role = 'COMPANY_ADMIN';
    superAdmin = true; // Round 26 (H-6): only a Super Admin reaches the approve branch
    tables.external_api_source_requests = [{
      id: 'req-1', company_id: COMPANY, status: 'pending_admin_review', name: 'My news',
      base_url: 'https://newsapi.org/v2/everything', auth_type: 'api_key', api_key_env_name: FAKE_KEY,
    }];
    const res = await call('requests/[id]', { method: 'PUT', query: { id: 'req-1', companyId: COMPANY }, body: { action: 'approve' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
    expect(saveTenantPlatformConfig).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('positive control: approve with a valid env-var name still provisions the source', async () => {
    role = 'COMPANY_ADMIN';
    superAdmin = true; // Round 26 (H-6): as COMPANY_ADMIN this control asserted self-approval
    tables.external_api_source_requests = [{
      id: 'req-2', company_id: COMPANY, status: 'pending_admin_review', name: 'My news',
      base_url: 'https://newsapi.org/v2/everything', auth_type: 'api_key', api_key_env_name: 'NEWS_API_KEY',
    }];
    const res = await call('requests/[id]', { method: 'PUT', query: { id: 'req-2', companyId: COMPANY }, body: { action: 'approve' } });
    expect(res.statusCode).toBe(200);
    expect(saveTenantPlatformConfig).toHaveBeenCalledWith(expect.objectContaining({ api_key_env_name: 'NEWS_API_KEY' }));
  });
});
