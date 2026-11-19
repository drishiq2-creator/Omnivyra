/**
 * c6 2026-11-19 (b3 / a9 finding on free-credits grant): ONE Idempotency-Key per LOGICAL grant, held until that grant
 * is known to have succeeded. The server (super-admin/free-credits/grant) resolves a repeat of a key to the SAME grant,
 * but that only protects a re-send that carries the SAME key. Minting a fresh key per click meant a lost or failed
 * response, followed by the admin re-submitting the same form, granted the credits TWICE.
 *
 * keyFor(payload): the same key for as long as the payload is unchanged and no success was recorded; a changed payload
 * is a different grant (new key). settle(): call ONLY on a confirmed success - the next submit is a new grant.
 */
export interface LogicalGrantKey {
  keyFor(payload: unknown): string;
  settle(): void;
}

export function createLogicalGrantKey(mint: () => string = defaultMint): LogicalGrantKey {
  let held: { sig: string; key: string } | null = null;
  return {
    keyFor(payload: unknown): string {
      const sig = JSON.stringify(payload);
      if (!held || held.sig !== sig) held = { sig, key: mint() };
      return held.key;
    },
    settle(): void {
      held = null;
    },
  };
}

function defaultMint(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
