/**
 * Vetted path, approve.ts (b3 ruling, 2026-11-19): D2 claim + D1 invitation + the 503/500 contract.
 *
 * D2 - CLAIM before creating anything. access_requests.status has a CHECK (pending/approved/rejected/
 *   deleted), so there is no 'approving' value and no migration: the claim is status 'approved' with
 *   organization_id NULL and reviewed_at = the claim time (G2 already treats an approved row without
 *   organization_id as absent). Two atomic conditional UPDATEs: status='pending', else a STALE claim
 *   (approved, organization_id NULL, reviewed_at older than 10 minutes). The loser gets 409 before any
 *   write. Any failure after the claim releases it (guarded on THIS claim) and leaves nothing behind.
 *   A second 'approved' row for the same email is never written (the old duplicate-approval branch did,
 *   against idx_access_requests_email_approved_unique).
 * CONTRACT - 503 = NOTHING was changed (a failure before the claim, or after a claim cleanly released
 *   with no company and no invitation left behind). Anything that may have been written and could not be
 *   cleaned up is 500 APPROVAL_STATE_UNKNOWN.
 * D1 - approve issues an INVITATION through the existing flow (invitationService.createAndSendInvitation:
 *   email_jobs enqueue): the requester's email, the vetted company, COMPANY_ADMIN. The 200 carries the
 *   send outcome (queued / failed). accept-invite consumes the token once; an expired token is refused.
 *   G2's verified-email binding stays the second line.
 *
 * REAL: approve, accept-invite, setup-company, invitationService, companyWebsiteCreation, the writer,
 * approvedAccessRequestService - over routeAuthHarness. FAKED: capability gate + admin limiter, rate
 * limits, the email_jobs enqueue (recorded; switchable to fail), Supabase OTP send, telemetry.
 */
import { seed, rows, invoke, resolveUpsertConflicts, failTable, resetHarnessDeclarations } from '../helpers/routeAuthHarness';

const mockBeforeWrite: { fn: ((table: string, op: string, payload: unknown) => void) | null } = { fn: null };
/** A database ERROR answer for a matching write (e.g. a 23505 the harness cannot model on an UPDATE). */
const mockWriteError: { fn: ((table: string, op: string, payload: unknown) => { code: string; message: string } | null) | null } = { fn: null };
function mockErrorChain(error: { code: string; message: string }) {
  const chain: Record<string, unknown> = {};
  const answer = { data: null, error };
  for (const m of ['eq', 'neq', 'in', 'is', 'lt', 'gt', 'lte', 'gte', 'not', 'select', 'limit', 'order']) chain[m] = () => chain;
  chain.single = async () => answer;
  chain.maybeSingle = async () => answer;
  chain.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(answer).then(ok, ko);
  return chain;
}
function mockWrap(builder: Record<string, unknown>, table: string) {
  for (const op of ['update', 'delete', 'insert'] as const) {
    const orig = builder[op] as (p?: unknown, o?: unknown) => Record<string, unknown>;
    builder[op] = (p?: unknown, o?: unknown) => {
      if (mockBeforeWrite.fn) mockBeforeWrite.fn(table, op, p);
      const forced = mockWriteError.fn ? mockWriteError.fn(table, op, p) : null;
      return forced ? mockErrorChain(forced) : orig(p, o);
    };
  }
  return builder;
}
jest.mock('@/config', () => ({ config: { DEV_USER_ID: '', NODE_ENV: 'production', INVITATION_TOKEN_SECRET: 'test-only-invitation-secret' } }));
jest.mock('../../db/supabaseClient', () => {
  const fake = require('../helpers/routeAuthHarness').supabaseModule().supabase;
  const wrapped = {
    ...fake,
    from: (t: string) => mockWrap(fake.from(t), t),
    auth: { ...fake.auth, signInWithOtp: async () => ({ error: null }) },
  };
  return { supabase: wrapped, default: wrapped, getSupabase: () => wrapped, supabaseAdmin: wrapped };
});
jest.mock('../../db/writeOwner', () => {
  const base = require('../helpers/routeAuthHarness').writeOwnerModule();
  return { ownedDbTable: (t: string) => mockWrap(base.ownedDbTable(t), t) };
});
jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: async (req: { headers?: Record<string, unknown> }) => {
    const id = req?.headers?.['x-test-user'];
    if (typeof id !== 'string' || !id) return { user: null, error: 'MISSING_AUTH' };
    return { user: { id, email: req?.headers?.['x-test-email'] as string, emailVerified: true }, error: null };
  },
}));
jest.mock('../../security/requireCapability', () => ({
  requireCapability: async () => ({ ok: true, principal: { userId: 'u-super' } }),
}));
jest.mock('../../services/requestAccessService', () => ({ requireAdminRateLimit: async () => true }));
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../lib/auth/rateLimit', () => ({
  checkRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: 0, bypassed: false }),
  LOGIN_LIMIT: { keyPrefix: 'rl:login', limit: 10, windowSecs: 900 },
}));
jest.mock('../../auth/requestClientIp', () => ({ authRequestIp: () => '127.0.0.1' }));
jest.mock('../../config/getCanonicalAppUrl', () => ({ getCanonicalAppUrl: () => 'https://app.example.test' }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
/** The existing flow's delivery seam: email_jobs enqueue (the cron worker sends later). */
const mockEnqueue: { calls: Array<Record<string, any>>; fail: boolean } = { calls: [], fail: false };
jest.mock('../../services/emailJobsService', () => ({
  enqueueEmailJob: async (job: Record<string, any>) => {
    mockEnqueue.calls.push(job);
    if (mockEnqueue.fail) throw new Error('EMAIL_JOB_ENQUEUE_FAILED:test');
    return { id: `job-${mockEnqueue.calls.length}` };
  },
}));
jest.mock('../../services/signupEventService', () => ({
  emitSignupEvent: jest.fn(async () => undefined),
  ensureSignupCorrelationId: jest.fn(async () => 'corr-test'),
  requestIp: () => '127.0.0.1',
  requestUserAgent: () => 'jest',
}));
jest.mock('../../services/emailService', () => ({ sendCompanyAdminReferral: jest.fn(), sendInboundSignupNoticeToAdmin: jest.fn() }));
jest.mock('../../services/initialFreeCreditService', () => ({
  grantInitialFreeCredit: jest.fn(async () => ({ ok: true, granted: true, credits: 300, expiresAt: 'x' })),
  INITIAL_FREE_CREDIT_CATEGORY: 'initial_free_credit', INITIAL_FREE_CREDIT_DEFAULT: 300, INITIAL_FREE_CREDIT_EXPIRY_DAYS_DEFAULT: 30,
}));
jest.mock('../../services/companyIdentityDriftService', () => ({ monitorCompanyIdentityDrift: jest.fn(() => null) }));
jest.mock('../../services/auditActorService', () => ({ insertAuditLogStrict: jest.fn(async () => undefined), SYSTEM_USER_ID: 'system' }));
jest.mock('../../services/earnCreditsService', () => ({ grantEarnCredit: jest.fn(async () => ({ ok: true })) }));
jest.mock('../../services/companyProfile/refinementHelpers', () => ({
  crawlWebsiteSources: jest.fn(async () => ({ social_links: [], metadata: null })),
  mergeDiscoveredSocialProfiles: jest.fn(() => ({})),
}));
jest.mock('../../services/companyMembershipIntegrityService', () => ({ SELF_REGISTERED_JOIN_SOURCE: 'self_registered', selectCompatibleCompanyRole: jest.fn(() => null) }));
jest.mock('../../services/domainRecordService', () => ({ saveDomainRecord: jest.fn(async () => ({ ok: true })) }));
jest.mock('../../services/companyProfile/enrichmentProvenance', () => ({ buildDiscoveredProvenance: jest.fn(() => ({})) }));
jest.mock('../../services/companyBootstrapService', () => ({ bootstrapCompanyProfile: jest.fn(async () => ({})) }));
jest.mock('../../services/crawl/crawlEventService', () => ({ emitCrawlEvent: jest.fn(async () => undefined) }));

import approveRoute from '../../../pages/api/admin/access-requests/approve';
import acceptInviteRoute from '../../../pages/api/auth/accept-invite';
import setupCompanyRoute from '../../../pages/api/onboarding/setup-company';

jest.setTimeout(120_000);

const REQ = 'u-requester';
const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: 'ar-1', email: 'fay@gmail.com', name: 'Fay Person', company_name: 'Fay Studio', website_url: 'https://fay-studio.test',
  domain: 'gmail.com', domain_status: 'PUBLIC_EMAIL', status: 'pending', organization_id: null, reviewed_at: null, reviewed_by: null, ...over,
});
let seededCompanies = new Set<string>();
function world(accessRequests: Record<string, unknown>[], extra: { companies?: Record<string, unknown>[] } = {}) {
  seed({
    access_requests: accessRequests,
    companies: extra.companies ?? [],
    users: [{ id: REQ, email: 'fay@gmail.com', name: 'Fay Person', status: 'active', active_company_id: null }],
    user_company_roles: [],
    invitations: [],
  });
  seededCompanies = new Set(rows('companies').map((c) => String(c.id)));
  for (const t of ['company_profiles', 'company_scheduler_prefs', 'company_setup_progress']) resolveUpsertConflicts(t, ['company_id']);
}
const createdCompanies = () => rows('companies').filter((c) => !seededCompanies.has(String(c.id)));
const approve = (requestId = 'ar-1') => invoke(approveRoute as never, { method: 'POST', body: { requestId } });
const accept = (token: string) => invoke(acceptInviteRoute as never, { method: 'POST', body: { token } });
const tokenOf = (job: Record<string, any>) => new URL(String(job.payload.inviteUrl)).searchParams.get('token') as string;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const request = (id = 'ar-1') => rows('access_requests').find((r) => r.id === id);

beforeEach(() => {
  resetHarnessDeclarations();
  mockBeforeWrite.fn = null;
  mockWriteError.fn = null;
  mockEnqueue.calls.length = 0;
  mockEnqueue.fail = false;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

// ── D2: the claim ────────────────────────────────────────────────────────────
describe('D2: approve claims the request atomically before creating anything', () => {
  it('two CONCURRENT approvals: exactly one company and one invitation; the loser is 409 with nothing written', async () => {
    world([pendingRow()]);
    const [a, b] = await Promise.all([approve(), approve()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe('ACCESS_REQUEST_NOT_PENDING');
    expect(createdCompanies()).toHaveLength(1);
    expect(rows('invitations')).toHaveLength(1);
    expect(request()).toEqual(expect.objectContaining({ status: 'approved', organization_id: createdCompanies()[0].id }));
  });

  it('a CRASHED claim older than the 10-minute cutoff is reclaimable and completes', async () => {
    world([pendingRow({ status: 'approved', organization_id: null, reviewed_at: minutesAgo(11), reviewed_by: 'u-crashed' })]);
    const r = await approve();
    expect(r.status).toBe(200);
    expect(createdCompanies()).toHaveLength(1);
    expect(request()).toEqual(expect.objectContaining({ status: 'approved', organization_id: createdCompanies()[0].id, reviewed_by: 'u-super' }));
  });

  it('a FRESH claim (another approval in flight) is NOT reclaimable: 409, nothing written', async () => {
    const claimedAt = minutesAgo(1);
    world([pendingRow({ status: 'approved', organization_id: null, reviewed_at: claimedAt, reviewed_by: 'u-other' })]);
    const r = await approve();
    expect([r.status, r.body.code]).toEqual([409, 'ACCESS_REQUEST_NOT_PENDING']);
    expect(createdCompanies()).toEqual([]);
    expect(rows('invitations')).toEqual([]);
    expect(request()).toEqual(expect.objectContaining({ status: 'approved', organization_id: null, reviewed_at: claimedAt, reviewed_by: 'u-other' }));
  });

  it('the stale cutoff is decided ATOMICALLY by the claim: a claim refreshed by another approver just before ours is not taken over', async () => {
    world([pendingRow({ status: 'approved', organization_id: null, reviewed_at: minutesAgo(11), reviewed_by: 'u-crashed' })]);
    const theirs = new Date().toISOString();
    let refreshed = false;
    mockBeforeWrite.fn = (table, op) => {
      if (table !== 'access_requests' || op !== 'update' || refreshed) return;
      refreshed = true; // another approver reclaimed the stale row between our read and our claim
      Object.assign(request() as Record<string, unknown>, { reviewed_at: theirs, reviewed_by: 'u-other' });
    };
    const r = await approve();
    expect([r.status, r.body.code]).toEqual([409, 'ACCESS_REQUEST_NOT_PENDING']);
    expect(createdCompanies()).toEqual([]);
    expect(request()).toEqual(expect.objectContaining({ status: 'approved', organization_id: null, reviewed_at: theirs, reviewed_by: 'u-other' }));
  });

  it('a request already approved WITH a company is 409, nothing written', async () => {
    world([pendingRow({ status: 'approved', organization_id: 'co-done', reviewed_at: minutesAgo(60) })]);
    const r = await approve();
    expect([r.status, r.body.code]).toEqual([409, 'ACCESS_REQUEST_NOT_PENDING']);
    expect(createdCompanies()).toEqual([]);
  });

  it('DUPLICATE email: another request of the same email is already approved -> 409 refused, NO second approved row', async () => {
    world([
      pendingRow({ id: 'ar-old', status: 'approved', organization_id: 'co-old', reviewed_at: minutesAgo(60) }),
      pendingRow({ id: 'ar-new' }),
    ]);
    const r = await approve('ar-new');
    expect([r.status, r.body]).toEqual([409, { code: 'EMAIL_ALREADY_APPROVED', error: expect.any(String), companyId: 'co-old' }]);
    expect(rows('access_requests').filter((x) => x.status === 'approved')).toHaveLength(1);
    expect(request('ar-new')).toEqual(expect.objectContaining({ status: 'pending', organization_id: null }));
    expect(createdCompanies()).toEqual([]);
  });

  it('a claim refused by the approved-email unique index (23505, an in-flight claim of another request) -> 409, nothing written', async () => {
    world([pendingRow()]);
    // idx_access_requests_email_approved_unique refuses the claim (another request of this email holds an
    // in-flight claim, invisible to the pre-check because its organization_id is still NULL).
    mockWriteError.fn = (table, op, payload) =>
      (table === 'access_requests' && op === 'update' && (payload as { status?: string })?.status === 'approved'
        ? { code: '23505', message: 'duplicate key value violates unique constraint "idx_access_requests_email_approved_unique"' } : null);
    const r = await approve();
    expect([r.status, r.body.code]).toEqual([409, 'EMAIL_ALREADY_APPROVED']);
    expect(createdCompanies()).toEqual([]);
    expect(request()).toEqual(expect.objectContaining({ status: 'pending' }));
  });
});

// ── the 503 / 500 contract ───────────────────────────────────────────────────
describe('contract: 503 means NOTHING was changed; anything uncertain is 500 APPROVAL_STATE_UNKNOWN', () => {
  it('a failed company create after the claim -> the claim is released -> 503, no rows', async () => {
    world([pendingRow()]);
    failTable('companies', 'insert');
    const r = await approve();
    expect([r.status, r.body.code]).toEqual([503, 'APPROVAL_NOT_APPLIED']);
    expect(createdCompanies()).toEqual([]);
    expect(rows('invitations')).toEqual([]);
    expect(request()).toEqual(expect.objectContaining({ status: 'pending', organization_id: null, reviewed_at: null, reviewed_by: null }));
  });

  it('a failed RELEASE after a failed create -> 500 APPROVAL_STATE_UNKNOWN (not 503)', async () => {
    world([pendingRow()]);
    failTable('companies', 'insert');
    mockBeforeWrite.fn = (table, op, payload) => {
      if (table === 'access_requests' && op === 'update' && (payload as { status?: string })?.status === 'pending') throw new Error('network down');
    };
    const r = await approve();
    expect([r.status, r.body.code]).toEqual([500, 'APPROVAL_STATE_UNKNOWN']);
  });

  it('a failed LINK after the company was created -> the company is removed and the claim released -> 503, no rows', async () => {
    world([pendingRow()]);
    mockBeforeWrite.fn = (table, op, payload) => {
      if (table === 'access_requests' && op === 'update' && (payload as { organization_id?: unknown })?.organization_id) throw new Error('link failed');
    };
    const r = await approve();
    expect([r.status, r.body.code]).toEqual([503, 'APPROVAL_NOT_APPLIED']);
    expect(createdCompanies()).toEqual([]);
    expect(rows('invitations')).toEqual([]);
    expect(request()).toEqual(expect.objectContaining({ status: 'pending', organization_id: null }));
  });

  it('a failed LINK whose company cannot be removed -> 500 APPROVAL_STATE_UNKNOWN', async () => {
    world([pendingRow()]);
    failTable('companies', 'delete');
    mockBeforeWrite.fn = (table, op, payload) => {
      if (table === 'access_requests' && op === 'update' && (payload as { organization_id?: unknown })?.organization_id) throw new Error('link failed');
    };
    const r = await approve();
    expect([r.status, r.body.code]).toEqual([500, 'APPROVAL_STATE_UNKNOWN']);
  });

  it('a release never undoes the claim of ANOTHER approval (the claim was taken over meanwhile) -> 500 APPROVAL_STATE_UNKNOWN, their claim intact', async () => {
    world([pendingRow()]);
    failTable('companies', 'insert');
    const theirs = new Date(Date.now() + 1000).toISOString();
    mockBeforeWrite.fn = (table, op) => {
      if (table !== 'companies' || op !== 'insert') return;
      Object.assign(request() as Record<string, unknown>, { reviewed_at: theirs, reviewed_by: 'u-other' });
    };
    const r = await approve();
    expect([r.status, r.body.code]).toEqual([500, 'APPROVAL_STATE_UNKNOWN']);
    expect(request()).toEqual(expect.objectContaining({ status: 'approved', organization_id: null, reviewed_at: theirs, reviewed_by: 'u-other' }));
  });

  it('a failed CLAIM write is 503 with nothing written', async () => {
    world([pendingRow()]);
    failTable('access_requests', 'update');
    const r = await approve();
    expect([r.status, r.body.code]).toEqual([503, 'APPROVAL_NOT_APPLIED']);
    expect(createdCompanies()).toEqual([]);
    expect(request()).toEqual(expect.objectContaining({ status: 'pending' }));
  });
});

// ── D1: the invitation ───────────────────────────────────────────────────────
describe('D1: approve issues an invitation through the existing flow', () => {
  it('approve -> an invitation for the requester email, the vetted company, COMPANY_ADMIN; queued; the payload names the company', async () => {
    world([pendingRow()]);
    const r = await approve();
    expect(r.status).toBe(200);
    const companyId = r.body.companyId;
    expect(r.body.invitation).toEqual({ created: true, email: 'queued' });
    expect(rows('invitations')).toEqual([expect.objectContaining({
      email: 'fay@gmail.com', company_id: companyId, role: 'COMPANY_ADMIN', invited_by: 'u-super',
      idempotency_key: 'access-request:ar-1', accepted_at: null, revoked_at: null,
    })]);
    expect(mockEnqueue.calls).toEqual([expect.objectContaining({
      templateKey: 'team_invite_magic_link', recipientEmail: 'fay@gmail.com',
      payload: expect.objectContaining({ companyName: 'Fay Studio', role: 'COMPANY_ADMIN' }),
    })]);
  });

  it('accept -> the token is consumed once (a reuse is refused); the verified requester lands in the vetted company as COMPANY_ADMIN', async () => {
    world([pendingRow()]);
    const r = await approve();
    const token = tokenOf(mockEnqueue.calls[0]);
    const first = await accept(token);
    expect([first.status, first.body]).toEqual([200, { ok: true, email: 'fay@gmail.com' }]);
    const again = await accept(token);
    expect([again.status, again.body.code]).toEqual([400, 'ALREADY_USED']);
    const s = await invoke(setupCompanyRoute as never, {
      method: 'POST', body: { companyName: 'Typed' }, headers: { 'x-test-user': REQ, 'x-test-email': 'fay@gmail.com' },
    });
    expect([s.status, s.body]).toEqual([200, { companyId: r.body.companyId }]);
    expect(rows('user_company_roles').filter((x) => x.user_id === REQ))
      .toEqual([expect.objectContaining({ company_id: r.body.companyId, role: 'COMPANY_ADMIN', status: 'active' })]);
  });

  it('an EXPIRED invitation token is refused (the existing expiry semantics)', async () => {
    world([pendingRow()]);
    await approve();
    const token = tokenOf(mockEnqueue.calls[0]);
    rows('invitations')[0].expires_at = minutesAgo(1);
    const r = await accept(token);
    expect([r.status, r.body.code]).toEqual([400, 'EXPIRED']);
  });

  it('an email ENQUEUE failure: 200 approved with invitation.email "failed"; the invitation row exists (revoked by the flow)', async () => {
    world([pendingRow()]);
    mockEnqueue.fail = true;
    const r = await approve();
    expect(r.status).toBe(200);
    expect(r.body.invitation).toEqual({ created: true, email: 'failed' });
    expect(rows('invitations')).toEqual([expect.objectContaining({ email: 'fay@gmail.com', company_id: r.body.companyId, role: 'COMPANY_ADMIN', revoked_at: expect.any(String) })]);
    expect(request()).toEqual(expect.objectContaining({ status: 'approved', organization_id: r.body.companyId }));
  });

  it('an invitation that cannot be created at all: 200 approved with invitation { created: false, email: "failed" }', async () => {
    world([pendingRow()]);
    failTable('invitations', 'insert');
    const r = await approve();
    expect(r.status).toBe(200);
    expect(r.body.invitation).toEqual({ created: false, email: 'failed' });
    expect(request()).toEqual(expect.objectContaining({ status: 'approved', organization_id: r.body.companyId }));
  });
});
