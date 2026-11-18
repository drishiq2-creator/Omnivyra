/**
 * CI-309 (2026-11-19): POST /api/auth/signup is the PRE-VERIFICATION gate. On a claimed domain it answered
 * 409 CLAIMED_DOMAIN with the company admin's masked email (`adminEmailMasked`) and `alreadyReferred`
 * (whether THIS exact email had tried before), and emailed the prospect the admin's name and address.
 * Now: still 409 CLAIMED_DOMAIN (an owner product decision, unchanged here), but the body is
 * { error, code } only, identical on every attempt; the prospect is sent nothing; the company's admin is
 * still told (inbound signup notice).
 * REAL: signup.ts, claimedDomainNotifyService. FAKED: the tables (in-memory), the two email sends
 * (recorded), rate limit, captcha, telemetry.
 */
export {};
type Row = Record<string, any>;
const mockDb: Record<string, Row[]> = {};
function mockTable(table: string) {
  const tests: Array<(r: Row) => boolean> = [];
  let one = false; let op = 'select'; let payload: Row | null = null; let cap = Infinity;
  const run = () => {
    const rows = (mockDb[table] ??= []);
    if (op === 'insert') { const row = { id: `${table}-${rows.length + 1}`, ...payload }; rows.push(row); return { data: row, error: null }; }
    const hit = rows.filter((r) => tests.every((t) => t(r))).slice(0, cap);
    if (op === 'update') { hit.forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
    return { data: one ? hit[0] ?? null : hit, error: null };
  };
  const b: any = {
    select: () => b, order: () => b, gt: () => b,
    limit: (n: number) => { cap = n; return b; },
    eq: (c: string, v: unknown) => { tests.push((r) => r[c] === v); return b; },
    in: (c: string, v: unknown[]) => { tests.push((r) => v.includes(r[c])); return b; },
    insert: (p: Row) => { op = 'insert'; payload = p; return b; },
    update: (p: Row) => { op = 'update'; payload = p; return b; },
    maybeSingle: () => { one = true; return b; },
    single: () => { one = true; return b; },
    then: (ok: any, ko: any) => Promise.resolve(run()).then(ok, ko),
  };
  return b;
}
jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: (t: string) => mockTable(t), rpc: async () => ({ data: false, error: null }), auth: { admin: {} } },
}));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => mockTable(t) }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../auth/requestClientIp', () => ({ authRequestIp: () => '1.2.3.4' }));
jest.mock('../../../lib/auth/rateLimit', () => ({ checkRateLimit: async () => ({ allowed: true }), EMAIL_LINK_LIMIT: {} }));
jest.mock('../../services/requestContext', () => ({ seedRequestContextFromRequest: () => undefined }));
jest.mock('../../../lib/auth/captcha', () => ({ verifyCaptchaToken: async () => ({ ok: true }), CAPTCHA_FAILED_RESPONSE: { error: 'captcha' } }));
jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../services/signupEventService', () => ({
  emitSignupEvent: jest.fn(async () => undefined),
  ensureSignupCorrelationId: jest.fn(async () => 'corr-test'),
  signupRejectionEventFor: () => 'SignupRejected',
  requestUserAgent: () => 'jest',
}));
const mockSent: Array<{ kind: string; to: string; payload: unknown }> = [];
let mockSendHangs = false;
jest.mock('../../services/emailService', () => ({
  sendCompanyAdminReferral: async (to: string, payload: unknown) => { mockSent.push({ kind: 'referral', to, payload }); },
  sendInboundSignupNoticeToAdmin: async (to: string, payload: unknown) => {
    mockSent.push({ kind: 'admin_notice', to, payload });
    if (mockSendHangs) await new Promise(() => undefined);
  },
}));
/* eslint-disable @typescript-eslint/no-var-requires */
const route = require('../../../pages/api/auth/signup').default;
/* eslint-enable @typescript-eslint/no-var-requires */

const PROSPECT = 'sam@victim.test';
const ADMIN_EMAIL = 'vera@victim.test';
const ADMIN_NAME = 'Vera Victimadmin';
const COMPANY = 'Victim Corp';
async function post(email = PROSPECT) {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (x: unknown) => { res.body = x; return res; };
  res.setHeader = () => res;
  await route({ method: 'POST', headers: {}, query: {}, body: { email, companyName: 'Anything' } }, res);
  return res;
}
beforeEach(() => {
  for (const k of Object.keys(mockDb)) delete mockDb[k];
  mockSent.length = 0;
  mockSendHangs = false;
  delete process.env.VERCEL;
  mockDb.companies = [{ id: 'co-v', name: COMPANY, status: 'active', website_domain: 'victim.test', admin_email_domain: 'victim.test' }];
  mockDb.users = [{ id: 'u-vadmin', email: ADMIN_EMAIL, name: ADMIN_NAME }];
  mockDb.user_company_roles = [{ user_id: 'u-vadmin', company_id: 'co-v', role: 'COMPANY_ADMIN', status: 'active', created_at: '1' }];
  mockDb.signup_referrals = [];
});
const leaks = (x: unknown) => {
  const s = JSON.stringify(x ?? null);
  return ['co-v', COMPANY, ADMIN_NAME, 'Vera', ADMIN_EMAIL, 've', '•', '@victim.test'].filter((v) => s.includes(v));
};

it('claimed domain: 409 CLAIMED_DOMAIN with { error, code } only - no masked admin email, no referral flag', async () => {
  const r = await post();
  expect(r.statusCode).toBe(409);
  expect(Object.keys(r.body).sort()).toEqual(['code', 'error']);
  expect(r.body.code).toBe('CLAIMED_DOMAIN');
  expect(leaks(r.body)).toEqual([]);
});

it('a repeat attempt by the same email gets the identical reply (nothing reveals it tried before)', async () => {
  const first = await post();
  const second = await post();
  expect([second.statusCode, second.body]).toEqual([first.statusCode, first.body]);
});

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

it('a HANGING admin notice neither delays nor changes the 409 reply (no timing signal)', async () => {
  const fast = await post();
  for (const k of Object.keys(mockDb)) if (k === 'signup_referrals') mockDb[k] = [];
  mockSendHangs = true;
  const slow = await Promise.race([post(), new Promise((resolve) => setTimeout(() => resolve('TIMED OUT'), 3000))]) as any;
  expect(slow).not.toBe('TIMED OUT');
  expect([slow.statusCode, slow.body]).toEqual([fast.statusCode, fast.body]);
});

it("the prospect is sent nothing; the company's admin is still told (inbound signup notice)", async () => {
  await post();
  await settle();
  expect(mockSent.filter((m) => m.to === PROSPECT)).toEqual([]);
  expect(mockSent.map((m) => [m.kind, m.to])).toEqual([['admin_notice', ADMIN_EMAIL]]);
  expect(mockSent[0].payload).toMatchObject({ prospectEmail: PROSPECT });
});
