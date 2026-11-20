/**
 * Codes the self-service REVOKE routes put on a 409 (04, 2026-11-20; b3/7c). One module imported by the routes AND the
 * Settings → Security client, so the two cannot drift.
 *
 * 409 used to carry no code and two OPPOSITE meanings: passkeys/revoke.ts answered 409 both for "Already revoked" (the
 * end state the user asked for) and for "Credential could not be revoked" (a race OR a real failure; its comment says
 * "re-fetch to confirm state"). The client cannot tell those apart from the status, so the server now says which.
 */
export const REVOKE_CODES = ['ALREADY_REVOKED', 'REVOKE_UNCONFIRMED'] as const;
export type RevokeCode = (typeof REVOKE_CODES)[number];

/** The target was already revoked before this request: the end state the user asked for. */
export const ALREADY_REVOKED: RevokeCode = 'ALREADY_REVOKED';
/** The revoke write did not report success (a lost race or a real failure): re-fetch to learn the state. */
export const REVOKE_UNCONFIRMED: RevokeCode = 'REVOKE_UNCONFIRMED';
