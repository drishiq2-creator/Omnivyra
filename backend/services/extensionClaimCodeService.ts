/**
 * EXTENSION CLAIM-CODE SERVICE
 *
 * The web app creates a short-lived, one-time claim code while the user is
 * authenticated in their browser session. The extension's service worker
 * redeems the code directly against the backend to receive its session
 * token + HMAC secret.
 *
 * Design choice: the extension never receives a token forwarded by the web
 * page via postMessage. Only the claim code crosses the page↔extension
 * boundary, and it is single-use and unsigned — knowing the code is
 * useless unless you are the extension SW redeeming over HTTPS inside the
 * same 60s window.
 *
 * Store (2026-11-22): the shared table public.extension_claim_codes
 * (migration 20270222000000). The previous in-memory Map was per server
 * process, so on the multi-instance production deployment a code created by
 * one instance was "INVALID_OR_EXPIRED" on the instance that redeemed it.
 * Only sha256(code) is stored. Redemption is ONE conditional UPDATE
 * (redeemed_at IS NULL AND expires_at > now) RETURNING — single use under
 * concurrency, no read-then-write.
 *
 * product (owner 2026-11-22, two LinkedIn extensions): the extension the page
 * asked for ('linkedin_engagement' | 'salesnav'), or null for a page built
 * before the split. A redemption that declares the other product does not
 * match the row and is refused like an unknown code.
 */

import { randomBytes, createHmac, createHash } from 'crypto';
import { resolveSigningSecret } from '../auth/signingSecrets';
import { ownedDbTable } from '../db/writeOwner';

export const EXTENSION_PRODUCTS = ['linkedin_engagement', 'salesnav'] as const;
export type ExtensionProduct = (typeof EXTENSION_PRODUCTS)[number];

export function isExtensionProduct(value: unknown): value is ExtensionProduct {
  return typeof value === 'string' && (EXTENSION_PRODUCTS as readonly string[]).includes(value);
}

const TABLE = 'extension_claim_codes';
const CLAIM_CODE_TTL_MS = 60 * 1000; // 60 seconds
const RETENTION_MS = 24 * 60 * 60 * 1000; // rows older than a day are deleted opportunistically
const CODE_SHAPE = /^cc_[0-9a-f]{32}_[0-9a-f]{16}$/;

export type ClaimCode = {
  code: string;
  userId: string;
  orgId: string;
  product: ExtensionProduct | null;
  createdAt: number;
  expiresAt: number;
};

export interface ClaimStoreDeps {
  readonly table?: (name: string) => any;
  readonly now?: () => number;
}

/** The store could not be written or read: a service condition (503), never "invalid code". */
export class ClaimStoreUnavailableError extends Error {
  constructor() { super('CLAIM_STORE_UNAVAILABLE'); this.name = 'ClaimStoreUnavailableError'; }
}

// SEC91-B1: same resolution as the extension session secret — dedicated secret, then
// AUTH_SECRET, else fail closed. The committed literal fallback is gone.
function getCodeSecret() {
  return resolveSigningSecret('extension claim codes', ['EXTENSION_SESSION_SECRET', 'AUTH_SECRET']);
}

function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Create a one-time code for (user, organization, product). Throws
 * SigningSecretUnavailable (no secret: nothing is stored) or
 * ClaimStoreUnavailableError (the shared store refused the write).
 */
export async function createClaimCode(
  userId: string, orgId: string, product: ExtensionProduct | null = null, deps: ClaimStoreDeps = {},
): Promise<ClaimCode> {
  if (!userId || !orgId) throw new Error('createClaimCode: userId and orgId required');
  if (product !== null && !isExtensionProduct(product)) throw new Error('createClaimCode: unknown product');
  // Use a signed random string so guessing is infeasible.
  const random = randomBytes(16).toString('hex');
  const sig = createHmac('sha256', getCodeSecret()).update(`${userId}:${orgId}:${random}`).digest('hex').slice(0, 16);
  const code = `cc_${random}_${sig}`;
  const now = (deps.now ?? Date.now)();
  const claim: ClaimCode = { code, userId, orgId, product, createdAt: now, expiresAt: now + CLAIM_CODE_TTL_MS };
  const table = deps.table ?? ownedDbTable;

  let result: { error?: unknown } | null = null;
  try {
    result = await table(TABLE).insert({
      code_hash: hashCode(code),
      organization_id: orgId,
      user_id: userId,
      product,
      created_at: new Date(claim.createdAt).toISOString(),
      expires_at: new Date(claim.expiresAt).toISOString(),
    });
  } catch {
    throw new ClaimStoreUnavailableError();
  }
  if (!result || result.error) throw new ClaimStoreUnavailableError();

  // Housekeeping, never awaited and never fatal: a failed clean-up changes nothing for this code.
  void Promise.resolve()
    .then(() => table(TABLE).delete().lt('created_at', new Date(now - RETENTION_MS).toISOString()))
    .catch(() => undefined);

  return claim;
}

/**
 * Redeem a claim code. Single-use: once redeemed it cannot be used again
 * even within its TTL. Returns the bound user/org/product when valid, null when
 * unknown, expired, already redeemed or issued for the other product, and
 * 'unavailable' when the store could not answer (a read failure is not "invalid").
 */
export async function redeemClaimCode(
  code: string, opts: { product?: ExtensionProduct | null } = {}, deps: ClaimStoreDeps = {},
): Promise<{ userId: string; orgId: string; product: ExtensionProduct | null } | null | 'unavailable'> {
  if (!code || !CODE_SHAPE.test(code)) return null;
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  const table = deps.table ?? ownedDbTable;

  let q = table(TABLE)
    .update({ redeemed_at: nowIso })
    .eq('code_hash', hashCode(code))
    .is('redeemed_at', null)
    .gt('expires_at', nowIso);
  // An extension that declares its product may only take a code issued for it (or a pre-split page's code).
  // An extension that declares NO product (built before the split) may only take a pre-split page's code: a code the
  // page issued FOR a product (e.g. Sales Navigator) is never redeemable by it (review finding 4). Legacy engagement
  // installs keep working - the engagement page issues codes without a product.
  q = opts.product ? q.or(`product.is.null,product.eq.${opts.product}`) : q.is('product', null);

  let result: { data?: unknown; error?: unknown };
  try {
    result = await q.select('user_id, organization_id, product');
  } catch {
    return 'unavailable';
  }
  if (result.error || !Array.isArray(result.data)) return 'unavailable';
  const row = result.data[0] as { user_id?: unknown; organization_id?: unknown; product?: unknown } | undefined;
  if (!row) return null;
  if (typeof row.user_id !== 'string' || typeof row.organization_id !== 'string') return 'unavailable';
  return {
    userId: row.user_id,
    orgId: row.organization_id,
    product: isExtensionProduct(row.product) ? row.product : null,
  };
}
