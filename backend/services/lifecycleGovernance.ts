/**
 * lifecycleGovernance — server-side helpers for the operational lifecycle
 * (suspend / resume / force-logout / company-disable cascade).
 *
 * Responsibilities:
 *   - invalidateUserSessionsAndSignOut(userId, reason) — the
 *     `invalidate_user_sessions` RPC: the in-app `auth_sessions` table and the JWT epoch
 *     (users.session_revoked_after). Supabase refresh tokens are NOT cleared by user id
 *     (see REFRESH_TOKENS_NOT_REVOKED) until step 2.
 *   - cascadeDisableCompany(companyId, actor, reason) — wrapper around the
 *     `disable_company_cascade` RPC.
 *
 * These helpers never throw on Supabase-side admin failures — they log
 * and continue so the DB-side invalidation always lands (which is the
 * authoritative gate via the canonical authResolver).
 */

import { supabase } from '../db/supabaseClient';
import { logger } from './logger';
import { SecurityReadError } from '../security/SecurityReadError';

/**
 * Refresh tokens cannot be revoked BY USER ID through supabase-js: auth.admin.signOut(jwt, scope) takes the USER'S
 * JWT (auth-js GoTrueAdminApi: POST /logout with it as the bearer). Until revoke_user_gotrue_sessions (migration 070,
 * step 2) lands, a path that only knows the user id kills live ACCESS tokens (the session_revoked_after epoch) and the
 * canonical auth_sessions, but an outstanding REFRESH token can still mint a new access token (b3/89 2026-11-20).
 */
export const REFRESH_TOKENS_NOT_REVOKED = 'REFRESH_TOKENS_NOT_REVOKED_BY_ID';

/**
 * Revoke-all for one user (b3 ruling 2026-11-20, step 1): the EXISTING invalidate_user_sessions RPC (epoch bump on
 * users.session_revoked_after + revoke every auth_sessions row, atomic) - error-checked, never "0 revoked" on failure -
 * plus, when the caller holds the user's own access token, Supabase's global sign-out (kills that user's refresh
 * tokens). Throws on ANY failure: callers report success only after both succeeded.
 */
export async function revokeAllAccessForUser(
  userId: string,
  reason: string,
  opts: { userJwt?: string | null } = {},
): Promise<{ revokedAuthSessions: number; refreshTokensRevoked: boolean }> {
  if (!userId) throw new Error('REVOKE_ALL_ACCESS_MISSING_USER_ID');
  if (!reason?.trim()) throw new Error('REVOKE_ALL_ACCESS_MISSING_REASON');
  const { data, error } = await supabase.rpc('invalidate_user_sessions', { p_user_id: userId, p_reason: reason });
  if (error) throw new SecurityReadError('revokeAllAccessForUser', 'invalidate_user_sessions', error.message ?? null);
  const revokedAuthSessions = typeof data === 'number' ? data : 0;
  if (!opts.userJwt) return { revokedAuthSessions, refreshTokensRevoked: false };
  const { error: signOutErr } = await supabase.auth.admin.signOut(opts.userJwt, 'global');
  if (signOutErr) throw new SecurityReadError('revokeAllAccessForUser', 'gotrue.logout', signOutErr.message ?? null);
  return { revokedAuthSessions, refreshTokensRevoked: true };
}

export interface InvalidateResult {
  /** auth_sessions rows revoked by the RPC. */
  revokedAuthSessions: number;
  /** True iff the Supabase admin signOut call succeeded (refresh tokens cleared). */
  supabaseSignOutOk: boolean;
  /** Supabase admin error message, if any (logged separately for ops). */
  supabaseSignOutError: string | null;
}

/**
 * Atomic-ish session invalidation. The DB RPC is atomic; the Supabase
 * admin signOut call is best-effort because:
 *   - it may fail if the supabase_uid is unknown to auth.users (already
 *     deleted), and that's not a reason to abort the DB-side invalidation
 *   - the auth resolver's epoch check (users.session_revoked_after) is
 *     the authoritative gate regardless of refresh-token state
 *
 * Pass the public.users.id (NOT the supabase_uid). The function resolves
 * supabase_uid internally so callers don't need both.
 */
export async function invalidateUserSessionsAndSignOut(
  userId: string,
  reason: string,
): Promise<InvalidateResult> {
  if (!userId) throw new Error('LIFECYCLE_INVALIDATE_MISSING_USER_ID');
  if (!reason?.trim()) throw new Error('LIFECYCLE_INVALIDATE_MISSING_REASON');

  // 1. DB-side invalidation (epoch bump + auth_sessions revoke).
  const { data: rpcData, error: rpcErr } = await supabase.rpc('invalidate_user_sessions', {
    p_user_id: userId,
    p_reason: reason,
  });
  if (rpcErr) {
    throw new Error(`INVALIDATE_USER_SESSIONS_RPC_FAILED:${rpcErr.message}`);
  }
  const revoked = typeof rpcData === 'number' ? rpcData : 0;

  // 2. Refresh tokens: NOT revocable by user id through supabase-js (see REFRESH_TOKENS_NOT_REVOKED). This used to
  //    call auth.admin.signOut(supabaseUid, 'global') behind an `as unknown as` cast - passing a USER ID where the
  //    API takes the user's JWT - so it could never succeed and only ever logged lifecycle_supabase_signout_failed
  //    (2026-11-20). Reported honestly now; step 2 (revoke_user_gotrue_sessions, migration 070) closes it.
  //    The just-bumped epoch already rejects every existing ACCESS token; a SUSPENDED user is also refused by
  //    authResolver's status check before the epoch check, so only force-logout depends on step 2.
  const supabaseSignOutOk = false;
  const supabaseSignOutError: string | null = REFRESH_TOKENS_NOT_REVOKED;
  logger.warn('lifecycle_refresh_tokens_not_revoked', { userId, reason });

  return {
    revokedAuthSessions: revoked,
    supabaseSignOutOk,
    supabaseSignOutError,
  };
}

export interface CompanyCascadeResult {
  affectedUsers: number;
  revokedRoles: number;
  revokedSessions: number;
}

/**
 * Run the disable_company_cascade RPC. Returns the counters as a single
 * object. The RPC itself is transactional.
 *
 * Note: the RPC does NOT call Supabase admin signOut — there can be many
 * affected users (one per active membership), and looping admin signOut
 * over them here would be a bulk admin call. Refresh-token revocation
 * for those users is handled lazily at the next auth resolution (the
 * epoch bump invalidates access tokens immediately).
 */
export async function cascadeDisableCompany(
  companyId: string,
  actorUserId: string,
  reason: string,
): Promise<CompanyCascadeResult> {
  if (!companyId) throw new Error('CASCADE_DISABLE_MISSING_COMPANY_ID');
  if (!actorUserId) throw new Error('CASCADE_DISABLE_MISSING_ACTOR');
  if (!reason?.trim()) throw new Error('CASCADE_DISABLE_MISSING_REASON');

  const { data, error } = await supabase.rpc('disable_company_cascade', {
    p_company_id: companyId,
    p_actor: actorUserId,
    p_reason: reason,
  });
  if (error) {
    throw new Error(`DISABLE_COMPANY_CASCADE_RPC_FAILED:${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    affectedUsers: Number((row as any)?.affected_users ?? 0),
    revokedRoles: Number((row as any)?.revoked_roles ?? 0),
    revokedSessions: Number((row as any)?.revoked_sessions ?? 0),
  };
}

export async function softDeleteCompanyWithCascade(
  companyId: string,
  actorUserId: string,
  reason: string,
): Promise<CompanyCascadeResult> {
  if (!companyId) throw new Error('SOFT_DELETE_COMPANY_MISSING_COMPANY_ID');
  if (!actorUserId) throw new Error('SOFT_DELETE_COMPANY_MISSING_ACTOR');
  if (!reason?.trim()) throw new Error('SOFT_DELETE_COMPANY_MISSING_REASON');

  const { data, error } = await supabase.rpc('soft_delete_company', {
    p_company_id: companyId,
    p_actor: actorUserId,
    p_reason: reason,
  });
  if (error) {
    throw new Error(`SOFT_DELETE_COMPANY_RPC_FAILED:${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    affectedUsers: Number((row as any)?.affected_users ?? 0),
    revokedRoles: Number((row as any)?.revoked_roles ?? 0),
    revokedSessions: Number((row as any)?.revoked_sessions ?? 0),
  };
}

/**
 * Closure-015L — hard_delete_company RPC (supabase/proposals/closure015l/01_…,
 * NOT yet a migration). One transaction: lock the company row, refuse while an
 * active SUPER_ADMIN membership exists, delete memberships + profile + company.
 * Returns { ok: false, code: 'FUNCTION_MISSING' } while the function is not
 * deployed (PostgREST PGRST202 / Postgres 42883) so the caller can keep its
 * interim path; any other failure throws (nothing was changed — the function
 * is atomic).
 */
export type HardDeleteCompanyResult =
  | { ok: true; deletedMemberships: number; deletedProfiles: number }
  | { ok: false; code: 'FUNCTION_MISSING' };

export async function hardDeleteCompany(
  companyId: string,
  actorUserId: string,
  reason: string,
): Promise<HardDeleteCompanyResult> {
  if (!companyId) throw new Error('HARD_DELETE_COMPANY_MISSING_COMPANY_ID');
  if (!actorUserId) throw new Error('HARD_DELETE_COMPANY_MISSING_ACTOR');
  if (!reason?.trim()) throw new Error('HARD_DELETE_COMPANY_MISSING_REASON');

  const { data, error } = await supabase.rpc('hard_delete_company', {
    p_company_id: companyId,
    p_actor: actorUserId,
    p_reason: reason,
  });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === 'PGRST202' || code === '42883') return { ok: false, code: 'FUNCTION_MISSING' };
    throw new Error(`HARD_DELETE_COMPANY_RPC_FAILED:${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: true,
    deletedMemberships: Number((row as any)?.deleted_memberships ?? 0),
    deletedProfiles: Number((row as any)?.deleted_profiles ?? 0),
  };
}
