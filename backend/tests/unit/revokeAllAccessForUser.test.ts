/**
 * Sign-out-everywhere / credential rotation / recovery / admin reset must end BEARER sessions too (b3 2026-11-20,
 * BLOCKING). revokeAllAccessForUser = the EXISTING invalidate_user_sessions RPC (JWT epoch users.session_revoked_after
 * + every canonical auth_sessions row) - error-checked - plus Supabase's global sign-out with the caller's OWN token
 * (auth.admin.signOut takes the user's JWT, not a user id), plus step 2: revoke_user_gotrue_sessions BY USER ID (GoTrue
 * sessions + refresh tokens) on every path. Throws on any failure.
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
const { revokeAllAccessForUser, invalidateUserSessionsAndSignOut } = require('../../services/lifecycleGovernance');
const { resolveAuthenticatedUser } = require('../../services/authResolver');

// RPC fakes by name; every call is recorded in order (with the sign-out) so ORDER is asserted, not assumed.
const order: string[] = [];
let invalidate: { data: unknown; error: unknown } = { data: 3, error: null };
let gotrue: { data: unknown; error: unknown } = { data: { user_found: true, auth_identity: true, sessions_deleted: 2, legacy_refresh_tokens_revoked: 0 }, error: null };
beforeEach(() => {
  mockRpc.mockReset(); mockSignOut.mockReset(); order.length = 0;
  invalidate = { data: 3, error: null };
  gotrue = { data: { user_found: true, auth_identity: true, sessions_deleted: 2, legacy_refresh_tokens_revoked: 0 }, error: null };
  mockRpc.mockImplementation(async (name: string) => { order.push(name); return name === 'invalidate_user_sessions' ? invalidate : gotrue; });
  mockSignOut.mockImplementation(async () => { order.push('signOut'); return { error: null }; });
});

describe('revokeAllAccessForUser', () => {
  it('epoch RPC -> sign-out with the caller own token -> by-id GoTrue revoke (step 2), in that order', async () => {
    const r = await revokeAllAccessForUser('user-1', 'user_revoked_all', { userJwt: 'caller.jwt.token' });
    expect(mockRpc).toHaveBeenCalledWith('invalidate_user_sessions', { p_user_id: 'user-1', p_reason: 'user_revoked_all' });
    expect(mockSignOut).toHaveBeenCalledWith('caller.jwt.token', 'global');
    expect(mockRpc).toHaveBeenCalledWith('revoke_user_gotrue_sessions', { p_user_id: 'user-1' });
    expect(order).toEqual(['invalidate_user_sessions', 'signOut', 'revoke_user_gotrue_sessions']);
    expect(r).toEqual({ revokedAuthSessions: 3, refreshTokensRevoked: true });
  });

  it('WITHOUT the caller token (recovery / admin reset): refresh tokens ARE revoked by id now (PL-102 closed)', async () => {
    invalidate = { data: 2, error: null };
    const r = await revokeAllAccessForUser('user-1', 'recovery');
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(order).toEqual(['invalidate_user_sessions', 'revoke_user_gotrue_sessions']);
    expect(r).toEqual({ revokedAuthSessions: 2, refreshTokensRevoked: true });
  });

  it('a failed epoch RPC THROWS (never "0 revoked"); no sign-out, no GoTrue revoke attempted', async () => {
    invalidate = { data: null, error: { message: 'boom' } };
    await expect(revokeAllAccessForUser('user-1', 'r', { userJwt: 't' })).rejects.toMatchObject({ code: 'SECURITY_READ_FAILED' });
    expect(order).toEqual(['invalidate_user_sessions']);
  });

  it('a failed global sign-out THROWS (success is reported only after all)', async () => {
    mockSignOut.mockImplementation(async () => ({ error: { message: 'invalid JWT' } }));
    await expect(revokeAllAccessForUser('user-1', 'r', { userJwt: 't' })).rejects.toMatchObject({ code: 'SECURITY_READ_FAILED' });
  });

  it('a failed by-id GoTrue revoke THROWS - e.g. the function missing because the migration is not applied', async () => {
    gotrue = { data: null, error: { message: 'Could not find the function public.revoke_user_gotrue_sessions' } };
    await expect(revokeAllAccessForUser('user-1', 'r')).rejects.toMatchObject({ code: 'SECURITY_READ_FAILED' });
  });

  it('NO SUCH USER (070 user_found:false) THROWS by name - never "0 revoked, done" (7c/b3)', async () => {
    gotrue = { data: { user_found: false, auth_identity: false, sessions_deleted: 0, legacy_refresh_tokens_revoked: 0 }, error: null };
    await expect(revokeAllAccessForUser('ghost', 'r')).rejects.toThrow(/^REVOKE_USER_NOT_FOUND/);
  });

  it('an answer WITHOUT user_found is unproven and throws too; a found user with no auth identity is fine', async () => {
    gotrue = { data: { auth_identity: false, sessions_deleted: 0, legacy_refresh_tokens_revoked: 0 }, error: null };
    await expect(revokeAllAccessForUser('user-1', 'r')).rejects.toThrow(/^REVOKE_USER_NOT_FOUND/);
    gotrue = { data: { user_found: true, auth_identity: false, sessions_deleted: 0, legacy_refresh_tokens_revoked: 0 }, error: null };
    await expect(revokeAllAccessForUser('user-1', 'r')).resolves.toEqual({ revokedAuthSessions: 3, refreshTokensRevoked: true });
  });
});

describe('invalidateUserSessionsAndSignOut (force-logout / suspend)', () => {
  it('revokes GoTrue sessions by id and reports supabaseSignOutOk:true; never passes a user id as a JWT', async () => {
    invalidate = { data: 1, error: null };
    const r = await invalidateUserSessionsAndSignOut('user-1', 'force_logout:x');
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(order).toEqual(['invalidate_user_sessions', 'revoke_user_gotrue_sessions']);
    expect(r).toEqual({ revokedAuthSessions: 1, supabaseSignOutOk: true, supabaseSignOutError: null });
  });

  it('a failed GoTrue revoke is REPORTED (ok:false + message), not thrown and never claimed as done', async () => {
    invalidate = { data: 1, error: null };
    gotrue = { data: null, error: { message: 'boom' } };
    const r = await invalidateUserSessionsAndSignOut('user-1', 'force_logout:x');
    expect(r.supabaseSignOutOk).toBe(false);
    expect(r.supabaseSignOutError).toEqual(expect.stringContaining('revoke_user_gotrue_sessions'));
  });

  it('force-logout of an id NO users row has REPORTS REVOKE_USER_NOT_FOUND (a stale/mistyped id is not "done")', async () => {
    invalidate = { data: 0, error: null };
    gotrue = { data: { user_found: false, auth_identity: false, sessions_deleted: 0, legacy_refresh_tokens_revoked: 0 }, error: null };
    const r = await invalidateUserSessionsAndSignOut('ghost', 'force_logout:x');
    expect(r.supabaseSignOutOk).toBe(false);
    expect(r.supabaseSignOutError).toEqual(expect.stringMatching(/^REVOKE_USER_NOT_FOUND/));
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
