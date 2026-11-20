/**
 * Settings → Security action outcomes (04, 2026-11-20; b3 ruling (ii), security). Same mapping as S1
 * (lib/auth/setPasswordOutcome.ts).
 *
 * Before: every action did `if (!r.ok) throw new Error(\`Revoke failed: ${r.status}\`)` and showed that raw text. A 5xx
 * or lost response on a REVOKE does not prove nothing was revoked, so "Revoke failed: 503" could be false, and raw
 * status text leaked to the user. The section loaders showed `Request failed: <status> <server body>`.
 *
 * Now:
 *   done    - 2xx.
 *   refused - a 4xx: the server answered and did NOT make the change. EXCEPT 409 on a revoke (below).
 *   unknown - no answer, 1xx/3xx/5xx, the request threw (incl. a cancelled step-up), or a 409 on a REVOKE: we cannot
 *             say. NEVER "failed". 409 is overloaded by the server: passkeys/revoke.ts answers 409 both for "Already
 *             revoked" (the end state) and for "Credential could not be revoked" (a race OR a real failure; its own
 *             comment says "re-fetch to confirm state"). So the client re-reads instead of concluding (7c, 2026-11-20).
 *             The routes now tag each 409 with a code (shared/security/revokeCodes.ts): ALREADY_REVOKED is done;
 *             REVOKE_UNCONFIRMED, or a 409 with no code, is unknown (b3 2026-11-20).
 * Every attempt RE-READS the list afterwards, so the screen shows the true current state whatever the outcome.
 */

import { ALREADY_REVOKED } from '../../shared/security/revokeCodes';

/** devices/trust.ts 409 code (backend/security/devices/trustedDeviceTypes.ts). */
export const DEVICE_ALREADY_TRUSTED = 'ALREADY_TRUSTED';

/** The outcome union AS A VALUE (b3 standard); the type derives from it. */
export const SECURITY_ACTION_OUTCOMES = ['done', 'refused', 'unknown'] as const;
export type SecurityActionOutcome = (typeof SECURITY_ACTION_OUTCOMES)[number];

export const SECURITY_ACTION_KINDS = [
  'passkey_revoke', 'totp_revoke', 'recovery_regenerate', 'device_trust', 'device_revoke', 'session_revoke', 'sessions_revoke_others',
] as const;
export type SecurityActionKind = (typeof SECURITY_ACTION_KINDS)[number];

const REVOKE_KINDS: ReadonlySet<SecurityActionKind> = new Set<SecurityActionKind>([
  'passkey_revoke', 'totp_revoke', 'device_revoke', 'session_revoke', 'sessions_revoke_others',
]);

/** `status` null = no answer (the request threw or step-up was cancelled). `code` = the response body's `code`, if any. */
export function classifySecurityAction(kind: SecurityActionKind, status: number | null, code?: string | null): SecurityActionOutcome {
  if (status !== null && status >= 200 && status < 300) return 'done';
  if (status === 409 && REVOKE_KINDS.has(kind)) return code === ALREADY_REVOKED ? 'done' : 'unknown';
  // Trust's 409 is unambiguous: devices/trust.ts sends it ONLY with code ALREADY_TRUSTED (the state the user asked for,
  // 7c 2026-11-20). Any other 409 on trust stays refused.
  if (status === 409 && kind === 'device_trust' && code === DEVICE_ALREADY_TRUSTED) return 'done';
  if (status !== null && status >= 400 && status < 500) return 'refused';
  return 'unknown';
}

const AFTER = ' The list below shows the current state.';

/** Copy for the two non-done outcomes, per action. Total by type; the test checks it covers both unions. */
export const SECURITY_ACTION_COPY: Record<SecurityActionKind, Record<Exclude<SecurityActionOutcome, 'done'>, string>> = {
  passkey_revoke: {
    refused: "We couldn't remove this passkey." + AFTER,
    unknown: "We couldn't confirm whether this passkey was removed." + AFTER,
  },
  totp_revoke: {
    refused: "We couldn't turn off your authenticator app." + AFTER,
    unknown: "We couldn't confirm whether your authenticator app was turned off." + AFTER,
  },
  recovery_regenerate: {
    refused: "We couldn't create new recovery codes. Your current codes still work.",
    // A lost answer may mean new codes WERE created (and the old ones revoked) but never shown. Say so.
    unknown:
      "We couldn't confirm whether new recovery codes were created. If they were, your previous codes no longer work and the new ones weren't shown, so generate a fresh set.",
  },
  device_trust: {
    refused: "We couldn't trust this browser." + AFTER,
    unknown: "We couldn't confirm whether this browser was trusted." + AFTER,
  },
  device_revoke: {
    refused: "We couldn't remove this device." + AFTER,
    unknown: "We couldn't confirm whether this device was removed." + AFTER,
  },
  session_revoke: {
    refused: "We couldn't sign out this session." + AFTER,
    unknown: "We couldn't confirm whether this session was signed out." + AFTER,
  },
  sessions_revoke_others: {
    refused: "We couldn't sign out your other sessions." + AFTER,
    unknown: "We couldn't confirm whether your other sessions were signed out." + AFTER,
  },
};

/** A section's data could not be loaded. Raw status and body go to the console, never to the screen. */
export function loadFailedCopy(what: string): string {
  return `We couldn't load your ${what}. Please try again.`;
}
