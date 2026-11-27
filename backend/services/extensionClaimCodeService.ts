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
 * Store (Phase E): Postgres via extensionHandshakeStore (migration 20270314000010), so a code minted on one
 * serverless instance redeems on any other, exactly once, within 60 s by the database clock. Only sha256(code) is
 * stored. The previous in-memory Map (per instance) is gone. Store errors throw
 * ExtensionHandshakeStoreUnavailableError - the routes answer 503, never "valid".
 */

import { randomBytes, createHmac } from 'crypto';
import { resolveSigningSecret } from '../auth/signingSecrets';
import { sha256Hex, storeIssueClaimCode, storeRedeemClaimCode } from './extensionHandshakeStore';

export type ClaimCode = {
  code: string;
  userId: string;
  orgId: string;
  createdAt: number;
  expiresAt: number;
};

export const CLAIM_CODE_TTL_SECONDS = 60;

const CLAIM_CODE_SHAPE = /^cc_[0-9a-f]{32}_[0-9a-f]{16}$/;

// SEC91-B1: same resolution as the extension session secret — dedicated secret, then
// AUTH_SECRET, else fail closed. The committed literal fallback is gone.
function getCodeSecret() {
  return resolveSigningSecret('extension claim codes', ['EXTENSION_SESSION_SECRET', 'AUTH_SECRET']);
}

export async function createClaimCode(userId: string, orgId: string): Promise<ClaimCode> {
  if (!userId || !orgId) throw new Error('createClaimCode: userId and orgId required');
  // Use a signed random string so guessing is infeasible.
  const random = randomBytes(16).toString('hex');
  const sig = createHmac('sha256', getCodeSecret()).update(`${userId}:${orgId}:${random}`).digest('hex').slice(0, 16);
  const code = `cc_${random}_${sig}`;
  const { createdAt, expiresAt } = await storeIssueClaimCode({
    codeHash: sha256Hex(code),
    userId,
    orgId,
    ttlSeconds: CLAIM_CODE_TTL_SECONDS,
  });
  return { code, userId, orgId, createdAt, expiresAt };
}

/**
 * Redeem a claim code. Single-use across every instance: once redeemed it cannot be used again even within its
 * TTL. Returns the bound userId/orgId if valid, null if malformed, expired, redeemed, or not found. Throws
 * ExtensionHandshakeStoreUnavailableError when the store cannot answer.
 */
export async function redeemClaimCode(code: string): Promise<{ userId: string; orgId: string } | null> {
  if (!code || !CLAIM_CODE_SHAPE.test(code)) return null; // never issued by us: no store round-trip
  return storeRedeemClaimCode(sha256Hex(code));
}
