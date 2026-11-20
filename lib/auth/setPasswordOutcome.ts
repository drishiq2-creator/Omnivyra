/**
 * POST /api/auth/set-password outcome (S1, 2026-11-20; server contract from 89's
 * fix/security-read-failures-fail-closed-20261120).
 *
 * 200 { success: true, route, otherSessionsSignedOut: false, code: 'OTHER_SESSIONS_NOT_SIGNED_OUT' } means the
 * password changed but signing out the OTHER sessions failed. Keyed on `code` (b3), never on the absence of a flag,
 * so an older server (no code) behaves exactly as before.
 *
 * The notice's button calls POST /api/auth/sessions/revoke { revokeAll: true } via apiFetch (bearer; the session
 * cookie is already cleared). Live on main since #64/#65: revokeAll runs revokeAllAccessForUser (canonical sessions +
 * JWT epoch + refresh tokens) and ends the CURRENT session too, so "done" sends the user to sign in again.
 *
 * revokeAll, NOT revokeOthers, is structural (7c 2026-11-20): the JWT epoch is per-user and invalidates every token
 * issued before it, so there is no way to kill OTHER devices' bearer tokens while sparing this one. revokeOthers only
 * revokes canonical auth_sessions rows and would leave other devices' bearer tokens alive: the false assurance this
 * notice exists to prevent. So the button is "all devices", and its label says so BEFORE the user acts.
 * 2xx ignores `revoked: count`: count is auth_sessions only, and a 200 with count 0 still killed every bearer token.
 *
 * Mirrors the server's export in pages/api/auth/set-password.ts (a page must not import an API route module: it
 * would pull server code into the client bundle). The test pins the two together.
 */
export const OTHER_SESSIONS_NOT_SIGNED_OUT = 'OTHER_SESSIONS_NOT_SIGNED_OUT';

export function otherSessionsNotSignedOut(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as Record<string, unknown>).code === OTHER_SESSIONS_NOT_SIGNED_OUT;
}

export const OTHER_SESSIONS_NOTICE = "Your password changed, but we couldn't sign out your other devices.";
export const SIGN_OUT_OTHERS_LABEL = 'Sign out all devices, including this one';
export const SIGN_OUT_OTHERS_DONE = 'Your other devices are signed out. Sign in again to continue.';
/** A refusal (4xx): nothing was revoked. Point at the real control (pages/settings/security.tsx). */
export const SIGN_OUT_OTHERS_REFUSED =
  "We couldn't sign out your other devices. Sign in and use 'Sign out of all other sessions' in Settings → Security.";
/** Lost connection / 5xx: we don't know. Claim nothing; point at where the user can see their sessions. */
export const SIGN_OUT_OTHERS_UNKNOWN =
  "We're not sure your other devices were signed out. Sign in and check 'Active sessions' in Settings → Security.";

/** The outcome union AS A VALUE (b3 standard 2026-11-20); the type derives from it. */
export const SIGN_OUT_OTHERS_OUTCOMES = ['done', 'refused', 'unknown'] as const;
export type SignOutOthersOutcome = (typeof SIGN_OUT_OTHERS_OUTCOMES)[number];

/** Copy per outcome. Total by type; the test checks it against the union in both directions. */
export const SIGN_OUT_OTHERS_COPY: Record<SignOutOthersOutcome, string> = {
  done: SIGN_OUT_OTHERS_DONE,
  refused: SIGN_OUT_OTHERS_REFUSED,
  unknown: SIGN_OUT_OTHERS_UNKNOWN,
};

/**
 * status null = the request threw or timed out. apiFetch answers a lost connection with a non-2xx (503 today, 599
 * after #17).
 *   2xx -> done.
 *   4xx -> refused: revoke.ts answers 400/401/403 BEFORE revoking anything.
 *   anything else (null, 1xx, 3xx, 5xx, 599, an unexpected status) -> unknown. Only a 4xx proves nothing was revoked,
 *   so every other answer is the safe default: "not sure; check your sessions".
 */
export function classifySignOutOthers(status: number | null): SignOutOthersOutcome {
  if (status !== null && status >= 200 && status < 300) return 'done';
  if (status !== null && status >= 400 && status < 500) return 'refused';
  return 'unknown';
}

/** The revoke request stops waiting after this; a hang then reads as 'unknown', never as a stuck button. */
export const SIGN_OUT_OTHERS_TIMEOUT_MS = 30_000;
