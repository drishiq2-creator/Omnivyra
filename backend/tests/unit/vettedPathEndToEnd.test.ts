/**
 * VETTED PATH, end to end (owner ruling 2026-11-19, relayed by b3, PRE-LAUNCH).
 *
 * A company's identity is its WEBSITE domain (one live company per website domain); several companies may
 * share an ADMIN email domain. A person who cannot self-sign-up (free mail, or a corporate email whose
 * domain is not the website's) submits POST /api/access-request; a Super Admin approves it
 * (/api/admin/access-requests/approve), which opens the company through companyIdentityWriter; the
 * requester then onboards with the SAME, VERIFIED email and lands in THAT company - never a join request
 * to whichever company holds their email domain.
 *
 * REAL: /api/access-request, /api/admin/access-requests/approve, /api/onboarding/setup-company,
 * /api/onboarding/complete, approvedAccessRequestService, companyMatchService, companyIdentityWriter,
 * claimedDomainNotifyService - over the in-memory routeAuthHarness tables (the harness used by
 * setupCompanyNoDisclosure). FAKED (I/O only): the auth identity, the Super Admin capability gate and the
 * admin rate limiter (both recorded), rate limits, telemetry, email sends (recorded), credits, crawl.
 * Synthetic names only (.test domains; gmail.com is the free-mail provider class).
 */
import { seed, rows, invoke, uniqueKey, resolveUpsertConflicts, failTable, resetHarnessDeclarations } from '../helpers/routeAuthHarness';

const mockBeforeWrite: { fn: ((table: string, op: string, payload: unknown) => void) | null } = { fn: null };
function mockWrap(builder: Record<string, unknown>, table: string) {
  for (const op of ['update', 'delete', 'insert'] as const) {
    const orig = builder[op] as (p?: unknown, o?: unknown) => Record<string, unknown>;
    builder[op] = (p?: unknown, o?: unknown) => {
      if (mockBeforeWrite.fn) mockBeforeWrite.fn(table, op, p);
      return orig(p, o);
    };
  }
  return builder;
}

jest.mock('@/config', () => ({ config: { DEV_USER_ID: '', NODE_ENV: 'production' } }));
jest.mock('../../db/supabaseClient', () => {
  const m = require('../helpers/routeAuthHarness').supabaseModule();
  const fake = m.supabase;
  const wrapped = { ...fake, from: (t: string) => mockWrap(fake.from(t), t) };
  return { supabase: wrapped, default: wrapped, getSupabase: () => wrapped, supabaseAdmin: wrapped };
});
jest.mock('../../db/writeOwner', () => {
  const base = require('../helpers/routeAuthHarness').writeOwnerModule();
  return { ownedDbTable: (t: string) => mockWrap(base.ownedDbTable(t), t) };
});
jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: async (req: { headers?: Record<string, unknown> }) => {
    const id = req?.headers?.['x-test-user'];
    const email = req?.headers?.['x-test-email'] as string;
    if (typeof id !== 'string' || !id) return { user: null, error: 'MISSING_AUTH' };
    return { user: { id, email, emailVerified: req?.headers?.['x-test-unverified'] !== '1' }, error: null };
  },
}));
jest.mock('../../services/authResolver', () => ({
  resolveAuthenticatedUser: async (req: { headers?: Record<string, unknown> }) => {
    const id = req?.headers?.['x-test-user'];
    if (typeof id !== 'string' || !id) return { user: null, error: 'NO_TOKEN' };
    return { user: { id, supabaseUid: `sb-${id}`, email: req?.headers?.['x-test-email'] as string, emailVerified: true }, error: null };
  },
}));
/** The Super Admin gate of approve.ts (requireCapability): recorded, and switchable to a refusal. */
const mockCapability: { allow: boolean; calls: Array<Record<string, unknown>> } = { allow: true, calls: [] };
jest.mock('../../security/requireCapability', () => ({
  requireCapability: async (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }, opts: Record<string, unknown>) => {
    mockCapability.calls.push(opts);
    if (!mockCapability.allow) { res.status(403).json({ error: 'forbidden' }); return { ok: false }; }
    return { ok: true, principal: { userId: 'u-super' } };
  },
}));
const mockAdminRateLimitKeys: string[] = [];
jest.mock('../../services/requestAccessService', () => ({
  requireAdminRateLimit: async (_req: unknown, _res: unknown, key: string) => { mockAdminRateLimitKeys.push(key); return true; },
}));
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../lib/auth/rateLimit', () => ({
  checkRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: 0, bypassed: false }),
  ONBOARDING_COMPLETE_LIMIT: {}, ONBOARDING_UID_LIMIT: {},
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/signupEventService', () => ({
  emitSignupEvent: jest.fn(async () => undefined),
  ensureSignupCorrelationId: jest.fn(async () => 'corr-test'),
  requestIp: () => '127.0.0.1',
  requestUserAgent: () => 'jest',
}));
type Sent = { kind: 'referral' | 'admin_notice'; to: string };
const mockSent: Sent[] = [];
jest.mock('../../services/emailService', () => ({
  sendCompanyAdminReferral: async (to: string) => { mockSent.push({ kind: 'referral', to }); },
  sendInboundSignupNoticeToAdmin: async (to: string) => { mockSent.push({ kind: 'admin_notice', to }); },
}));
jest.mock('../../services/initialFreeCreditService', () => ({
  grantInitialFreeCredit: jest.fn(async () => ({ ok: true, granted: true, credits: 300, expiresAt: 'x' })),
  INITIAL_FREE_CREDIT_CATEGORY: 'initial_free_credit', INITIAL_FREE_CREDIT_DEFAULT: 300, INITIAL_FREE_CREDIT_EXPIRY_DAYS_DEFAULT: 30,
}));
jest.mock('../../services/earnCreditsService', () => ({ grantEarnCredit: jest.fn(async () => ({ ok: true })) }));
jest.mock('../../services/companyProfile/refinementHelpers', () => ({
  crawlWebsiteSources: jest.fn(async () => ({ social_links: [], metadata: null })),
  mergeDiscoveredSocialProfiles: jest.fn(() => ({})),
}));
jest.mock('../../services/companyMembershipIntegrityService', () => ({ SELF_REGISTERED_JOIN_SOURCE: 'self_registered', selectCompatibleCompanyRole: jest.fn(() => null) }));
jest.mock('../../services/companyIdentityDriftService', () => ({ monitorCompanyIdentityDrift: jest.fn(async () => undefined) }));
jest.mock('../../services/domainRecordService', () => ({ saveDomainRecord: jest.fn(async () => ({ ok: true })) }));
jest.mock('../../services/companyProfile/enrichmentProvenance', () => ({ buildDiscoveredProvenance: jest.fn(() => ({})) }));
jest.mock('../../services/companyBootstrapService', () => ({ bootstrapCompanyProfile: jest.fn(async () => ({})) }));
jest.mock('../../services/crawl/crawlEventService', () => ({ emitCrawlEvent: jest.fn(async () => undefined) }));
/** onboarding/complete's eligibility probe is I/O: free mail is PUBLIC_EMAIL, everything else eligible. */
jest.mock('../../services/domainEligibilityService', () => ({
  checkDomainEligibility: async (email: string) =>
    (/@gmail\.com$/i.test(email) ? { eligible: false, result: 'PUBLIC_EMAIL' } : { eligible: true, result: 'DOMAIN_ELIGIBLE' }),
}));
jest.mock('../../../lib/security/clientIp', () => ({ getTrustedClientIp: () => '127.0.0.1' }));

import accessRequestRoute from '../../../pages/api/access-request';
import approveRoute from '../../../pages/api/admin/access-requests/approve';
import setupCompanyRoute from '../../../pages/api/onboarding/setup-company';
import completeRoute from '../../../pages/api/onboarding/complete';

jest.setTimeout(120_000);

// ── Fixtures ──────────────────────────────────────────────────────────────────
const REQ = 'u-requester';
const S = '30930930-0000-4000-8000-0000000005a0';      // the company at shared.test (website shared.test)
const S_ADMIN_EMAIL = 'sam@shared.test';
const HOLDER = '30930930-0000-4000-8000-0000000005b0'; // a live company already holding beta.test

function world(requesterEmail: string, extra: { companies?: Record<string, unknown>[]; access_requests?: Record<string, unknown>[] } = {}) {
  seed({
    companies: [
      { id: S, name: 'Shared Co', status: 'active', website: 'https://shared.test', website_domain: 'shared.test', admin_email_domain: 'shared.test' },
      ...(extra.companies ?? []),
    ],
    users: [
      { id: REQ, email: requesterEmail, name: 'Requester Person', industry: null, status: 'active', active_company_id: null },
      { id: 'u-sadmin', email: S_ADMIN_EMAIL, name: 'Sam Sharedadmin', status: 'active' },
    ],
    user_company_roles: [{ id: 'r-sadmin', user_id: 'u-sadmin', company_id: S, role: 'COMPANY_ADMIN', status: 'active', created_at: '2026-01-01T00:00:00Z' }],
    invitations: [],
    signup_intents: [],
    signup_referrals: [],
    access_requests: [...(extra.access_requests ?? [])],
    audit_logs: [],
  });
  seededCompanyIds = new Set(rows('companies').map((c) => String(c.id)));
  for (const t of ['company_profiles', 'company_scheduler_prefs', 'company_setup_progress']) resolveUpsertConflicts(t, ['company_id']);
  for (const t of ['free_credit_profiles', 'users']) resolveUpsertConflicts(t, t === 'users' ? ['id'] : ['organization_id']);
}
let seededCompanyIds = new Set<string>();
const createdCompanies = () => rows('companies').filter((c) => !seededCompanyIds.has(String(c.id)));
const rolesOf = (userId: string) => rows('user_company_roles').filter((r) => r.user_id === userId);
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };

const submit = (body: Record<string, unknown>) => invoke(accessRequestRoute as never, { method: 'POST', body });
const approve = (requestId: string, extra: Record<string, unknown> = {}) =>
  invoke(approveRoute as never, { method: 'POST', body: { requestId, ...extra } });
const asRequester = (email: string, headers: Record<string, string> = {}) => ({ 'x-test-user': REQ, 'x-test-email': email, ...headers });
const setup = (email: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  invoke(setupCompanyRoute as never, { method: 'POST', body: { companyName: 'Typed Name Inc', ...body }, headers: asRequester(email, headers) });
const complete = (email: string) =>
  invoke(completeRoute as never, { method: 'POST', body: { fullName: 'Requester Person' }, headers: asRequester(email) });
/** The single request row for an email (the public route stores it lower-cased). */
const requestFor = (email: string) => {
  const found = rows('access_requests').filter((r) => r.email === email);
  expect(found).toHaveLength(1);
  return found[0];
};

beforeEach(() => {
  resetHarnessDeclarations();
  mockBeforeWrite.fn = null;
  mockSent.length = 0;
  mockCapability.allow = true;
  mockCapability.calls.length = 0;
  mockAdminRateLimitKeys.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

// ── (1) FREE-MAIL requester ───────────────────────────────────────────────────
describe('(1) a FREE-MAIL requester: submit -> Super Admin approves -> signs up with the same verified email -> lands in the vetted company', () => {
  it('end to end: the company is created through the writer with website_domain, the requester binds to it, no join request anywhere', async () => {
    world('fay@gmail.com');
    const sub = await submit({ email: ' Fay@Gmail.com ', name: 'Fay Person', company_name: 'Fay Studio', website: 'https://www.fay-studio.test/home', reason: 'freelance brand' });
    expect(sub.status).toBe(202);
    const req = requestFor('fay@gmail.com');
    expect(req).toEqual(expect.objectContaining({ status: 'pending', domain_status: 'PUBLIC_EMAIL', company_name: 'Fay Studio', website_url: 'https://fay-studio.test', use_case: 'freelance brand' }));

    const ap = await approve(String(req.id));
    expect(ap.status).toBe(200);
    expect(mockCapability.calls).toEqual([expect.objectContaining({ capability: 'identity.admin.assign' })]);
    expect(mockAdminRateLimitKeys).toEqual(['rl:admin:access-requests:approve']);
    const created = createdCompanies();
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual(expect.objectContaining({
      id: ap.body.companyId, name: 'Fay Studio', status: 'active',
      website: 'https://fay-studio.test', website_domain: 'fay-studio.test', admin_email_domain: null,
    }));
    expect(requestFor('fay@gmail.com')).toEqual(expect.objectContaining({ status: 'approved', organization_id: ap.body.companyId }));

    const r = await setup('fay@gmail.com');
    await settle();
    expect([r.status, r.body]).toEqual([200, { companyId: ap.body.companyId }]);
    expect(rolesOf(REQ)).toEqual([expect.objectContaining({ company_id: ap.body.companyId, role: 'COMPANY_ADMIN', status: 'active', join_source: 'invited' })]);
    expect(createdCompanies()).toHaveLength(1);
    expect(mockSent).toEqual([]);
    expect(rows('signup_referrals')).toEqual([]);

    const c = await complete('fay@gmail.com');
    expect([c.status, c.body]).toEqual([200, { success: true, inviteOnly: true, companyId: ap.body.companyId }]);
  });

  it('CONTROL: the same free-mail person WITHOUT an approval is refused, routed to the vetted path, and nothing is created', async () => {
    world('fay@gmail.com');
    await submit({ email: 'fay@gmail.com', name: 'Fay Person', company_name: 'Fay Studio' }); // pending, never approved
    const r = await setup('fay@gmail.com');
    expect([r.status, r.body]).toEqual([403, { code: 'INVITE_REQUIRED', error: expect.any(String), next: 'access_request' }]);
    const c = await complete('fay@gmail.com');
    expect([c.status, c.body]).toEqual([403, { code: 'INVITE_REQUIRED', error: expect.any(String), next: 'access_request' }]);
    expect(createdCompanies()).toEqual([]);
    expect(rolesOf(REQ)).toEqual([]);
  });

  it('CONTROL: only the VERIFIED session email binds - a typed email naming the approved one binds nothing; an unverified session is refused first', async () => {
    world('mallory@gmail.com');
    await submit({ email: 'fay@gmail.com', name: 'Fay Person', company_name: 'Fay Studio' });
    const ap = await approve(String(requestFor('fay@gmail.com').id));
    expect(ap.status).toBe(200);
    const typed = await setup('mallory@gmail.com', { email: 'fay@gmail.com', userEmail: 'fay@gmail.com' });
    expect([typed.status, typed.body.code]).toEqual([403, 'INVITE_REQUIRED']);
    const unverified = await setup('fay@gmail.com', {}, { 'x-test-unverified': '1' });
    expect([unverified.status, unverified.body.code]).toEqual([403, 'EMAIL_NOT_VERIFIED']);
    expect(rolesOf(REQ)).toEqual([]);
  });
});

// ── (2) MISMATCHED CORPORATE requester ───────────────────────────────────────
describe('(2) a MISMATCHED CORPORATE requester (a@shared.test, approved for the company at beta.test)', () => {
  const vet = async () => {
    const sub = await submit({ email: 'a@shared.test', name: 'A Person', company_name: 'Beta Labs', website: 'beta.test' });
    expect(sub.status).toBe(202);
    expect(requestFor('a@shared.test').domain_status).toBe('DOMAIN_MISMATCH');
    const ap = await approve(String(requestFor('a@shared.test').id));
    expect(ap.status).toBe(200);
    return String(ap.body.companyId);
  };

  it("end to end: setup-company binds them to beta.test's company - NOT a join request to shared.test's company", async () => {
    world('a@shared.test');
    const B = await vet();
    expect(createdCompanies()).toEqual([expect.objectContaining({
      id: B, name: 'Beta Labs', website: 'https://beta.test', website_domain: 'beta.test', admin_email_domain: 'shared.test',
    })]);
    const r = await setup('a@shared.test');
    await settle();
    expect([r.status, r.body]).toEqual([200, { companyId: B }]);
    expect(rolesOf(REQ)).toEqual([expect.objectContaining({ company_id: B, role: 'COMPANY_ADMIN', status: 'active', join_source: 'invited' })]);
    expect(mockSent).toEqual([]);                      // S's admin is never told this person wants into S
    expect(rows('signup_referrals')).toEqual([]);
    expect(rows('users').find((u) => u.id === REQ)?.active_company_id).toBe(B);
  });

  it("end to end: onboarding/complete answers beta.test's company - NOT a join request to shared.test's company", async () => {
    world('a@shared.test');
    const B = await vet();
    const c = await complete('a@shared.test');
    await settle();
    expect([c.status, c.body]).toEqual([200, { success: true, inviteOnly: true, companyId: B }]);
    expect(mockSent).toEqual([]);
    expect(rows('signup_referrals')).toEqual([]);
  });

  it("CONTROL: without the approval, the same person gets the join request to shared.test's company on both surfaces", async () => {
    world('a@shared.test');
    const r = await setup('a@shared.test');
    await settle();
    expect([r.status, r.body.joinRequested]).toEqual([200, true]);
    const c = await complete('a@shared.test');
    await settle();
    expect([c.status, c.body.joinRequested]).toEqual([403, true]);
    expect(mockSent.filter((m) => m.to === S_ADMIN_EMAIL).map((m) => m.kind)).toContain('admin_notice');
    expect(rolesOf(REQ)).toEqual([]);
  });

  it('an approved request WITHOUT organization_id is treated as absent (domain matching as usual)', async () => {
    world('a@shared.test', { access_requests: [{ id: 'ar-noorg', email: 'a@shared.test', status: 'approved', organization_id: null, domain: 'shared.test' }] });
    const r = await setup('a@shared.test');
    await settle();
    expect([r.status, r.body.joinRequested]).toEqual([200, true]);
    expect(rolesOf(REQ)).toEqual([]);
  });

  it('a failed approval read refuses (503) on both surfaces - never falls through to a join request to shared.test', async () => {
    world('a@shared.test');
    failTable('access_requests', 'select');
    const r = await setup('a@shared.test');
    const c = await complete('a@shared.test');
    await settle();
    expect([r.status, c.status]).toEqual([503, 503]);
    expect(mockSent).toEqual([]);
    expect(rows('signup_referrals')).toEqual([]);
    expect(rolesOf(REQ)).toEqual([]);
  });
});

// ── (3) approving a website a live company already holds ─────────────────────
describe('(3) approving a website already held by a live company -> 409, nothing written', () => {
  const holder = (over: Record<string, unknown> = {}) => ({ id: HOLDER, name: 'Beta Holder', status: 'active', website: 'https://www.beta.test', website_domain: 'beta.test', admin_email_domain: 'beta.test', ...over });
  const pending = { id: 'ar-beta', email: 'zed@gmail.com', name: 'Zed', company_name: 'Zed Beta', website_url: 'https://shop.beta.test', domain: 'gmail.com', domain_status: 'PUBLIC_EMAIL', status: 'pending', organization_id: null };

  it('a live holder of the website domain -> 409 COMPANY_WEBSITE_TAKEN; no company, the request untouched', async () => {
    world('zed@gmail.com', { companies: [holder()], access_requests: [pending] });
    const ap = await approve('ar-beta');
    expect([ap.status, ap.body]).toEqual([409, { code: 'COMPANY_WEBSITE_TAKEN', error: expect.any(String) }]);
    expect(createdCompanies()).toEqual([]);
    expect(rows('access_requests')).toEqual([expect.objectContaining({ id: 'ar-beta', status: 'pending', organization_id: null })]);
  });

  it('CONTROL: a SOFT-DELETED holder does not hold it - the company is created', async () => {
    world('zed@gmail.com', { companies: [holder({ deleted_at: '2026-10-01T00:00:00Z' })], access_requests: [pending] });
    const ap = await approve('ar-beta');
    expect(ap.status).toBe(200);
    expect(createdCompanies()).toEqual([expect.objectContaining({ website: 'https://shop.beta.test', website_domain: 'beta.test', admin_email_domain: null })]);
  });

  it('a CONCURRENT create that wins idx_companies_website_domain_unique (23505) -> the same 409, the request untouched', async () => {
    world('zed@gmail.com', { access_requests: [pending] });
    uniqueKey('companies', 'website_domain');
    let raced = false;
    mockBeforeWrite.fn = (table, op) => {
      if (table !== 'companies' || op !== 'insert' || raced) return;
      raced = true;
      rows('companies').push(holder());
    };
    const ap = await approve('ar-beta');
    expect(raced).toBe(true);
    expect([ap.status, ap.body]).toEqual([409, { code: 'COMPANY_WEBSITE_TAKEN', error: expect.any(String) }]);
    expect(createdCompanies().map((c) => c.id)).toEqual([HOLDER]); // only the concurrent winner
    expect(rows('access_requests')).toEqual([expect.objectContaining({ id: 'ar-beta', status: 'pending', organization_id: null })]);
  });

  it('an unusable website -> 422 COMPANY_WEBSITE_INVALID; a public-suffix website -> 409 COMPANY_WEBSITE_AMBIGUOUS; nothing written', async () => {
    world('zed@gmail.com', { access_requests: [{ ...pending, website_url: 'http://localhost:3000' }] });
    const bad = await approve('ar-beta');
    world('zed@gmail.com', { access_requests: [{ ...pending, website_url: 'https://co.uk' }] });
    const psl = await approve('ar-beta');
    expect([bad.status, bad.body.code, psl.status, psl.body.code]).toEqual([422, 'COMPANY_WEBSITE_INVALID', 409, 'COMPANY_WEBSITE_AMBIGUOUS']);
    expect(createdCompanies()).toEqual([]);
    expect(rows('access_requests')[0]).toEqual(expect.objectContaining({ status: 'pending' }));
  });

  it('a refused capability writes nothing (the IDENTITY_ADMIN_ASSIGN gate stays in front)', async () => {
    world('zed@gmail.com', { access_requests: [pending] });
    mockCapability.allow = false;
    const ap = await approve('ar-beta');
    expect(ap.status).toBe(403);
    expect(createdCompanies()).toEqual([]);
    expect(rows('access_requests')[0]).toEqual(expect.objectContaining({ status: 'pending' }));
  });
});

// ── G5: onboarding/complete founder insert race ───────────────────────────────
describe('G5: a 23505 on the founder insert (idx_companies_website_domain_unique) is the race path, never a generic 500', () => {
  const W = '30930930-0000-4000-8000-0000000005c0';
  const winner = (over: Record<string, unknown> = {}) => ({ id: W, name: 'Race Winner', status: 'active', website: 'https://race.test', website_domain: 'race.test', admin_email_domain: 'race.test', ...over });
  const raceWith = (...pushRows: Array<Record<string, unknown>>) => {
    uniqueKey('companies', 'website_domain');
    let raced = false;
    mockBeforeWrite.fn = (table, op) => {
      if (table !== 'companies' || op !== 'insert' || raced) return;
      raced = true;
      rows('companies').push(...pushRows);
    };
    return () => raced;
  };

  it('a live winner -> the neutral join request to the WINNER (403 INVITE_REQUIRED joinRequested), nothing bound', async () => {
    world('rita@race.test');
    const raced = raceWith(winner());
    const c = await complete('rita@race.test');
    await settle();
    expect(raced()).toBe(true);
    expect([c.status, c.body]).toEqual([403, { code: 'INVITE_REQUIRED', joinRequested: true, error: expect.stringMatching(/sent to your organization's administrator/) }]);
    expect(rolesOf(REQ)).toEqual([]);
    expect(rows('signup_referrals').map((r) => r.company_id)).toEqual([W]);
  });

  it('several live companies after the race -> 409 COMPANY_DOMAIN_AMBIGUOUS', async () => {
    world('rita@race.test');
    raceWith(winner(), winner({ id: `${W.slice(0, -1)}1`, website_domain: 'shop.race.test' }));
    const c = await complete('rita@race.test');
    expect([c.status, c.body.code]).toEqual([409, 'COMPANY_DOMAIN_AMBIGUOUS']);
    expect(rolesOf(REQ)).toEqual([]);
  });

  it('no LIVE winner (a soft-deleted row holds the key) -> 409 COMPANY_DOMAIN_UNAVAILABLE with the vetted-path pointer', async () => {
    world('rita@race.test');
    raceWith(winner({ deleted_at: '2026-10-01T00:00:00Z' }));
    const c = await complete('rita@race.test');
    expect([c.status, c.body]).toEqual([409, { code: 'COMPANY_DOMAIN_UNAVAILABLE', error: expect.any(String), next: 'access_request' }]);
    expect(JSON.stringify(c.body)).not.toMatch(/duplicate|unique|constraint|idx_|23505|race\.test/i);
    expect(rolesOf(REQ)).toEqual([]);
  });

  it('CONTROL: a non-23505 insert failure is still the generic 500', async () => {
    world('rita@race.test');
    failTable('companies', 'insert');
    const c = await complete('rita@race.test');
    expect([c.status, c.body]).toEqual([500, { error: 'Could not create company' }]);
  });
});

// ── G2 guards: the binding itself fails closed ────────────────────────────────
describe('G2: the approved binding fails closed and keeps the existing approval semantics', () => {
  const approvedFor = (email: string, orgId: string) => ({ id: `ar-${email}`, email, status: 'approved', organization_id: orgId, domain: email.split('@')[1] });
  const VETTED = '30930930-0000-4000-8000-0000000005d0';
  const vettedCo = { id: VETTED, name: 'Vetted Co', status: 'active', website: null, website_domain: null, admin_email_domain: null };

  it('a failed membership INSERT is a 500 (never a 200 with no membership)', async () => {
    world('a@shared.test', { companies: [vettedCo], access_requests: [approvedFor('a@shared.test', VETTED)] });
    failTable('user_company_roles', 'insert');
    const r = await setup('a@shared.test');
    expect([r.status, r.body]).toEqual([500, { error: 'Something went wrong. Please try again.' }]);
    expect(rows('users').find((u) => u.id === REQ)?.active_company_id ?? null).toBeNull();
  });

  it('a failed membership READ is a 503, nothing written', async () => {
    world('a@shared.test', { companies: [vettedCo], access_requests: [approvedFor('a@shared.test', VETTED)] });
    failTable('user_company_roles', 'select');
    const r = await setup('a@shared.test');
    expect(r.status).toBe(503);
    expect(rolesOf(REQ)).toEqual([]);
  });

  it('an existing membership of the approved company is left as it is (idempotent, role not widened)', async () => {
    world('a@shared.test', { companies: [vettedCo], access_requests: [approvedFor('a@shared.test', VETTED)] });
    rows('user_company_roles').push({ id: 'r-pre', user_id: REQ, company_id: VETTED, role: 'CONTENT_CREATOR', status: 'active' });
    const r = await setup('a@shared.test');
    expect([r.status, r.body]).toEqual([200, { companyId: VETTED }]);
    expect(rolesOf(REQ)).toEqual([expect.objectContaining({ id: 'r-pre', role: 'CONTENT_CREATOR' })]);
  });

  it('complete: free mail the eligibility probe did NOT classify PUBLIC_EMAIL is still bound by its approval', async () => {
    world('yan@yahoo.com', { companies: [vettedCo], access_requests: [approvedFor('yan@yahoo.com', VETTED)] });
    const c = await complete('yan@yahoo.com');
    expect([c.status, c.body]).toEqual([200, { success: true, inviteOnly: true, companyId: VETTED }]);
  });

  it('CONTROL: the same unclassified free mail without an approval is refused toward the vetted path', async () => {
    world('yan@yahoo.com');
    const c = await complete('yan@yahoo.com');
    expect([c.status, c.body]).toEqual([403, { code: 'INVITE_REQUIRED', error: expect.any(String), next: 'access_request' }]);
  });
});

describe('G2: legacy data - an approved row without organization_id never hides a usable one', () => {
  it('two approved rows, the first without organization_id: the one WITH it binds', async () => {
    const VETTED = '30930930-0000-4000-8000-0000000005e0';
    world('a@shared.test', {
      companies: [{ id: VETTED, name: 'Vetted Co', status: 'active', website: null, website_domain: null, admin_email_domain: null }],
      access_requests: [
        { id: 'ar-1', email: 'a@shared.test', status: 'approved', organization_id: null, domain: 'shared.test' },
        { id: 'ar-2', email: 'a@shared.test', status: 'approved', organization_id: VETTED, domain: 'shared.test' },
      ],
    });
    const r = await setup('a@shared.test');
    await settle();
    expect([r.status, r.body]).toEqual([200, { companyId: VETTED }]);
    expect(mockSent).toEqual([]);
  });
});
