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
 * Phase E also: the claim store is shared across instances (atomic single use; 503 when unreadable), and the
 * extension membership rule is re-checked after redemption, before any token exists.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { redeemClaimCode } from '@/backend/services/extensionClaimCodeService';
import {
  issueExtensionSessionToken,
  deriveExtensionHmacSecret,
  generateHmacNonce,
  isExtensionProduct,
  type ExtensionProduct,
} from '@/backend/services/extensionSessionService';
import { checkExtensionMembership } from '@/backend/services/extensionMembershipService';
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

  try {
    const claim = await redeemClaimCode(claimCode);
    if (!claim) {
      return res.status(400).json({ success: false, error: 'INVALID_OR_EXPIRED_CLAIM_CODE' });
    }

    // Membership may have changed in the (<= 60 s) since bootstrap: no token for a principal validate would refuse.
    const membership = await checkExtensionMembership(claim.userId, claim.orgId);
    if (membership.ok === false) {
      if ((membership as { outcome: string }).outcome === 'unavailable') {
        return res.status(503).json({ success: false, error: 'TENANT_LOOKUP_ERROR', retryable: true });
      }
      return res.status(403).json({ success: false, error: 'EXTENSION_MEMBERSHIP_REQUIRED' });
    }

    const expiresAt = Date.now() + 12 * 60 * 60 * 1000; // 12 h
    const hmacNonce = generateHmacNonce();

    // Session token carries the hmacNonce so every future request can
    // re-derive the secret server-side without DB lookup.
    const sessionToken = issueExtensionSessionToken({
      userId: claim.userId,
      orgId: claim.orgId,
      expiresAt,
      hmacNonce,
      ...(product ? { product } : {}),
    });

    const hmacSecret = deriveExtensionHmacSecret({
      userId: claim.userId,
      orgId: claim.orgId,
      expiresAt,
      nonce: hmacNonce,
    });

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
  } catch (error) {
    console.error('[extension/redeem]', error);
    // SEC91-W2B-5: a missing signing secret is a service condition (503) with a plain
    // code; never echo the error text (it names configuration variables).
    if (isSigningSecretUnavailable(error)) {
      return res.status(503).json({ success: false, error: 'SIGNING_SECRET_UNAVAILABLE' });
    }
    if (isExtensionHandshakeStoreUnavailable(error)) {
      return res.status(503).json({ success: false, error: 'CLAIM_STORE_UNAVAILABLE', retryable: true });
    }
    return res.status(500).json({ success: false, error: 'redeem failed' });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/extension/redeem' });
