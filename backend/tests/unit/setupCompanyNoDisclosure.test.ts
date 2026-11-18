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
import { seed, rows, calls, invoke, uniqueKey, resolveUpsertConflicts } from '../helpers/routeAuthHarness';

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
jest.mock('../../services/validatedWebsiteService', () => {
  const actual = jest.requireActual('../../services/validatedWebsiteService');
  return {
    ...actual,
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
jest.mock('../../services/initialFreeCreditService', () => ({ grantInitialFreeCredit: jest.fn(async () => ({ ok: true })) }));
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

import setupCompanyRoute from '../../../pages/api/onboarding/setup-company';
import { emitSignupEvent } from '../../services/signupEventService';

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
    uniqueKey('companies', 'admin_email_domain');
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
        { id: B, name: 'Dup Beta', status: 'active', website: null, website_domain: null, admin_email_domain: 'dup.test' },
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
        { id: '30930930-0000-4000-8000-0000000000d2', name: 'Dup Beta', status: 'active', website: null, website_domain: null, admin_email_domain: 'dup.test' },
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
