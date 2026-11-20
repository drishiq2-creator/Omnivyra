/**
 * POST /api/auth/set-password outcome (S1, 2026-11-20; server contract from 89's
 * fix/security-read-failures-fail-closed-20261120).
 *
 * 200 { success: true, route, otherSessionsSignedOut: false, code: 'OTHER_SESSIONS_NOT_SIGNED_OUT' } means the
 * password changed but signing out the OTHER sessions failed. Keyed on `code` (b3), never on the absence of a flag,
 * so an older server (no code) behaves exactly as before.
 *
 * The notice's button calls POST /api/auth/sessions/revoke { revokeAll: true } via apiFetch (bearer; the session
 * cookie is already cleared). b3: ships with/after 89's step-1 hotfix that makes revoke-all also end bearer
 * sessions, so the copy promises nothing beyond what that path does.
 */
export const OTHER_SESSIONS_NOT_SIGNED_OUT = 'OTHER_SESSIONS_NOT_SIGNED_OUT';

export function otherSessionsNotSignedOut(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as Record<string, unknown>).code === OTHER_SESSIONS_NOT_SIGNED_OUT;
}

export const OTHER_SESSIONS_NOTICE = "Your password changed, but we couldn't sign out your other devices.";
export const SIGN_OUT_OTHERS_LABEL = 'Sign out other devices now';
export const SIGN_OUT_OTHERS_DONE = 'Your other devices are signed out. Sign in again to continue.';
/** A refusal (4xx): nothing was revoked. Point at the real control (pages/settings/security.tsx). */
export const SIGN_OUT_OTHERS_REFUSED =
  "We couldn't sign out your other devices. Sign in and use 'Sign out of all other sessions' in Settings → Security.";
/** Lost connection / 5xx: we don't know. Claim nothing; point at where the user can see their sessions. */
export const SIGN_OUT_OTHERS_UNKNOWN =
  "We're not sure your other devices were signed out. Sign in and check 'Active sessions' in Settings → Security.";

export type SignOutOthersOutcome = 'done' | 'refused' | 'unknown';

/** status null = the request threw. apiFetch answers a lost connection with a non-2xx (503 today, 599 after #17). */
export function classifySignOutOthers(status: number | null): SignOutOthersOutcome {
  if (status !== null && status >= 200 && status < 300) return 'done';
  if (status === null || status >= 500) return 'unknown';
  return 'refused';
}
