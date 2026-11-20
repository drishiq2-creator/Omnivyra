/**
 * LOGIN MFA BYPASS on a read failure (b3 2026-11-20, BLOCKING privilege).
 * Before: TotpFactorRepository.findActiveForUser / WebAuthnCredentialRepository.listForUser destructured only
 * `{ data }`; ownedDbTable never throws on a postgrest error, so a FAILED factor read became "no factor" ->
 * MfaIntent hasMfa:false -> sync-supabase-user minted a session WITHOUT the MFA challenge (its fail-closed catch
 * never ran). Now the repositories throw SecurityReadError and the route answers 503 with NO session.
 * REAL: the route handler, MfaIntent.userHasVerifiedMfaFactor, both factor repositories, SecurityReadError.
 * FAKED: the DB (per-table outcomes), token validation, session minting (recorded), the MFA-intent cookie.
 */
export {};
type Outcome = { data: unknown; error: { message: string } | null };
let mockTables: Record<string, Outcome> = {};
function mockBuilder(table: string) {
  const b: any = {};
  for (const m of ['select', 'eq', 'is', 'in', 'limit', 'order', 'update', 'insert', 'upsert', 'neq', 'gt', 'lt', 'not']) b[m] = () => b;
  b.maybeSingle = () => b;
  b.single = () => b;
  b.then = (ok: any, ko: any) => Promise.resolve(mockTables[table] ?? { data: null, error: null }).then(ok, ko);
  return b;
}
jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: (t: string) => mockBuilder(t), rpc: async () => ({ data: true, error: null }) },
}));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => mockBuilder(t) }));
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/requestContext', () => ({ seedRequestContextFromRequest: jest.fn() }));
jest.mock('../../../lib/auth/serverValidation', () => ({ validateWorkEmail: jest.fn(() => true) }));
jest.mock('../../services/authResolver', () => ({
  extractAccessToken: () => 'tok',
  validateAuthToken: async () => ({ supabaseUid: 'sb-uid-1', email: 'pat@mfa-user.test', emailVerified: true }),
  resolveAuthenticatedUser: jest.fn(),
}));
jest.mock('../../../lib/auth/auditLog', () => ({ logAuthEvent: jest.fn() }));
jest.mock('../../../lib/auth/anomalyDetector', () => ({ recordAnomalyEvent: jest.fn() }));
jest.mock('../../services/initialFreeCreditService', () => ({
  grantInitialFreeCredit: jest.fn(), reconcileInitialFreeCredit: jest.fn(),
}));
jest.mock('../../services/emailService', () => ({ sendCompanyAdminReferral: jest.fn(), sendInboundSignupNoticeToAdmin: jest.fn() }));
const mockMinted: string[] = [];
jest.mock('../../security/SessionAuthorityService', () => ({
  ensureSessionForUser: async (_req: unknown, _res: unknown, input: { userId: string }) => { mockMinted.push(input.userId); return { minted: true, sessionId: 's-1' }; },
}));
jest.mock('../../security/audit/SecurityAuditService', () => ({ logSecurityEvent: jest.fn() }));
const mockIntents: string[] = [];
jest.mock('../../security/MfaIntent', () => ({
  ...jest.requireActual('../../security/MfaIntent'),
  issueMfaIntent: (_res: unknown, input: { userId: string }) => { mockIntents.push(input.userId); },
}));
jest.mock('../../services/authMetrics', () => ({ incrementAuthMetric: jest.fn() }));

/* eslint-disable @typescript-eslint/no-var-requires */
const handler = require('../../../pages/api/auth/sync-supabase-user').default;

const USER = { id: 'user-1', is_deleted: false };
const VERIFIED_TOTP = { id: 'f-1', user_id: 'user-1', verified_at: '2026-11-01T00:00:00Z', revoked_at: null };
const FAIL = { data: null, error: { message: 'connection terminated' } };

async function login() {
  const res: any = { statusCode: 200, body: null, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; }, getHeader() { return undefined; },
    status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  await handler({ method: 'POST', headers: { 'user-agent': 'jest' }, body: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
}

beforeEach(() => {
  mockMinted.length = 0; mockIntents.length = 0;
  mockTables = { users: { data: USER, error: null }, totp_factors: { data: null, error: null }, webauthn_credentials: { data: [], error: null } };
});

describe('login MFA gate: a factor read FAILURE never mints a session', () => {
  it('TOTP factor read fails -> 503 PROFILE_LOAD_FAILED, NO session, NO intent', async () => {
    mockTables.totp_factors = FAIL;
    const r = await login();
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatchObject({ code: 'PROFILE_LOAD_FAILED' });
    expect(mockMinted).toEqual([]);
    expect(mockIntents).toEqual([]);
  });

  it('passkey list read fails -> 503, NO session', async () => {
    mockTables.webauthn_credentials = FAIL;
    const r = await login();
    expect(r.statusCode).toBe(503);
    expect(mockMinted).toEqual([]);
  });

  it('CONTROL: a user with NO factors (both reads succeed, empty) logs in normally - session minted', async () => {
    const r = await login();
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(mockMinted).toEqual(['user-1']);
  });

  it('CONTROL: a user WITH a verified TOTP factor gets the challenge - no session yet', async () => {
    mockTables.totp_factors = { data: VERIFIED_TOTP, error: null };
    const r = await login();
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mfa_required: true, factors: ['totp'] });
    expect(mockMinted).toEqual([]);
    expect(mockIntents).toEqual(['user-1']);
  });
});
