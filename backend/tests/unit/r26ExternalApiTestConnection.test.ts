/**
 * Round 26 (Agent B) — POST /api/external-apis/[id]/test-connection.
 *
 * H-3: at 2bc52db7a AND at aa3cc2bc6 any company role could test a PLATFORM row
 * (company_id IS NULL): `resolveApiSource` admitted `company_id.is.null`, the request ran with
 * platform credentials, the platform health record was written, and the provider's error text
 * (or `Missing: <reference>`) came back verbatim. NOW: platform rows are Super-Admin-only
 * (403 before any credential is resolved, any fetch or any health write), every returned
 * message is redacted of the credentials that were sent, and calls are rate limited per user.
 *
 * The REAL route, service and executor run; only auth/RBAC, the data layer, the network
 * (safeFetch), the health writer and the limiter are scripted. The data-layer mock honours
 * eq / is / or filters, so tenant scoping is exercised, not assumed. FAKE fixtures only.
 */
export {};

type Row = Record<string, any>;

const FAKE_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // fake 32-hex fixture, not a real key
const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

const PLATFORM_ROW: Row = {
  id: 'src-platform-news', company_id: null, name: 'NewsAPI', is_preset: true, is_active: true,
  category: 'news', is_whitelisted: true, base_url: 'https://newsapi.org/v2/top-headlines',
  method: 'GET', auth_type: 'api_key', api_key_env_name: 'NEWS_API_KEY', api_key_name: null,
  headers: {}, query_params: { country: 'us' },
};
const OWN_ROW_A: Row = {
  ...PLATFORM_ROW, id: 'src-tenant-a', company_id: COMPANY_A, name: 'A feed', is_preset: false,
  auth_type: 'none', api_key_env_name: null, base_url: 'https://feeds.example.com/a',
};
const FOREIGN_ROW_B: Row = { ...OWN_ROW_A, id: 'src-tenant-b', company_id: COMPANY_B, name: 'B feed' };

let rows: Row[] = [];
let currentUser = 'viewer-a';
const SUPER_ADMINS = new Set(['super-admin']);
const MEMBERSHIPS: Record<string, Record<string, string>> = {
  'viewer-a': { [COMPANY_A]: 'VIEW_ONLY' },
  'admin-a': { [COMPANY_A]: 'COMPANY_ADMIN' },
  'super-admin': {},
};

const fetchCalls: string[] = [];
let fetchImpl: (url: string, init: any) => Promise<any> = async () => ({
  ok: true, status: 200, statusText: 'OK', text: async () => '{}',
});
const healthWrites: Row[] = [];
const rateLimitCalls: Array<{ id: string; cfg: Row }> = [];
let rateLimitAllowed = true;

// ── data layer: honours eq / is / or (the subset PostgREST filters these routes use) ──
function rowMatches(row: Row, filters: Array<(r: Row) => boolean>) {
  return filters.every((f) => f(row));
}
function parseOr(expr: string): (r: Row) => boolean {
  const parts = expr.split(',').map((p) => {
    const [col, op, ...rest] = p.split('.');
    const val = rest.join('.');
    if (op === 'is' && val === 'null') return (r: Row) => r[col] == null;
    if (op === 'eq') return (r: Row) => String(r[col]) === val;
    throw new Error(`unsupported or-filter ${p}`);
  });
  return (r: Row) => parts.some((f) => f(r));
}
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = [];
      const b: any = {};
      b.select = () => b;
      b.order = () => b;
      b.limit = () => b;
      b.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; };
      b.is = (c: string, v: unknown) => { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; };
      b.or = (expr: string) => { filters.push(parseOr(expr)); return b; };
      const source = () => (table === 'external_api_sources' ? rows : []);
      b.single = async () => {
        const hit = source().filter((r) => rowMatches(r, filters));
        return hit.length === 1 ? { data: { ...hit[0] }, error: null } : { data: null, error: { message: 'no rows' } };
      };
      b.then = (res: any, rej: any) => Promise.resolve({ data: source().filter((r) => rowMatches(r, filters)), error: null }).then(res, rej);
      return b;
    },
  },
}));
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: () => ({ select: async () => ({ data: [], error: null }) }),
}));
jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: jest.fn(async () => ({ user: { id: currentUser }, error: null })),
}));
jest.mock('../../services/superAdminSession', () => ({ getLegacySuperAdminSession: jest.fn(() => null) }));
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
jest.mock('../../services/externalApiService', () => {
  const exec = jest.requireActual('../../services/externalApi/execution');
  return { buildExternalApiRequest: exec.buildExternalApiRequest };
});
jest.mock('../../services/externalApiHealthService', () => ({
  updateApiHealth: jest.fn(async (row: Row) => { healthWrites.push(row); return null; }),
}));
jest.mock('../../../lib/security/safeFetch', () => ({
  safeFetch: jest.fn(async (url: string, init: any) => { fetchCalls.push(url); return fetchImpl(url, init); }),
}));
jest.mock('../../../lib/auth/rateLimit', () => ({
  checkRateLimit: jest.fn(async (id: string, cfg: Row) => {
    rateLimitCalls.push({ id, cfg });
    return { allowed: rateLimitAllowed, remaining: rateLimitAllowed ? 9 : 0, resetAt: 0, bypassed: false };
  }),
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../../../pages/api/external-apis/[id]/test-connection').default;

function mockRes() {
  const res: any = { statusCode: 0, body: undefined, headers: {} as Row };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  return res;
}
async function testConnection(user: string, id: string, query: Row) {
  currentUser = user;
  const res = mockRes();
  await handler({ method: 'POST', query: { id, ...query }, headers: {}, body: {}, url: `/api/external-apis/${id}/test-connection` }, res);
  return res;
}

const savedNewsKey = process.env.NEWS_API_KEY;
beforeEach(() => {
  rows = [{ ...PLATFORM_ROW }, { ...OWN_ROW_A }, { ...FOREIGN_ROW_B }];
  fetchCalls.length = 0;
  healthWrites.length = 0;
  rateLimitCalls.length = 0;
  rateLimitAllowed = true;
  fetchImpl = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '{}' });
  process.env.NEWS_API_KEY = FAKE_KEY;
});
afterAll(() => {
  if (savedNewsKey === undefined) delete process.env.NEWS_API_KEY;
  else process.env.NEWS_API_KEY = savedNewsKey;
});

describe('H-3: platform rows are Super-Admin-only', () => {
  it('an unauthorised tenant role (VIEW_ONLY of company A) gets 403; no fetch, no health write', async () => {
    const res = await testConnection('viewer-a', PLATFORM_ROW.id, { companyId: COMPANY_A });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('PLATFORM_SOURCE_SUPER_ADMIN_ONLY');
    expect(fetchCalls).toHaveLength(0);
    expect(healthWrites).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
  });

  it('a company ADMIN of company A is refused too (tenant admin is not a platform admin)', async () => {
    const res = await testConnection('admin-a', PLATFORM_ROW.id, { companyId: COMPANY_A });
    expect(res.statusCode).toBe(403);
    expect(fetchCalls).toHaveLength(0);
    expect(healthWrites).toHaveLength(0);
  });

  it('missing credential: a tenant cannot read the "Missing: …" diagnostic of a platform row', async () => {
    delete process.env.NEWS_API_KEY;
    const res = await testConnection('viewer-a', PLATFORM_ROW.id, { companyId: COMPANY_A });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('NEWS_API_KEY');
    expect(healthWrites).toHaveLength(0);
  });

  it('positive control: a Super Admin (company context) tests the platform row; the key is sent', async () => {
    const res = await testConnection('super-admin', PLATFORM_ROW.id, { companyId: COMPANY_A });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain('newsapi.org'); // the platform credential WAS used (precondition)
    expect(fetchCalls[0]).toContain(FAKE_KEY);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
  });

  it('positive control: a Super Admin with scope=platform', async () => {
    const res = await testConnection('super-admin', PLATFORM_ROW.id, { scope: 'platform' });
    expect(res.statusCode).toBe(200);
    expect(fetchCalls).toHaveLength(1);
  });

  it('positive control: a tenant still tests its OWN company row', async () => {
    const res = await testConnection('viewer-a', OWN_ROW_A.id, { companyId: COMPANY_A });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain('https://feeds.example.com/a');
  });

  it('missing credential (Super Admin): reported by NAME, never a value', async () => {
    delete process.env.NEWS_API_KEY;
    const res = await testConnection('super-admin', PLATFORM_ROW.id, { scope: 'platform' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: false, status: 400, message: 'Missing: NEWS_API_KEY' });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('different tenant (regression guard — the data filter already held at 2bc52db7a)', () => {
  it('a company-A user cannot test company B\'s row through company A', async () => {
    const res = await testConnection('admin-a', FOREIGN_ROW_B.id, { companyId: COMPANY_A });
    expect(res.body.status).toBe(404);
    expect(fetchCalls).toHaveLength(0);
    expect(healthWrites).toHaveLength(0);
  });
  it('… nor by naming company B (no role there)', async () => {
    const res = await testConnection('admin-a', FOREIGN_ROW_B.id, { companyId: COMPANY_B });
    expect(res.statusCode).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('error-message redaction (Super Admin path; the provider echoes the key)', () => {
  it('a provider error body that echoes the sent key is redacted', async () => {
    fetchImpl = async () => ({
      ok: false, status: 401, statusText: 'Unauthorized',
      text: async () => JSON.stringify({ status: 'error', code: 'apiKeyInvalid', message: `Your API key ${FAKE_KEY} is invalid.` }),
    });
    const res = await testConnection('super-admin', PLATFORM_ROW.id, { scope: 'platform' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.status).toBe(401);
    expect(res.body.message).toContain('is invalid'); // the diagnostic survives (precondition)
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
  });

  it('a thrown network error that embeds the request URL is redacted', async () => {
    fetchImpl = async (url: string) => { throw new Error(`fetch failed for ${url}`); };
    const res = await testConnection('super-admin', PLATFORM_ROW.id, { scope: 'platform' });
    expect(res.body.status).toBe(0);
    expect(res.body.message).toContain('fetch failed');
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
  });

  it('a key pasted as a literal header value (legacy row) is redacted from an echo too', async () => {
    rows[0] = { ...PLATFORM_ROW, auth_type: 'none', api_key_env_name: null, headers: { 'X-Api-Key': FAKE_KEY } };
    fetchImpl = async () => ({ ok: false, status: 403, statusText: 'Forbidden', text: async () => `key ${FAKE_KEY} rejected` });
    const res = await testConnection('super-admin', PLATFORM_ROW.id, { scope: 'platform' });
    expect(res.body.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
  });
});

describe('per-user rate limit (shared limiter, reused)', () => {
  it('is keyed by the user id and answers 429 without testing when exhausted', async () => {
    rateLimitAllowed = false;
    const res = await testConnection('admin-a', OWN_ROW_A.id, { companyId: COMPANY_A });
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(rateLimitCalls).toEqual([{ id: 'admin-a', cfg: expect.objectContaining({ keyPrefix: 'rl:uid:external-api-test-connection' }) }]);
    expect(fetchCalls).toHaveLength(0);
    expect(healthWrites).toHaveLength(0);
  });
});
