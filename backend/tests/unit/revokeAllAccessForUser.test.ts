/**
 * Sign-out-everywhere / credential rotation / recovery / admin reset must end BEARER sessions too (b3 2026-11-20,
 * BLOCKING). revokeAllAccessForUser = the EXISTING invalidate_user_sessions RPC (JWT epoch users.session_revoked_after
 * + every canonical auth_sessions row) - error-checked - plus Supabase's global sign-out with the caller's OWN token
 * (auth.admin.signOut takes the user's JWT, not a user id). Throws on any failure.
 * And the reader: authResolver compares the epoch at WHOLE SECONDS (JWT iat has 1 s resolution).
 */
export {};
const mockRpc = jest.fn();
const mockSignOut = jest.fn();
let mockUserRow: Record<string, unknown> | null = null;
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    rpc: (...a: unknown[]) => mockRpc(...a),
    auth: { admin: { signOut: (...a: unknown[]) => mockSignOut(...a) }, getUser: async () => ({ data: { user: { id: 'sb-uid-1', email: 'pat@epoch.test', email_confirmed_at: '2026-01-01' } }, error: null }) },
    from: () => { throw new Error('unexpected table access'); },
  },
}));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: () => { const b: any = { update: () => b, eq: () => b, then: (ok: any) => Promise.resolve({ data: null, error: null }).then(ok) }; return b; } }));
jest.mock('../../services/userColumnProjection', () => ({ tolerantUserSelect: async () => ({ row: mockUserRow }) }));
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { revokeAllAccessForUser, invalidateUserSessionsAndSignOut, REFRESH_TOKENS_NOT_REVOKED } = require('../../services/lifecycleGovernance');
const { resolveAuthenticatedUser } = require('../../services/authResolver');

beforeEach(() => { mockRpc.mockReset(); mockSignOut.mockReset(); });

describe('revokeAllAccessForUser', () => {
  it('runs the EXISTING invalidate_user_sessions RPC (no second epoch writer) and signs out with the caller\'s own token', async () => {
    mockRpc.mockResolvedValue({ data: 3, error: null });
    mockSignOut.mockResolvedValue({ error: null });
    const r = await revokeAllAccessForUser('user-1', 'user_revoked_all', { userJwt: 'caller.jwt.token' });
    expect(mockRpc).toHaveBeenCalledWith('invalidate_user_sessions', { p_user_id: 'user-1', p_reason: 'user_revoked_all' });
    expect(mockSignOut).toHaveBeenCalledWith('caller.jwt.token', 'global');
    expect(r).toEqual({ revokedAuthSessions: 3, refreshTokensRevoked: true });
  });

  it('a failed RPC THROWS (never "0 revoked") and no sign-out is attempted', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(revokeAllAccessForUser('user-1', 'r', { userJwt: 't' })).rejects.toMatchObject({ code: 'SECURITY_READ_FAILED' });
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('a failed global sign-out THROWS (success is reported only after both)', async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    mockSignOut.mockResolvedValue({ error: { message: 'invalid JWT' } });
    await expect(revokeAllAccessForUser('user-1', 'r', { userJwt: 't' })).rejects.toMatchObject({ code: 'SECURITY_READ_FAILED' });
  });

  it('without the caller\'s token: epoch + canonical sessions only, refreshTokensRevoked:false (step-2 residual)', async () => {
    mockRpc.mockResolvedValue({ data: 2, error: null });
    const r = await revokeAllAccessForUser('user-1', 'recovery');
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(r).toEqual({ revokedAuthSessions: 2, refreshTokensRevoked: false });
  });

  it('force-logout helper no longer passes a USER ID as a JWT; it reports the residual honestly', async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    const r = await invalidateUserSessionsAndSignOut('user-1', 'force_logout:x');
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(r).toEqual({ revokedAuthSessions: 1, supabaseSignOutOk: false, supabaseSignOutError: REFRESH_TOKENS_NOT_REVOKED });
  });
});

// A JWT whose payload carries the given iat (signature irrelevant: getUser is faked as valid).
const jwtWithIat = (iatSec: number) =>
  `h.${Buffer.from(JSON.stringify({ sub: 'sb-uid-1', iat: iatSec })).toString('base64url')}.s`;
const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` }, cookies: {} });

describe('authResolver JWT epoch at whole seconds', () => {
  const REVOKED_AT = '2026-11-20T12:00:00.700Z'; // ms precision, as invalidate_user_sessions writes NOW()
  const revokeSec = Math.floor(Date.parse(REVOKED_AT) / 1000);
  beforeEach(() => {
    mockUserRow = { id: 'user-1', email: 'pat@epoch.test', is_deleted: false, status: 'active', session_revoked_after: REVOKED_AT };
  });

  it('a token issued in the SAME second as the revoke (the user re-authenticating) is ACCEPTED', async () => {
    const r = await resolveAuthenticatedUser(req(jwtWithIat(revokeSec)));
    expect(r.error).toBeNull();
    expect(r.user).toMatchObject({ id: 'user-1' });
  });

  it('a token issued the second BEFORE the revoke is REJECTED (SESSION_REVOKED)', async () => {
    const r = await resolveAuthenticatedUser(req(jwtWithIat(revokeSec - 1)));
    expect(r).toEqual(expect.objectContaining({ user: null, error: 'SESSION_REVOKED' }));
  });

  it('an UNPARSEABLE epoch fails CLOSED (SESSION_REVOKED), never silently accepted (7c)', async () => {
    mockUserRow = { ...mockUserRow, session_revoked_after: 'not-a-timestamp' };
    const r = await resolveAuthenticatedUser(req(jwtWithIat(revokeSec + 5)));
    expect(r).toEqual(expect.objectContaining({ user: null, error: 'SESSION_REVOKED' }));
  });

  it('control: a token from long before is rejected; one from after is accepted', async () => {
    expect((await resolveAuthenticatedUser(req(jwtWithIat(revokeSec - 3600)))).error).toBe('SESSION_REVOKED');
    expect((await resolveAuthenticatedUser(req(jwtWithIat(revokeSec + 5)))).error).toBeNull();
  });
});
