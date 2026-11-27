import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
/**
 * POST /api/extension/redeem
 *
 * Called by the extension service worker with ONLY a claim code. Redeems
 * the one-time code and returns the session token + HMAC secret. No
 * Authorization header is required or honored on this endpoint — the
 * single-use claim code IS the authentication factor for this one call.
 *
 * Request: { claim_code, runtime_id?, product? }   product ∈ {'salesnav','linkedin_engagement'} or absent.
 *
 * Response shape (the extension worker consumes this directly):
 * {
 *   success: true,
 *   data: {
 *     session_token: string,
 *     hmac_secret:   string,
 *     user_id:       string,
 *     org_id:        string,
 *     expires_at:    number,       // epoch ms
 *     polling_interval: number,    // seconds
 *     sync_mode:     'batch',
 *     capability_map_version: string,
 *     product:       'salesnav' | 'linkedin_engagement' | null
 *   }
 * }
 *
 * PRODUCT (Phase E). The single-product packages send `product` (extension shared/product.js sessionProduct); the
 * combined source build and every build before the split send none. The Sales Navigator package treats
 * `data.product === 'salesnav'` as "this server filters the command hand-out by product" and only then polls
 * /api/extension/commands - so the echo is a promise, and it is kept: the product is bound into the SIGNED session
 * token, and /api/extension/commands hands a 'salesnav' session no engagement work.
 *   - allowlisted value  -> echoed and bound into the token;
 *   - absent / null / '' -> product: null, no binding: the legacy session, exactly as before (older engagement builds
 *                           never read the field; the combined build ignores it). Never 'salesnav' unless asked for.
 *   - anything else      -> 400 UNSUPPORTED_PRODUCT, checked BEFORE the code is consumed (the user can retry with a
 *                           correct client without minting a new code).
 *
 * PRODUCT IS A FILTER, NOT A SECURITY BOUNDARY (review N-3). The client chooses `product` at redeem time; the code is
 * bound only to (user, organization), so the same user + org can mint a session for either product. The binding
 * keeps one package from being handed the other package's work (the command hand-out filter); it does not stop a user
 * from deliberately asking for another product's session for their own account.
 *
 * ORDER (review S-4): everything that can refuse runs BEFORE the single-use code is consumed:
 *   1. shape + product checks (no store call);
 *   2. non-consuming lookup of the code's (user, org) (extension_claim_code_peek): unknown/expired/used -> 400;
 *   3. membership re-check (membership may have changed in the <= 60 s since bootstrap) -> 403 / 503 retryable;
 *   4. session token + HMAC secret minted for that (user, org) (a missing signing secret -> 503, code NOT consumed,
 *      so the retry is honest);
 *   5. the atomic redeem. Only after this point can a failure have consumed the code: those answers are
 *      non-retryable (retryable:false, repair_required:true): the user must start pairing again (a new code).
 * A store outage at 2-4 is 503 retryable:true - nothing was consumed. Any OTHER error thrown at 2-4 (the catch-all
 * 500 'redeem failed') is also retryable:true for the same reason: the code is consumed only at step 5 (review N-f).
 * An unknown, expired, malformed or already-used code answers 401 INVALID_OR_EXPIRED_CLAIM_CODE at step 2 and at
 * step 5 (the claim code is this route's credential; route-auth orderingVerifiers: peekClaimCode).
 * The extension worker (serviceWorker.js
 * redeemClaimCode) treats any non-2xx as REDEEM_FAILED and shows data.error; it never auto-retries, so the extra
 * fields are additive and compatible.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { peekClaimCode, redeemClaimCode } from '@/backend/services/extensionClaimCodeService';
import {
  issueExtensionSessionToken,
  deriveExtensionHmacSecret,
  generateHmacNonce,
  isExtensionProduct,
  type ExtensionProduct,
} from '@/backend/services/extensionSessionService';
import { checkExtensionMembership, extensionMembershipDeniedBody } from '@/backend/services/extensionMembershipService';
import { isExtensionHandshakeStoreUnavailable } from '@/backend/services/extensionHandshakeStore';
import { CAPABILITY_MAP_VERSION } from '@/backend/services/engagementCapabilityMap';
import { isSigningSecretUnavailable } from '@/backend/auth/signingSecrets';

/** undefined = no product requested (legacy); null = an unsupported value (refuse). */
function requestedProduct(raw: unknown): ExtensionProduct | undefined | null {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return isExtensionProduct(raw) ? raw : null;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
    claim_code?: string; claimCode?: string; runtime_id?: string; product?: unknown;
  };
  const claimCode = (body.claim_code ?? body.claimCode ?? '').toString().trim();
  if (!claimCode) {
    return res.status(400).json({ success: false, error: 'claim_code required' });
  }
  const product = requestedProduct(body.product);
  if (product === null) {
    return res.status(400).json({ success: false, error: 'UNSUPPORTED_PRODUCT' });
  }

  // 2-4: refusable checks, code NOT consumed (see ORDER above).
  let bound: { userId: string; orgId: string } | null;
  let sessionToken: string;
  let hmacSecret: string;
  let expiresAt: number;
  try {
    bound = await peekClaimCode(claimCode);
    if (!bound) {
      // 401: the claim code IS this route's credential (route-auth ordering verifier).
      return res.status(401).json({ success: false, error: 'INVALID_OR_EXPIRED_CLAIM_CODE' });
    }

    // Membership may have changed in the (<= 60 s) since bootstrap: no token for a principal validate would refuse.
    const membership = await checkExtensionMembership(bound.userId, bound.orgId);
    if (membership.ok === false) {
      if ((membership as { outcome: string }).outcome === 'unavailable') {
        return res.status(503).json({ success: false, error: 'TENANT_LOOKUP_ERROR', retryable: true });
      }
      return res.status(403).json(extensionMembershipDeniedBody(membership as { reason: string; platformAdminWithoutMembership?: true }));
    }

    expiresAt = Date.now() + 12 * 60 * 60 * 1000; // 12 h
    const hmacNonce = generateHmacNonce();
    // Session token carries the hmacNonce so every future request can
    // re-derive the secret server-side without DB lookup. Minted BEFORE the
    // redeem so a missing signing secret never burns the code.
    sessionToken = issueExtensionSessionToken({
      userId: bound.userId,
      orgId: bound.orgId,
      expiresAt,
      hmacNonce,
      ...(product ? { product } : {}),
    });
    hmacSecret = deriveExtensionHmacSecret({
      userId: bound.userId,
      orgId: bound.orgId,
      expiresAt,
      nonce: hmacNonce,
    });
  } catch (error) {
    console.error('[extension/redeem]', error);
    // SEC91-W2B-5: a missing signing secret is a service condition (503) with a plain
    // code; never echo the error text (it names configuration variables). Nothing consumed.
    if (isSigningSecretUnavailable(error)) {
      return res.status(503).json({ success: false, error: 'SIGNING_SECRET_UNAVAILABLE', retryable: true });
    }
    if (isExtensionHandshakeStoreUnavailable(error)) {
      return res.status(503).json({ success: false, error: 'CLAIM_STORE_UNAVAILABLE', retryable: true });
    }
    return res.status(500).json({ success: false, error: 'redeem failed', retryable: true });
  }

  // 5: the atomic, single-use redeem. From here a failure may have consumed the code.
  let claim: { userId: string; orgId: string } | null;
  try {
    claim = await redeemClaimCode(claimCode);
  } catch (error) {
    console.error('[extension/redeem] redeem step', error);
    // The UPDATE may have committed with its answer lost: a retry would most likely get
    // INVALID_OR_EXPIRED_CLAIM_CODE. Say so: not retryable, pair again.
    return res.status(503).json({
      success: false,
      error: 'CLAIM_REDEEM_UNCONFIRMED',
      retryable: false,
      repair_required: true,
    });
  }
  if (!claim) {
    // Redeemed or expired between the lookup and the redeem (a concurrent redeem won). 401: credential refused.
    return res.status(401).json({ success: false, error: 'INVALID_OR_EXPIRED_CLAIM_CODE' });
  }
  if (claim.userId !== bound.userId || claim.orgId !== bound.orgId) {
    // Cannot happen (a code's binding is immutable); refuse rather than hand out a token minted for someone else.
    console.error('[extension/redeem] binding changed between lookup and redeem');
    return res.status(409).json({ success: false, error: 'CLAIM_BINDING_MISMATCH', retryable: false, repair_required: true });
  }

  return res.status(200).json({
    success: true,
    data: {
      session_token: sessionToken,
      hmac_secret: hmacSecret,
      user_id: claim.userId,
      org_id: claim.orgId,
      expires_at: expiresAt,
      polling_interval: 60,
      sync_mode: 'batch',
      capability_map_version: CAPABILITY_MAP_VERSION,
      product: product ?? null,
    },
  });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/extension/redeem' });
