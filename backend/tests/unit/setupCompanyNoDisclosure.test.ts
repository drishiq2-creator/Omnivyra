/**
 * LIVE-CRITICAL (CI-231 + CI-309 re-derived on main, 2026-11-19): POST /api/onboarding/setup-company
 * disclosed ANOTHER company to anyone with a verified non-free email. Naming a victim company (or its
 * website) matched it by name/website and the response carried matchedCompanyId, matchedCompanyName
 * and adminName, while the claimed-domain notice EMAILED the requester the victim admin's contact.
 *
 * Ruling (coordinator b3 + owner):
 *   - a company is matched ONLY by the requester's verified email domain, compared by registrable
 *     domain through lib/shared/domain/companyDomain (normalizeCompanyDomain / isSameCompanyDomain);
 *     a name or website guess never matches and reveals nothing (oracle: identical to a non-match);
 *   - same verified domain -> an admin-approved JOIN REQUEST: the requester sees only a neutral message,
 *     the company's admins get the notice; the requester never gets admin contact details;
 *   - several companies on that domain -> 409 COMPANY_DOMAIN_AMBIGUOUS, nothing revealed;
 *   - the admin notice is sent AFTER the response: a slow or failing sender never changes the reply.
 *
 * REAL: setup-company, companyMatchService, claimedDomainNotifyService, companyIdentityWriter,
 * validatedWebsiteService (unless a test pins the website source), keepAlive - over the in-memory
 * routeAuthHarness tables. FAKED (I/O only): auth identity, rate limits, telemetry, the two email
 * sends (recorded with recipient + payload), credits, crawl / bootstrap.
 */
import { seed, rows, calls, invoke, uniqueKey, resolveUpsertConflicts, failTable } from '../helpers/routeAuthHarness';

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
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// /api/onboarding/company-domain-check authenticates through authResolver (same test identity headers).
jest.mock('../../services/authResolver', () => ({
  resolveAuthenticatedUser: async (req: { headers?: Record<string, unknown> }) => {
    const id = req?.headers?.['x-test-user'];
    if (typeof id !== 'string' || !id) return { user: null, error: 'NO_TOKEN' };
    return { user: { id, supabaseUid: `sb-${id}`, email: req?.headers?.['x-test-email'] as string, emailVerified: true }, error: null };
  },
}));
jest.mock('../../../lib/auth/rateLimit', () => ({ checkRateLimit: async () => ({ allowed: true }) }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/signupEventService', () => ({
  emitSignupEvent: jest.fn(async () => undefined),
  ensureSignupCorrelationId: jest.fn(async () => 'corr-test'),
  requestIp: () => '127.0.0.1',
  requestUserAgent: () => 'jest',
}));
/** null = the REAL resolver; a string pins resolveValidatedWebsite's answer (e.g. the user_input source). */
let mockPinnedWebsite: string | null = null;
/** true = deriveWebsiteFromEmail answers null (models a corporate email with no derivable website). */
let mockNoDerivedWebsite = false;
jest.mock('../../services/validatedWebsiteService', () => {
  const actual = jest.requireActual('../../services/validatedWebsiteService');
  return {
    ...actual,
    deriveWebsiteFromEmail: (...a: unknown[]) => (mockNoDerivedWebsite ? null : actual.deriveWebsiteFromEmail(...a)),
    resolveValidatedWebsite: async (...a: unknown[]) =>
      mockPinnedWebsite !== null ? { canonicalWebsite: mockPinnedWebsite, source: 'user_input' } : actual.resolveValidatedWebsite(...a),
  };
});
type Sent = { kind: 'referral' | 'admin_notice'; to: string; payload: unknown };
const mockSent: Sent[] = [];
const mockSender: { mode: 'ok' | 'reject' | 'hang' } = { mode: 'ok' };
const mockSend = (kind: Sent['kind']) => async (to: string, payload: unknown) => {
  mockSent.push({ kind, to, payload });
  if (mockSender.mode === 'reject') throw new Error('TRANSACTIONAL_EMAIL_FAILED:test');
  if (mockSender.mode === 'hang') await new Promise(() => undefined);
};
jest.mock('../../services/emailService', () => ({
  sendCompanyAdminReferral: (to: string, p: unknown) => mockSend('referral')(to, p),
  sendInboundSignupNoticeToAdmin: (to: string, p: unknown) => mockSend('admin_notice')(to, p),
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
// /api/onboarding/complete (third surface of the agreement test): its eligibility probe and client-IP read are I/O.
jest.mock('../../services/domainEligibilityService', () => ({ checkDomainEligibility: async () => ({ eligible: true, result: 'ELIGIBLE' }) }));
jest.mock('../../../lib/security/clientIp', () => ({ getTrustedClientIp: () => '127.0.0.1' }));

import setupCompanyRoute from '../../../pages/api/onboarding/setup-company';
import { emitSignupEvent } from '../../services/signupEventService';
import domainCheckRoute from '../../../pages/api/onboarding/company-domain-check';
import completeRoute from '../../../pages/api/onboarding/complete';

// The first company-creation run loads the creation tail's lazy imports (cold ts-jest transpile).
jest.setTimeout(120_000);

// ── Fixtures ──────────────────────────────────────────────────────────────────
const VICTIM = '30930930-0000-4000-8000-00000000000a';
const VICTIM_NAME = 'Victim Corp';
const VADMIN = 'u-vadmin';
const VADMIN_EMAIL = 'vera@victim.test';
const VADMIN_NAME = 'Vera Victimadmin';
const REQ = 'u-requester';
/** Everything about the victim that must never reach the requester. */
const VICTIM_SECRETS = [VICTIM, VICTIM_NAME, VADMIN, VADMIN_EMAIL, VADMIN_NAME, 'Vera'];

function world(extra: { companies?: Record<string, unknown>[]; users?: Record<string, unknown>[]; roles?: Record<string, unknown>[] } = {}, requesterEmail = 'mallory@attacker.test') {
  seed({
    companies: [
      { id: VICTIM, name: VICTIM_NAME, status: 'active', website: 'https://www.victim.test', website_domain: 'victim.test', admin_email_domain: 'victim.test' },
      ...(extra.companies ?? []),
    ],
    users: [
      { id: REQ, email: requesterEmail, name: 'Requester Person', industry: null, status: 'active', active_company_id: null },
      { id: VADMIN, email: VADMIN_EMAIL, name: VADMIN_NAME, status: 'active' },
      ...(extra.users ?? []),
    ],
    user_company_roles: [
      { id: 'r-vadmin', user_id: VADMIN, company_id: VICTIM, role: 'COMPANY_ADMIN', status: 'active', created_at: '2026-01-01T00:00:00Z' },
      ...(extra.roles ?? []),
    ],
    invitations: [],
    signup_intents: [],
    signup_referrals: [],
    access_requests: [],
    audit_logs: [],
  });
  seededCompanyIds = new Set(rows('companies').map((c) => String(c.id)));
  for (const t of ['company_profiles', 'company_scheduler_prefs', 'company_setup_progress']) resolveUpsertConflicts(t, ['company_id']);
}
const setup = (email: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  invoke(setupCompanyRoute as never, {
    method: 'POST',
    body: { companyName: 'Some New Company', ...body },
    headers: { 'x-test-user': REQ, 'x-test-email': email, ...headers },
  });
/** Let after-response work (the admin notice) run to completion. */
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
/** The server-side signup audit events (capability_audit_log via emitSignupEvent -> logSecurityEvent). */
const companyExistsEvents = () =>
  (emitSignupEvent as jest.Mock).mock.calls.map((c) => c[0]).filter((e: { event: string }) => e.event === 'CompanyExists');
const leaked = (x: unknown) => { const s = JSON.stringify(x ?? null); return VICTIM_SECRETS.filter((v) => s.includes(v)); };
const sentTo = (to: string) => mockSent.filter((m) => m.to.toLowerCase() === to.toLowerCase());
const referralsFor = (companyId: string) => rows('signup_referrals').filter((r) => r.company_id === companyId);
const rolesOf = (userId: string) => rows('user_company_roles').filter((r) => r.user_id === userId);
/** Companies this request created (everything the fixture did not seed, harness base rows included). */
let seededCompanyIds = new Set<string>();
const createdCompanies = () => rows('companies').filter((c) => !seededCompanyIds.has(String(c.id)));
/** Status + body SHAPE (keys and value types) - ids differ per run, the shape must not. */
const shape = (r: { status?: number; body: any }) => ({
  status: r.status,
  keys: Object.keys(r.body ?? {}).sort(),
  types: Object.fromEntries(Object.entries(r.body ?? {}).map(([k, v]) => [k, typeof v])),
});

beforeEach(() => {
  mockBeforeWrite.fn = null;
  mockPinnedWebsite = null;
  mockSent.length = 0;
  mockSender.mode = 'ok';
  (emitSignupEvent as jest.Mock).mockClear();
  delete process.env.VERCEL;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

describe('a guess (name / website) at another company never matches and reveals nothing', () => {
  it("non-matching domain + the victim's company NAME: no victim id/name/admin, no email, no join request", async () => {
    world();
    const r = await setup('mallory@attacker.test', { companyName: VICTIM_NAME });
    await settle();
    expect(r.status).toBe(200);
    expect(leaked(r.body)).toEqual([]);
    expect(r.body.companyExists).toBeUndefined();
    expect(typeof r.body.companyId).toBe('string');
    expect(r.body.companyId).not.toBe(VICTIM);
    expect(leaked(sentTo('mallory@attacker.test'))).toEqual([]);
    expect(sentTo(VADMIN_EMAIL)).toEqual([]);
    expect(referralsFor(VICTIM)).toEqual([]);
    expect(rolesOf(REQ).every((x) => x.company_id !== VICTIM)).toBe(true);
  });

  it("non-matching domain + the victim's WEBSITE (user-input website source): nothing revealed, the company is bound to the requester's own domain", async () => {
    world();
    mockPinnedWebsite = 'https://www.victim.test';
    const r = await setup('mallory@attacker.test', { companyName: 'Mallory Ltd', website: 'https://www.victim.test' });
    await settle();
    expect(r.status).toBe(200);
    expect(leaked(r.body)).toEqual([]);
    expect(r.body.companyExists).toBeUndefined();
    expect(mockSent).toEqual([]);
    expect(referralsFor(VICTIM)).toEqual([]);
    const created = createdCompanies();
    expect(created).toHaveLength(1);
    expect(created[0].website_domain).toBe('attacker.test');
    expect(created[0].admin_email_domain).toBe('attacker.test');
  });

  it('ORACLE (name): "the name matches a company" and "no company has that name" are identical in status and body shape', async () => {
    world();
    const hit = await setup('mallory@attacker.test', { companyName: VICTIM_NAME });
    await settle();
    const hitMail = mockSent.length;
    world();
    mockSent.length = 0;
    const miss = await setup('mallory@attacker.test', { companyName: 'Nobody Has This Name Inc' });
    await settle();
    expect(shape(hit)).toEqual(shape(miss));
    expect(hitMail).toBe(mockSent.length);
  });

  it('ORACLE (website): a website that belongs to a company and one that belongs to none are identical in status and body shape', async () => {
    world();
    mockPinnedWebsite = 'https://www.victim.test';
    const hit = await setup('mallory@attacker.test', { website: 'https://www.victim.test' });
    world();
    mockPinnedWebsite = 'https://www.nobody-owns-this.test';
    const miss = await setup('mallory@attacker.test', { website: 'https://www.nobody-owns-this.test' });
    expect(shape(hit)).toEqual(shape(miss));
  });

  it('registrable domains are compared exactly: x@foo.co.uk never matches the company at acme.co.uk', async () => {
    const UK = '30930930-0000-4000-8000-0000000000cc';
    world({
      companies: [{ id: UK, name: 'Acme UK', status: 'active', website: 'https://www.acme.co.uk', website_domain: 'acme.co.uk', admin_email_domain: 'acme.co.uk' }],
      users: [{ id: 'u-ukadmin', email: 'boss@acme.co.uk', name: 'UK Boss', status: 'active' }],
      roles: [{ id: 'r-uk', user_id: 'u-ukadmin', company_id: UK, role: 'COMPANY_ADMIN', status: 'active' }],
    }, 'x@foo.co.uk');
    const r = await setup('x@foo.co.uk', { companyName: 'Acme UK' });
    await settle();
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('Acme UK');
    expect(r.body.companyId).not.toBe(UK);
    expect(mockSent).toEqual([]);
    expect(referralsFor(UK)).toEqual([]);
  });
});

describe('same verified domain -> admin-approved join request, no disclosure', () => {
  const SAM = 'sam@victim.test';

  it('the requester sees only the neutral message; the ADMIN gets the notice; the requester gets no admin contact', async () => {
    world({}, SAM);
    const r = await setup(SAM, { companyName: 'Anything At All' });
    await settle();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ companyExists: true, joinRequested: true, message: expect.any(String) });
    expect(r.body.message).toMatch(/administrator/i);
    expect(leaked(r.body)).toEqual([]);
    // the admin is told, with the requester's email
    const notices = sentTo(VADMIN_EMAIL);
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe('admin_notice');
    expect(notices[0].payload).toMatchObject({ prospectEmail: SAM });
    // the requester is told nothing about the admin - no email to them carries any victim detail
    expect(leaked(sentTo(SAM))).toEqual([]);
    expect(sentTo(SAM).filter((m) => m.kind === 'referral')).toEqual([]);
    // the request is recorded for the company; the requester is NOT a member
    expect(referralsFor(VICTIM)).toHaveLength(1);
    expect(rolesOf(REQ)).toEqual([]);
  });

  it('the reply does not wait for the admin email: a HANGING sender gives the identical response', async () => {
    world({}, SAM);
    const fast = await setup(SAM);
    await settle();
    world({}, SAM);
    mockSent.length = 0;
    mockSender.mode = 'hang';
    const slow = await setup(SAM);
    expect(slow.status).toBe(fast.status);
    expect(slow.body).toEqual(fast.body);
  });

  it('a REJECTING sender gives the identical response (send failure never reaches the requester)', async () => {
    world({}, SAM);
    const ok = await setup(SAM);
    await settle();
    world({}, SAM);
    mockSent.length = 0;
    mockSender.mode = 'reject';
    const failed = await setup(SAM);
    await settle();
    expect(failed.status).toBe(ok.status);
    expect(failed.body).toEqual(ok.body);
    expect(sentTo(VADMIN_EMAIL)).toHaveLength(1); // it was attempted
  });

  it('race path: another request wins the domain INSERT race -> the same neutral join request, nothing revealed', async () => {
    const WIN = '30930930-0000-4000-8000-0000000000ee';
    world({ users: [{ id: 'u-wadmin', email: 'wendy@race.test', name: 'Wendy Winner', status: 'active' }] }, 'rita@race.test');
    uniqueKey('companies', 'website_domain');
    let raced = false;
    mockBeforeWrite.fn = (table, op) => {
      if (table !== 'companies' || op !== 'insert' || raced) return;
      raced = true;
      rows('companies').push({ id: WIN, name: 'Race Winner Co', status: 'active', website: 'https://www.race.test', website_domain: 'race.test', admin_email_domain: 'race.test' });
      rows('user_company_roles').push({ id: 'r-wadmin', user_id: 'u-wadmin', company_id: WIN, role: 'COMPANY_ADMIN', status: 'active' });
    };
    const r = await setup('rita@race.test', { companyName: 'Race Winner Co' });
    await settle();
    expect(raced).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ companyExists: true, joinRequested: true, message: expect.any(String) });
    const s = JSON.stringify(r.body);
    for (const secret of [WIN, 'Race Winner', 'Wendy', 'wendy@']) expect(s).not.toContain(secret);
    expect(sentTo('wendy@race.test').map((m) => m.kind)).toEqual(['admin_notice']);
    expect(sentTo('rita@race.test').filter((m) => m.kind === 'referral')).toEqual([]);
    expect(rolesOf(REQ)).toEqual([]);
  });
});

describe('ambiguous domain', () => {
  it('two companies on the verified domain -> 409 COMPANY_DOMAIN_AMBIGUOUS, nothing revealed, nobody emailed', async () => {
    const A = '30930930-0000-4000-8000-0000000000d1';
    const B = '30930930-0000-4000-8000-0000000000d2';
    world({
      companies: [
        { id: A, name: 'Dup Alpha', status: 'active', website: 'https://www.dup.test', website_domain: 'dup.test', admin_email_domain: null },
        { id: B, name: 'Dup Beta', status: 'active', website: 'https://shop.dup.test', website_domain: 'shop.dup.test', admin_email_domain: null },
      ],
    }, 'x@dup.test');
    const r = await setup('x@dup.test', { companyName: 'Dup Alpha' });
    await settle();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('COMPANY_DOMAIN_AMBIGUOUS');
    const s = JSON.stringify(r.body);
    for (const secret of [A, B, 'Dup Alpha', 'Dup Beta', '2']) expect(s).not.toContain(secret);
    expect(mockSent).toEqual([]);
    expect(createdCompanies().filter((c) => c.id !== A && c.id !== B)).toEqual([]);
    expect(rolesOf(REQ)).toEqual([]);
  });
});

describe('controls (unchanged behaviour)', () => {
  it('an UNVERIFIED email is refused before any lookup', async () => {
    world({}, 'sam@victim.test');
    const r = await setup('sam@victim.test', {}, { 'x-test-unverified': '1' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(mockSent).toEqual([]);
    expect(calls().filter((c) => c.table === 'companies')).toEqual([]);
  });

  it('a FREE email domain without an invite is refused with INVITE_REQUIRED (name of a real company changes nothing)', async () => {
    world({}, 'someone@gmail.com');
    const r = await setup('someone@gmail.com', { companyName: VICTIM_NAME });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ code: 'INVITE_REQUIRED', error: expect.any(String) });
    expect(mockSent).toEqual([]);
  });

  it('a genuinely new company is still created, with the requester as its COMPANY_ADMIN', async () => {
    world({}, 'founder@newco.test');
    const r = await setup('founder@newco.test', { companyName: 'NewCo' });
    await settle();
    expect([r.status, r.body]).toEqual([200, { companyId: expect.any(String) }]);
    expect(Object.keys(r.body)).toEqual(['companyId']);
    const created = createdCompanies();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ id: r.body.companyId, name: 'NewCo', admin_email_domain: 'newco.test', website_domain: 'newco.test' });
    expect(rolesOf(REQ)).toEqual([expect.objectContaining({ company_id: r.body.companyId, role: 'COMPANY_ADMIN', status: 'active' })]);
    expect(mockSent).toEqual([]);
  });
});

describe('the denial is recorded server-side (signup.CompanyExists audit event)', () => {
  it('join request: one CompanyExists/denied event for the requester (after the response)', async () => {
    world({}, 'sam@victim.test');
    const r = await setup('sam@victim.test');
    await settle();
    expect(r.status).toBe(200);
    expect(companyExistsEvents()).toEqual([
      expect.objectContaining({ event: 'CompanyExists', outcome: 'denied', reason: 'DOMAIN_ALREADY_CLAIMED', userId: REQ, email: 'sam@victim.test', companyId: VICTIM }),
    ]);
  });

  it('ambiguous domain: one CompanyExists/denied event, no company attributed', async () => {
    world({
      companies: [
        { id: '30930930-0000-4000-8000-0000000000d1', name: 'Dup Alpha', status: 'active', website: 'https://www.dup.test', website_domain: 'dup.test', admin_email_domain: null },
        { id: '30930930-0000-4000-8000-0000000000d2', name: 'Dup Beta', status: 'active', website: 'https://shop.dup.test', website_domain: 'shop.dup.test', admin_email_domain: null },
      ],
    }, 'x@dup.test');
    const r = await setup('x@dup.test');
    expect(r.status).toBe(409);
    expect(companyExistsEvents()).toEqual([
      expect.objectContaining({ outcome: 'denied', reason: 'COMPANY_DOMAIN_AMBIGUOUS', userId: REQ, companyId: null }),
    ]);
  });

  it('a name guess at another company records no CompanyExists event (it is an ordinary creation)', async () => {
    world();
    await setup('mallory@attacker.test', { companyName: VICTIM_NAME });
    await settle();
    expect(companyExistsEvents()).toEqual([]);
  });
});

describe('company-domain-check and setup-company never disagree (one shared verified-domain lookup)', () => {
  const verdictOf = (check: { status?: number; body: any }, setupReply: { status?: number; body: any }) => ({
    check: check.status === 409 ? check.body.code : check.body?.matched === true ? 'existing' : 'new',
    setup: setupReply.status === 409 ? setupReply.body.code : setupReply.body?.joinRequested === true ? 'existing' : 'new',
  });
  const both = async (email: string) => {
    const check = await invoke(domainCheckRoute as never, { method: 'GET', headers: { 'x-test-user': REQ, 'x-test-email': email } });
    const setupReply = await setup(email);
    await settle();
    return verdictOf(check, setupReply);
  };

  it('a MAIL-SUBDOMAIN user (sam@mail.victim.test) gets the same verdict from both: existing company', async () => {
    world({}, 'sam@mail.victim.test');
    expect(await both('sam@mail.victim.test')).toEqual({ check: 'existing', setup: 'existing' });
  });

  it('an unrelated domain gets the same verdict from both: new company', async () => {
    world({}, 'founder@unrelated.test');
    expect(await both('founder@unrelated.test')).toEqual({ check: 'new', setup: 'new' });
  });

  it('an ambiguous domain gets the same verdict from both: COMPANY_DOMAIN_AMBIGUOUS', async () => {
    world({
      companies: [
        { id: '30930930-0000-4000-8000-0000000000d1', name: 'Dup Alpha', status: 'active', website: 'https://www.dup.test', website_domain: 'dup.test', admin_email_domain: null },
        { id: '30930930-0000-4000-8000-0000000000d2', name: 'Dup Beta', status: 'active', website: 'https://shop.dup.test', website_domain: 'shop.dup.test', admin_email_domain: null },
      ],
    }, 'x@dup.test');
    expect(await both('x@dup.test')).toEqual({ check: 'COMPANY_DOMAIN_AMBIGUOUS', setup: 'COMPANY_DOMAIN_AMBIGUOUS' });
  });
});

describe('F1 (c6 review): a company stamped with the raw HOST (legacy / complete.ts) is still found by [host, root]', () => {
  const LEGACY = '30930930-0000-4000-8000-0000000000f1';
  const legacyWorld = (requester: string) => world({
    companies: [{ id: LEGACY, name: 'Legacy Acme', status: 'active', website: 'https://mail.acme.test', website_domain: 'mail.acme.test', admin_email_domain: 'mail.acme.test' }],
    users: [{ id: 'u-ladmin', email: 'lena@mail.acme.test', name: 'Lena Legacyadmin', status: 'active' }],
    roles: [{ id: 'r-ladmin', user_id: 'u-ladmin', company_id: LEGACY, role: 'COMPANY_ADMIN', status: 'active' }],
  }, requester);

  it('jane2@mail.acme.test (same host) gets the neutral join request - no duplicate company, no 500', async () => {
    legacyWorld('jane2@mail.acme.test');
    uniqueKey('companies', 'website_domain');
    const r = await setup('jane2@mail.acme.test');
    await settle();
    expect([r.status, r.body]).toEqual([200, { companyExists: true, joinRequested: true, message: expect.any(String) }]);
    expect(createdCompanies()).toEqual([]);
    expect(sentTo('lena@mail.acme.test').map((m) => m.kind)).toEqual(['admin_notice']);
  });

  it('bob@acme.test (the registrable root) also gets the join request for the host-stamped company', async () => {
    legacyWorld('bob@acme.test');
    const r = await setup('bob@acme.test');
    await settle();
    expect([r.status, r.body]).toEqual([200, { companyExists: true, joinRequested: true, message: expect.any(String) }]);
    expect(createdCompanies()).toEqual([]);
  });

  it('a new company is stamped with the registrable ROOT in both domain columns (x@mail.newco.test -> newco.test)', async () => {
    world({}, 'x@mail.newco.test');
    const r = await setup('x@mail.newco.test', { companyName: 'NewCo' });
    await settle();
    expect(r.status).toBe(200);
    expect(createdCompanies()).toEqual([expect.objectContaining({ admin_email_domain: 'newco.test', website_domain: 'newco.test' })]);
    // the canonical domain registry row is the root too (it was the raw host before)
    const { saveDomainRecord } = jest.requireMock('../../services/domainRecordService') as { saveDomainRecord: jest.Mock };
    expect(saveDomainRecord.mock.calls.map((c) => [c[0].input_domain, c[0].final_domain])).toEqual([['newco.test', 'newco.test']]);
  });

  it('race path, subdomain requester: the winner is found by [host, root] and a join request follows', async () => {
    const WIN = '30930930-0000-4000-8000-0000000000f2';
    world({ users: [{ id: 'u-wadmin', email: 'wendy@race2.test', name: 'Wendy Winner', status: 'active' }] }, 'rita@mail.race2.test');
    uniqueKey('companies', 'website_domain');
    let raced = false;
    mockBeforeWrite.fn = (table, op) => {
      if (table !== 'companies' || op !== 'insert' || raced) return;
      raced = true;
      rows('companies').push({ id: WIN, name: 'Race Two Co', status: 'active', website: 'https://www.race2.test', website_domain: 'race2.test', admin_email_domain: 'race2.test' });
      rows('user_company_roles').push({ id: 'r-wadmin2', user_id: 'u-wadmin', company_id: WIN, role: 'COMPANY_ADMIN', status: 'active' });
    };
    const r = await setup('rita@mail.race2.test');
    await settle();
    expect(raced).toBe(true);
    expect([r.status, r.body]).toEqual([200, { companyExists: true, joinRequested: true, message: expect.any(String) }]);
  });
});

describe('all three surfaces agree: setup-company, company-domain-check, onboarding/complete', () => {
  const verdict = (surface: 'check' | 'setup' | 'complete', r: { status?: number; body: any }) => {
    if (r.status === 409) return r.body?.code;
    if (surface === 'check') return r.status === 200 ? (r.body?.matched === true ? 'existing' : 'new') : `status ${r.status}`;
    if (surface === 'setup') return r.status === 200 ? (r.body?.joinRequested === true ? 'existing' : 'new') : `status ${r.status}`;
    return r.status === 403 && r.body?.joinRequested === true ? 'existing' : r.status === 200 ? 'new' : `status ${r.status} ${r.body?.error ?? ''}`;
  };
  const allThree = async (email: string, mkWorld: () => void) => {
    const headers = { 'x-test-user': REQ, 'x-test-email': email };
    mkWorld();
    const check = await invoke(domainCheckRoute as never, { method: 'GET', headers });
    mkWorld();
    const setupReply = await setup(email);
    await settle();
    mkWorld();
    for (const t of ['free_credit_profiles', 'users']) resolveUpsertConflicts(t, t === 'users' ? ['id'] : ['organization_id']);
    const done = await invoke(completeRoute as never, { method: 'POST', headers, body: { fullName: 'Requester Person' } });
    await settle();
    return { check: verdict('check', check), setup: verdict('setup', setupReply), complete: verdict('complete', done) };
  };

  it('a mail-subdomain user of an existing company: existing everywhere', async () => {
    expect(await allThree('sam@mail.victim.test', () => world({}, 'sam@mail.victim.test')))
      .toEqual({ check: 'existing', setup: 'existing', complete: 'existing' });
  });

  it('a user of the host-stamped (legacy) company: existing everywhere', async () => {
    const mk = () => world({
      companies: [{ id: '30930930-0000-4000-8000-0000000000f3', name: 'Legacy Co', status: 'active', website: 'https://mail.legacy.test', website_domain: 'mail.legacy.test', admin_email_domain: null }],
    }, 'jo@mail.legacy.test');
    expect(await allThree('jo@mail.legacy.test', mk)).toEqual({ check: 'existing', setup: 'existing', complete: 'existing' });
  });

  it('an ambiguous domain: COMPANY_DOMAIN_AMBIGUOUS everywhere', async () => {
    const mk = () => world({
      companies: [
        { id: '30930930-0000-4000-8000-0000000000d1', name: 'Dup Alpha', status: 'active', website: 'https://www.dup.test', website_domain: 'dup.test', admin_email_domain: null },
        { id: '30930930-0000-4000-8000-0000000000d2', name: 'Dup Beta', status: 'active', website: 'https://shop.dup.test', website_domain: 'shop.dup.test', admin_email_domain: null },
      ],
    }, 'x@dup.test');
    expect(await allThree('x@dup.test', mk)).toEqual({ check: 'COMPANY_DOMAIN_AMBIGUOUS', setup: 'COMPANY_DOMAIN_AMBIGUOUS', complete: 'COMPANY_DOMAIN_AMBIGUOUS' });
  });
});

describe('7c merge precondition: soft-deleted companies (deleted_at) are out of the match and the ambiguity count', () => {
  const DEAD = '30930930-0000-4000-8000-0000000000a1';
  const LIVE = '30930930-0000-4000-8000-0000000000a2';
  const deadCo = (domain: string) => ({ id: DEAD, name: 'Dead Co', status: 'inactive', deleted_at: '2026-10-01T00:00:00Z', website: `https://${domain}`, website_domain: domain, admin_email_domain: null });
  const deadAdmin = { users: [{ id: 'u-dadmin', email: 'dora@dead.test', name: 'Dora Deadadmin', status: 'active' }] };

  // (i) The lookup treats a domain held only by a deleted company as NEW (no join request, no notice).
  // The harness models an UNSCOPED unique key on website_domain, so the INSERT that follows is refused
  // 23505 although no live company holds the domain (20270217000063 scopes the real index to
  // deleted_at IS NULL, so in the database this insert succeeds). It pins the 23505-with-no-live-winner
  // answer; the assertions are the no-disclosure ones that hold either way.
  it('(i) a domain held only by a deleted company is NOT matched: no join request, nobody notified, nothing about it leaks', async () => {
    world({ companies: [deadCo('dead.test')], ...deadAdmin, roles: [{ id: 'r-dadmin', user_id: 'u-dadmin', company_id: DEAD, role: 'COMPANY_ADMIN', status: 'active' }] }, 'nina@dead.test');
    uniqueKey('companies', 'website_domain');
    const r = await setup('nina@dead.test', { companyName: 'Nina Co' });
    await settle();
    expect(r.body?.companyExists).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toMatch(new RegExp(`${DEAD}|Dead Co|Dora`));
    expect(sentTo('dora@dead.test')).toEqual([]);
  });

  it('(i) the INSERT refused by the domain index the deleted row holds -> 409 COMPANY_DOMAIN_UNAVAILABLE, no DB text', async () => {
    world({ companies: [deadCo('dead.test')] }, 'nina@dead.test');
    uniqueKey('companies', 'website_domain');
    const r = await setup('nina@dead.test', { companyName: 'Nina Co' });
    expect([r.status, r.body]).toEqual([409, {
      code: 'COMPANY_DOMAIN_UNAVAILABLE',
      error: 'This domain cannot be used to create a workspace right now. Please contact support.',
    }]);
    expect(JSON.stringify(r.body)).not.toMatch(/admin_email_domain|website_domain|dead\.test|duplicate|unique|constraint|idx_|23505/i);
  });

  it('(ii) one live + one deleted company on the domain: a join request to the LIVE one, not a 409', async () => {
    world({
      companies: [
        deadCo('both.test'),
        { id: LIVE, name: 'Live Co', status: 'active', website: 'https://www.both.test', website_domain: 'both.test', admin_email_domain: null },
      ],
      users: [{ id: 'u-liveadmin', email: 'liv@both.test', name: 'Liv Liveadmin', status: 'active' }],
      roles: [{ id: 'r-liveadmin', user_id: 'u-liveadmin', company_id: LIVE, role: 'COMPANY_ADMIN', status: 'active' }],
    }, 'pat@both.test');
    const r = await setup('pat@both.test');
    await settle();
    expect([r.status, r.body]).toEqual([200, { companyExists: true, joinRequested: true, message: expect.any(String) }]);
    expect(sentTo('liv@both.test').map((m) => m.kind)).toEqual(['admin_notice']);
  });

  it('(iii) control: a SUSPENDED (not deleted) company still gets the join request', async () => {
    world({
      companies: [{ id: LIVE, name: 'Suspended Co', status: 'suspended', deleted_at: null, website: 'https://susp.test', website_domain: 'susp.test', admin_email_domain: null }],
      users: [{ id: 'u-sadmin', email: 'sue@susp.test', name: 'Sue Suspadmin', status: 'active' }],
      roles: [{ id: 'r-sadmin', user_id: 'u-sadmin', company_id: LIVE, role: 'COMPANY_ADMIN', status: 'active' }],
    }, 'tom@susp.test');
    const r = await setup('tom@susp.test');
    await settle();
    expect([r.status, r.body]).toEqual([200, { companyExists: true, joinRequested: true, message: expect.any(String) }]);
    expect(createdCompanies()).toEqual([]);
  });
});

describe('no raw database error text in any setup-company response', () => {
  it('a forced DB failure on the founder role insert gives the generic 500 - not the error text', async () => {
    world({}, 'founder@newco.test');
    failTable('user_company_roles', 'insert');
    const r = await setup('founder@newco.test', { companyName: 'NewCo' });
    expect([r.status, r.body]).toEqual([500, { error: 'Something went wrong. Please try again.' }]);
    expect(JSON.stringify(r.body)).not.toMatch(/forced failure|user_company_roles|XX000/);
  });
});

describe('PSL guard (7c): a public suffix is never a company domain', () => {
  const verdictOf = (surface: 'check' | 'setup' | 'complete', r: { status?: number; body: any }) => {
    if (r.status === 409) return r.body?.code;
    if (surface === 'check') return r.status === 200 ? (r.body?.matched === true ? 'existing' : 'new') : `status ${r.status}`;
    if (surface === 'setup') return r.status === 200 ? (r.body?.joinRequested === true ? 'existing' : 'new') : `status ${r.status}`;
    return r.status === 403 && r.body?.joinRequested === true ? 'existing' : r.status === 200 ? 'new' : `status ${r.status}`;
  };
  const threeSurfaces = async (email: string, mkWorld: () => void) => {
    const headers = { 'x-test-user': REQ, 'x-test-email': email };
    mkWorld();
    const check = await invoke(domainCheckRoute as never, { method: 'GET', headers });
    mkWorld();
    const setupReply = await setup(email);
    await settle();
    mkWorld();
    for (const t of ['free_credit_profiles', 'users']) resolveUpsertConflicts(t, t === 'users' ? ['id'] : ['organization_id']);
    const done = await invoke(completeRoute as never, { method: 'POST', headers, body: { fullName: 'Requester Person' } });
    await settle();
    return { check: verdictOf('check', check), setup: verdictOf('setup', setupReply), complete: verdictOf('complete', done) };
  };
  const AMBIG = { check: 'COMPANY_DOMAIN_AMBIGUOUS', setup: 'COMPANY_DOMAIN_AMBIGUOUS', complete: 'COMPANY_DOMAIN_AMBIGUOUS' };

  for (const [email, suffix] of [['x@co.il', 'co.il'], ['x@github.io', 'github.io']] as const) {
    it(`an email whose host IS a public suffix (${email}) is ambiguous on all three surfaces, even with a company stored under it`, async () => {
      const mk = () => world({
        companies: [{ id: '30930930-0000-4000-8000-0000000000b1', name: 'Suffix Holder', status: 'active', website: `https://${suffix}`, website_domain: suffix, admin_email_domain: suffix }],
        users: [{ id: 'u-sfx', email: `boss@${suffix}`, name: 'Suffix Boss', status: 'active' }],
        roles: [{ id: 'r-sfx', user_id: 'u-sfx', company_id: '30930930-0000-4000-8000-0000000000b1', role: 'COMPANY_ADMIN', status: 'active' }],
      }, email);
      expect(await threeSurfaces(email, mk)).toEqual(AMBIG);
      expect(sentTo(`boss@${suffix}`)).toEqual([]);
    });
  }

  it('foo.co.il and bar.co.il are DIFFERENT companies: each first user gets their own, no cross binding', async () => {
    world({ users: [{ id: 'u-bar', email: 'bar@bar.co.il', name: 'Bar Person', industry: null, status: 'active', active_company_id: null }] }, 'foo@foo.co.il');
    const foo = await invoke(setupCompanyRoute as never, { method: 'POST', body: { companyName: 'Foo IL' }, headers: { 'x-test-user': REQ, 'x-test-email': 'foo@foo.co.il' } });
    await settle();
    const bar = await invoke(setupCompanyRoute as never, { method: 'POST', body: { companyName: 'Bar IL' }, headers: { 'x-test-user': 'u-bar', 'x-test-email': 'bar@bar.co.il' } });
    await settle();
    expect([foo.status, Object.keys(foo.body ?? {})]).toEqual([200, ['companyId']]);
    expect([bar.status, Object.keys(bar.body ?? {})]).toEqual([200, ['companyId']]);
    expect(bar.body.companyId).not.toBe(foo.body.companyId);
    const created = createdCompanies();
    expect(created.map((c) => c.admin_email_domain).sort()).toEqual(['bar.co.il', 'foo.co.il']);
    expect(rolesOf('u-bar')).toEqual([expect.objectContaining({ company_id: bar.body.companyId, role: 'COMPANY_ADMIN' })]);
    expect(rolesOf(REQ)).toEqual([expect.objectContaining({ company_id: foo.body.companyId, role: 'COMPANY_ADMIN' })]);
  });
});

describe('candidate cap: a query that returns MAX_DOMAIN_CANDIDATES rows is potentially incomplete -> ambiguous, never a decision', () => {
  it('with the cap reached, the same-domain requester gets 409 COMPANY_DOMAIN_AMBIGUOUS (not a join request)', async () => {
    // The in-memory harness does not evaluate ILIKE, so every candidate query returns the first rows of
    // the table: 12 unrelated companies fill the cap, exactly as an over-broad real result would.
    const filler = Array.from({ length: 12 }, (_, i) => ({ id: `30930930-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, name: `Filler ${i}`, status: 'active', website: null, website_domain: null, admin_email_domain: `filler${i}.test` }));
    world({ companies: filler }, 'sam@victim.test');
    const r = await setup('sam@victim.test');
    await settle();
    expect([r.status, r.body?.code]).toEqual([409, 'COMPANY_DOMAIN_AMBIGUOUS']);
    expect(sentTo(VADMIN_EMAIL)).toEqual([]);
  });
});

describe('owner ruling 2026-11-19: identity is the WEBSITE domain; a shared ADMIN email domain claims nothing', () => {
  // POLICY fixture (synthetic): company S's website is shared.test; company B's website is beta.test; BOTH are
  // administered from shared.test. One live company per WEBSITE domain; several may share an admin domain.
  const S = '30930930-0000-4000-8000-0000000005a1';
  const B = '30930930-0000-4000-8000-0000000005b1';
  const sCo = { id: S, name: 'Shared Site Co', status: 'active', website: 'https://www.shared.test', website_domain: 'shared.test', admin_email_domain: 'shared.test' };
  const bCo = { id: B, name: 'Beta Brand Co', status: 'active', website: 'https://www.beta.test', website_domain: 'beta.test', admin_email_domain: 'shared.test' };
  const admins = {
    users: [
      { id: 'u-sadm', email: 'a@shared.test', name: 'Sal Sharedadmin', status: 'active' },
      { id: 'u-badm', email: 'b@shared.test', name: 'Bo Betaadmin', status: 'active' },
    ],
    roles: [
      { id: 'r-sadm', user_id: 'u-sadm', company_id: S, role: 'COMPANY_ADMIN', status: 'active' },
      { id: 'r-badm', user_id: 'u-badm', company_id: B, role: 'COMPANY_ADMIN', status: 'active' },
    ],
  };
  afterEach(() => { mockNoDerivedWebsite = false; mockPinnedWebsite = null; });

  it('x@shared.test, with S (website shared.test) and B (website beta.test, admin shared.test): a join request to S ONLY - never a 409, never B', async () => {
    world({ companies: [sCo, bCo], ...admins }, 'x@shared.test');
    const r = await setup('x@shared.test');
    await settle();
    expect([r.status, r.body]).toEqual([200, { companyExists: true, joinRequested: true, message: expect.any(String) }]);
    expect(sentTo('a@shared.test').map((m) => m.kind)).toEqual(['admin_notice']);
    expect(sentTo('b@shared.test')).toEqual([]);
    expect(companyExistsEvents()).toEqual([expect.objectContaining({ reason: 'DOMAIN_ALREADY_CLAIMED', companyId: S })]);
    expect(createdCompanies()).toEqual([]);
  });

  it('a company matched ONLY via admin_email_domain (B: website beta.test) is NOT matched: the founder opens shared.test', async () => {
    world({ companies: [bCo], ...admins }, 'x@shared.test');
    uniqueKey('companies', 'website_domain');
    const r = await setup('x@shared.test', { companyName: 'Shared Site Co' });
    await settle();
    expect([r.status, Object.keys(r.body ?? {})]).toEqual([200, ['companyId']]);
    expect(createdCompanies()).toEqual([expect.objectContaining({ id: r.body.companyId, website_domain: 'shared.test', admin_email_domain: 'shared.test' })]);
    expect(sentTo('b@shared.test')).toEqual([]);
    expect(rolesOf(REQ)).toEqual([expect.objectContaining({ company_id: r.body.companyId, role: 'COMPANY_ADMIN' })]);
  });

  it('race path relies on the WEBSITE index: a concurrent same-website winner -> 23505 -> a join request to the winner', async () => {
    const WIN = '30930930-0000-4000-8000-0000000005c1';
    world({ companies: [bCo], ...admins, users: [...admins.users, { id: 'u-wadm', email: 'w@shared.test', name: 'Win Admin', status: 'active' }] }, 'x@shared.test');
    uniqueKey('companies', 'website_domain'); // the ONLY domain unique key (no admin_email_domain key)
    let raced = false;
    mockBeforeWrite.fn = (table, op) => {
      if (table !== 'companies' || op !== 'insert' || raced) return;
      raced = true;
      rows('companies').push({ id: WIN, name: 'Race Winner', status: 'active', website: 'https://www.shared.test', website_domain: 'shared.test', admin_email_domain: 'shared.test' });
      rows('user_company_roles').push({ id: 'r-wadm', user_id: 'u-wadm', company_id: WIN, role: 'COMPANY_ADMIN', status: 'active' });
    };
    const r = await setup('x@shared.test');
    await settle();
    expect(raced).toBe(true);
    expect([r.status, r.body]).toEqual([200, { companyExists: true, joinRequested: true, message: expect.any(String) }]);
    expect(sentTo('w@shared.test').map((m) => m.kind)).toEqual(['admin_notice']);
    expect(sentTo('b@shared.test')).toEqual([]);
    expect(rows('companies').filter((c) => c.website_domain === 'shared.test')).toHaveLength(1);
  });

  it('every self-signup insert stamps website_domain = the email root: with no website resolvable, NO company is created (409)', async () => {
    world({}, 'founder@nosite.test');
    mockNoDerivedWebsite = true;
    mockPinnedWebsite = '';
    const r = await setup('founder@nosite.test', { companyName: 'No Site Co' });
    await settle();
    expect([r.status, r.body]).toEqual([409, { code: 'COMPANY_DOMAIN_UNAVAILABLE', error: expect.any(String) }]);
    expect(createdCompanies()).toEqual([]);
    expect(rolesOf(REQ)).toEqual([]);
  });

  it('CONTROL: the same founder with the website resolvable is created, website_domain = email root', async () => {
    world({}, 'founder@nosite.test');
    const r = await setup('founder@nosite.test', { companyName: 'No Site Co' });
    await settle();
    expect(r.status).toBe(200);
    expect(createdCompanies()).toEqual([expect.objectContaining({ website_domain: 'nosite.test', admin_email_domain: 'nosite.test' })]);
  });
});
