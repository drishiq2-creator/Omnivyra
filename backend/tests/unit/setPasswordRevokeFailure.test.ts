/**
 * set-password when the session revoke FAILS (b3 ruling 2026-11-20). The password change is real and must not read
 * as failed, but a password change is often a response to compromise: the response says the other sessions were NOT
 * signed out (code OTHER_SESSIONS_NOT_SIGNED_OUT), a security event + metric are recorded, and the session cookie is
 * ALWAYS cleared. Before: the revoke failure was swallowed and the route answered a plain 200.
 */
import { seed, invoke, CO_A } from '../helpers/routeAuthHarness';

jest.mock('@/config', () => ({ config: { DEV_USER_ID: '', NODE_ENV: 'production' } }));
jest.mock('../../db/supabaseClient', () => {
  const m = require('../helpers/routeAuthHarness').supabaseModule();
  m.supabase.auth.admin.updateUserById = async () => ({ data: {}, error: null });
  return m;
});
jest.mock('../../db/writeOwner', () => require('../helpers/routeAuthHarness').writeOwnerModule());
jest.mock('../../services/authResolver', () => ({
  resolveAuthenticatedUser: async (req: { headers?: Record<string, unknown> }) => {
    const id = req?.headers?.['x-test-user'];
    return typeof id === 'string' && id
      ? { user: { id, supabaseUid: `sb-${id}`, email: 'invitee@example.test', status: 'active' }, error: null }
      : { user: null, error: 'NO_TOKEN' };
  },
  extractAccessToken: () => 'test-user-jwt',
}));
const mockRevokeAll = jest.fn();
const mockClearCookie = jest.fn();
jest.mock('../../security/SessionAuthorityService', () => ({
  clearSessionCookie: (...a: unknown[]) => mockClearCookie(...a),
}));
jest.mock('../../services/lifecycleGovernance', () => ({
  // the hotfix's revoke-all (JWT epoch + canonical sessions + refresh tokens via the caller's JWT) - what set-password calls
  revokeAllAccessForUser: async (...a: unknown[]) => ({ revokedAuthSessions: await mockRevokeAll(...a), refreshTokensRevoked: true }),
}));
jest.mock('../../security/stepup/StepUpSessionService', () => ({ revokeForUser: jest.fn(async () => 0) }));
const mockAudit = jest.fn();
jest.mock('../../security/audit/SecurityAuditService', () => ({ logSecurityEvent: (e: unknown) => { mockAudit(e); return Promise.resolve(); } }));
const mockMetric = jest.fn();
jest.mock('../../services/authMetrics', () => ({ incrementAuthMetric: (...a: unknown[]) => mockMetric(...a) }));
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../services/userPreferencesService', () => ({ getPostLoginRoute: async () => '/dashboard' }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const setPassword = require('../../../pages/api/auth/set-password').default;

const USER = 'u-invitee';
const PASSWORD = 'C15e-Test-Passw0rd!-not-real';

beforeEach(() => {
  mockRevokeAll.mockReset(); mockClearCookie.mockReset(); mockAudit.mockReset(); mockMetric.mockReset();
  seed({
    users: [{ id: USER, email: 'invitee@example.test', has_password: false }],
    invitations: [{ id: 'inv-sp', email: 'invitee@example.test', company_id: CO_A, role: 'VIEW_ONLY', expires_at: '2099-01-01T00:00:00.000Z', accepted_at: null, revoked_at: null, token_consumed_at: '2026-10-15T11:00:00.000Z', created_at: '2026-10-15T10:00:00.000Z' }],
  });
});
const post = () => invoke(setPassword as never, { method: 'POST', body: { password: PASSWORD, flow: 'signup' }, headers: { 'x-test-user': USER } });

describe('set-password: a failed session revoke is reported, never silent', () => {
  it('revoke fails -> 200 with otherSessionsSignedOut:false + code; cookie cleared; security event + metric', async () => {
    mockRevokeAll.mockRejectedValue(new Error('SECURITY_READ_FAILED:auth_sessions:revokeAllSessionsForUser'));
    const r = await post();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, otherSessionsSignedOut: false, code: 'OTHER_SESSIONS_NOT_SIGNED_OUT' });
    expect(mockClearCookie).toHaveBeenCalledTimes(1);
    expect(mockMetric).toHaveBeenCalledWith('auth_set_password_session_revoke_failed', expect.any(Object));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'auth_session_revoke_failed', principalUserId: USER }));
  });

  it('CONTROL: revoke succeeds -> plain 200 (no flag, no code), cookie cleared, no failure event', async () => {
    mockRevokeAll.mockResolvedValue(2);
    const r = await post();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, route: expect.any(String) });
    expect(mockRevokeAll).toHaveBeenCalledWith(USER, 'credential_rotation:signup', { userJwt: 'test-user-jwt' });
    expect(mockClearCookie).toHaveBeenCalledTimes(1);
    expect(mockAudit).not.toHaveBeenCalledWith(expect.objectContaining({ decision: 'auth_session_revoke_failed' }));
  });
});
