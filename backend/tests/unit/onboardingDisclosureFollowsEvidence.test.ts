/**
 * e1 (2026-11-12, 05 breadth check) - setup-company disclosed matchedCompanyId, matchedCompanyName and
 * the admin's name (falling back to the admin's EMAIL local-part) on ANY match, including a name-only
 * or typed-website match, and emailed the matched company's admin on every such probe.
 * CI-309 re-derivation (2026-11-19, owner + coordinator ruling): a name / typed website is no longer a
 * match at all, and even a VERIFIED email-domain match discloses nothing - the requester gets the same
 * neutral join-request notice whatever the admin-notice outcome, the admin is notified after the
 * response, and the requester is never sent the admin's contact (notifyProspect: false).
 * Harness: closure015m's routeAuthHarness wiring (real setup-company over in-memory tables).
 */
import { seed, calls, invoke } from '../helpers/routeAuthHarness';

const mockSecurityAudit: Record<string, unknown>[] = [];
const mockFail = new Set<string>();
const mockBeforeWrite: { fn: ((table: string, op: string) => void) | null } = { fn: null };
/** supabase.rpc model (null → harness default). */
const mockRpc: { fn: ((fn: string, args: unknown) => unknown) | null } = { fn: null };
function mockFailing(): Record<string, unknown> {
  const failing: Record<string, unknown> = {};
  const chain = () => failing;
  for (const m of ['eq', 'neq', 'in', 'is', 'select', 'limit', 'order', 'not', 'maybeSingle', 'single']) failing[m] = chain;
  failing.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, count: null, error: { message: 'forced failure' } }).then(ok);
  failing.maybeSingle = async () => ({ data: null, error: { message: 'forced failure' } });
  failing.single = async () => ({ data: null, error: { message: 'forced failure' } });
  return failing;
}
function mockWrap(builder: Record<string, unknown>, table: string) {
  const origSelect = builder.select as (cols?: string, opts?: unknown) => Record<string, unknown>;
  builder.select = (cols?: string, opts?: unknown) => (mockFail.has(`${table}:select:${cols}`) ? mockFailing() : origSelect(cols, opts));
  for (const op of ['update', 'delete', 'insert'] as const) {
    const orig = builder[op] as (p?: unknown) => Record<string, unknown>;
    builder[op] = (p?: unknown) => {
      if (mockBeforeWrite.fn) mockBeforeWrite.fn(table, op);
      return mockFail.has(`${table}:${op}`) ? mockFailing() : orig(p);
    };
  }
  return builder;
}

jest.mock('@/config', () => ({ config: { DEV_USER_ID: '', NODE_ENV: 'production' } }));
jest.mock('../../db/supabaseClient', () => {
  const m = require('../helpers/routeAuthHarness').supabaseModule();
  const fake = m.supabase;
  const rpc = (fn: string, args?: unknown) => (mockRpc.fn ? Promise.resolve(mockRpc.fn(fn, args)) : fake.rpc(fn, args));
  const wrapped = { ...fake, rpc, from: (t: string) => mockWrap(fake.from(t), t) };
  return { supabase: wrapped, default: wrapped, getSupabase: () => wrapped, supabaseAdmin: wrapped };
});
jest.mock('../../db/writeOwner', () => {
  const base = require('../helpers/routeAuthHarness').writeOwnerModule();
  return { ownedDbTable: (t: string) => mockWrap(base.ownedDbTable(t), t) };
});
const ident = (req: { headers?: Record<string, unknown> }) => {
  const id = req?.headers?.['x-test-user'];
  const email = (req?.headers?.['x-test-email'] as string | undefined) ?? `${String(id)}@example.test`;
  return typeof id === 'string' && id ? { id, email } : null;
};
jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: async (req: { headers?: Record<string, unknown> }) => {
    const u = ident(req);
    return u ? { user: { id: u.id, email: u.email, emailVerified: true }, error: null } : { user: null, error: 'MISSING_AUTH' };
  },
}));
jest.mock('../../services/authResolver', () => ({
  resolveAuthenticatedUser: async (req: { headers?: Record<string, unknown> }) => {
    const u = ident(req);
    return u ? { user: { id: u.id, supabaseUid: `sb-${u.id}`, email: u.email, emailVerified: true }, error: null } : { user: null, error: 'NO_TOKEN' };
  },
  extractAccessToken: () => 'tok',
}));
jest.mock('../../security/SessionAuthorityService', () => ({
  resolveSessionFromRequest: async (req: { headers?: Record<string, unknown> }) => {
    const u = ident(req);
    if (!u) return { ok: false, reason: 'NO_SESSION' };
    const now = new Date().toISOString();
    return { ok: true, session: { id: `sess-${u.id}`, user_id: u.id, created_at: now, last_seen_at: now } };
  },
  touchSession: async () => undefined,
}));
jest.mock('../../security/legacyCookieSuperAdminBridge', () => ({ resolveLegacyCookieSuperAdminPrincipal: async () => null }));
jest.mock('../../security/audit/SecurityAuditService', () => ({
  logSecurityEvent: async (e: Record<string, unknown>) => { mockSecurityAudit.push(e); },
  snapshotFromPrincipal: () => ({}),
}));
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../services/userColumnProjection', () => ({ tolerantUserSelect: jest.fn() }));
jest.mock('../../services/requestAccessService', () => ({ requireAdminRateLimit: async () => true }));
jest.mock('../../../lib/auth/rateLimit', () => ({ checkRateLimit: async () => ({ allowed: true }) }));
jest.mock('../../../lib/auth/auditLog', () => ({ logAuthEvent: jest.fn(async () => undefined) }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/signupEventService', () => ({
  emitSignupEvent: jest.fn(async () => undefined),
  ensureSignupCorrelationId: jest.fn(async () => 'corr-test'),
  requestIp: () => '127.0.0.1',
  requestUserAgent: () => 'jest',
}));
let mockCanonical = '';
jest.mock('../../services/validatedWebsiteService', () => ({
  deriveWebsiteFromEmail: () => '',
  resolveValidatedWebsite: async () => ({ canonicalWebsite: mockCanonical }),
}));
jest.mock('../../services/initialFreeCreditService', () => ({ grantInitialFreeCredit: jest.fn(async () => ({ ok: true })) }));
jest.mock('../../services/earnCreditsService', () => ({ grantEarnCredit: jest.fn(async () => ({ ok: true })) }));
jest.mock('../../services/companyProfile/refinementHelpers', () => ({ crawlWebsiteSources: jest.fn(async () => ({})), mergeDiscoveredSocialProfiles: jest.fn(() => ({})) }));
jest.mock('../../services/companyMembershipIntegrityService', () => ({ SELF_REGISTERED_JOIN_SOURCE: 'self_registered', selectCompatibleCompanyRole: jest.fn(() => null) }));
const mockNotified: unknown[] = [];
let mockAdminNotice = 'sent';
jest.mock('../../services/claimedDomainNotifyService', () => ({
  notifyAdminAndProspectOfClaimedDomain: jest.fn(async (_db: unknown, input: unknown) => { mockNotified.push(input); return { adminNotice: mockAdminNotice }; }),
}));
jest.mock('../../services/companyIdentityDriftService', () => ({ monitorCompanyIdentityDrift: jest.fn(async () => undefined) }));
jest.mock('../../services/companyIdentityWriter', () => ({ createCompanyIdentity: jest.fn(async () => ({ id: 'never' })) }));
jest.mock('../../services/domainRecordService', () => ({ saveDomainRecord: jest.fn(async () => ({ ok: true })) }));
jest.mock('../../services/companyProfile/enrichmentProvenance', () => ({ buildDiscoveredProvenance: jest.fn(() => ({})) }));
jest.mock('../../services/companyBootstrapService', () => ({ bootstrapCompanyProfile: jest.fn(async () => ({})) }));
jest.mock('../../services/crawl/crawlEventService', () => ({ emitCrawlEvent: jest.fn(async () => undefined) }));
const mockCascadeDisable = jest.fn(async (companyId: string) => {
  const h = require('../helpers/routeAuthHarness');
  for (const c of h.rows('companies')) if (c.id === companyId) c.status = 'inactive';
  for (const m of h.rows('user_company_roles')) if (m.company_id === companyId && m.status === 'active') m.status = 'inactive';
  return { affectedUsers: 0, revokedRoles: 0, revokedSessions: 0 };
});
jest.mock('../../services/lifecycleGovernance', () => ({
  cascadeDisableCompany: (...a: unknown[]) => mockCascadeDisable(...(a as [string])),
  softDeleteCompanyWithCascade: jest.fn(),
  hardDeleteCompany: jest.fn(async () => ({ ok: false, code: 'FUNCTION_MISSING' })),
}));
import setupCompanyRoute from '../../../pages/api/onboarding/setup-company';

const CO_W = '15151515-0000-4000-8000-0000000000c2';   // acme.test
const OTHER = '15151515-0000-4000-8000-0000000000c3';  // other.test (website only)
const U = 'u-prospect';
const WORK = 'prospect@acme.test';
const ADMIN = 'u-admin';
function world(adminName: string | null = 'Ada Admin') {
  seed({
    companies: [
      { id: CO_W, name: 'Acme', status: 'active', admin_email_domain: 'acme.test' },
      { id: OTHER, name: 'Other Co', status: 'active', website_domain: 'other.test' },
    ],
    users: [
      { id: U, email: WORK, name: 'Prospect', industry: null, status: 'active', active_company_id: null },
      { id: ADMIN, email: 'ada@acme.test', name: adminName, status: 'active' },
    ],
    user_company_roles: [{ id: 'r-admin', user_id: ADMIN, company_id: CO_W, role: 'COMPANY_ADMIN', status: 'active' }],
    invitations: [],
    audit_logs: [],
    api_idempotency_keys: [],
  });
}
const setup = (body: Record<string, unknown> = {}) =>
  invoke(setupCompanyRoute as never, { method: 'POST', body: { companyName: 'Acme', ...body }, headers: { 'x-test-user': U, 'x-test-email': WORK } });
const membershipWrites = () => calls().filter((c) => c.table === 'user_company_roles' && ['update', 'insert', 'delete'].includes(c.op));
const leaks = (body: unknown) => {
  const s = JSON.stringify(body);
  return ['Acme', CO_W, 'Ada', 'ada@', 'Other Co', OTHER].filter((x) => s.includes(x));
};

beforeEach(() => {
  mockSecurityAudit.length = 0; mockFail.clear(); mockBeforeWrite.fn = null; mockRpc.fn = null;
  mockNotified.length = 0; mockAdminNotice = 'sent'; mockCanonical = '';
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

/** Let after-response work (the admin notice) run. */
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const NEUTRAL = { companyExists: true, joinRequested: true, message: expect.stringMatching(/administrator/i) };

describe('a name / typed website is not a match', () => {
  it("a name naming ANOTHER company is ignored: only the requester's own verified domain counts, nothing about the named company leaks", async () => {
    world();
    const r = await setup({ companyName: 'Other Co' });
    await settle();
    expect(r.status).toBe(200);
    expect(r.body).toEqual(NEUTRAL);
    expect(leaks(r.body)).toEqual([]);
    expect(mockNotified).toHaveLength(1);
    expect(mockNotified[0]).toMatchObject({ companyId: CO_W, notifyProspect: false });
    expect(membershipWrites()).toEqual([]);
  });

  it("a TYPED website naming another company is never bound: that company is neither disclosed nor notified", async () => {
    world();
    mockCanonical = 'https://other.test';
    const r = await setup({ companyName: 'Brand New', website: 'https://other.test' });
    await settle();
    expect(r.status).toBe(200);
    expect(r.body).toEqual(NEUTRAL);
    expect(leaks(r.body)).toEqual([]);
    expect(mockNotified.map((n) => (n as { companyId: string }).companyId)).toEqual([CO_W]);
  });
});

describe('verified email-domain match (domain-first lookup)', () => {
  it('names nothing (no company id/name, no admin name/email): the neutral notice only; the admin is notified, the prospect is not', async () => {
    world();
    const r = await setup({ companyName: 'Brand New' });
    await settle();
    expect(r.status).toBe(200);
    expect(r.body).toEqual(NEUTRAL);
    expect(leaks(r.body)).toEqual([]);
    expect(mockNotified).toEqual([expect.objectContaining({ companyId: CO_W, prospectEmail: WORK, notifyProspect: false })]);
    expect(membershipWrites()).toEqual([]);
  });

  it('the reply is identical whatever happened to the admin notice (sent / failed / no_admin)', async () => {
    const bodies: unknown[] = [];
    for (const outcome of ['sent', 'failed', 'no_admin']) {
      world();
      mockAdminNotice = outcome;
      const r = await setup();
      await settle();
      bodies.push([r.status, r.body]);
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it("an admin with no display name changes nothing - never the email's local-part", async () => {
    world(null);
    const r = await setup();
    expect(r.body).toEqual(NEUTRAL);
    expect(JSON.stringify(r.body)).not.toContain('ada');
  });
});
