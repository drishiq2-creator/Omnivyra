import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
/**
 * POST /api/extension/bootstrap
 *
 * Called by the web app (with the user's authenticated cookie-based
 * Supabase session). Creates a short-lived single-use claim code bound to
 * the current user + organization. The web app forwards ONLY this code to
 * the extension via postMessage — never the session token itself.
 *
 * The extension service worker then calls POST /api/extension/redeem with
 * the claim code to fetch the real session token + HMAC secret.
 *
 * Phase E: after enforceCompanyAccess (authentication + the web app's access rules), the EXTENSION membership rule
 * (backend/services/extensionMembershipService.ts - the one validate and redeem apply) must also hold, so a
 * principal the extension routes would refuse (platform super admin with no role row in this company, legacy
 * fallback principals) is refused HERE with EXTENSION_MEMBERSHIP_REQUIRED, before any code exists. The code is
 * stored in the shared handshake store (any instance can redeem it); a store failure is a 503.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { enforceCompanyAccess } from '@/backend/services/userContextService';
import { createClaimCode } from '@/backend/services/extensionClaimCodeService';
import { checkExtensionMembership } from '@/backend/services/extensionMembershipService';
import { isExtensionHandshakeStoreUnavailable } from '@/backend/services/extensionHandshakeStore';
import { isSigningSecretUnavailable } from '@/backend/auth/signingSecrets';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const body = (req.body || {}) as { organization_id?: string; organizationId?: string; companyId?: string };
  const organizationId = (body.organization_id ?? body.organizationId ?? body.companyId ?? '').toString().trim();
  if (!organizationId) {
    return res.status(400).json({ success: false, error: 'organization_id required' });
  }

  try {
    const access = await enforceCompanyAccess({ req, res, companyId: organizationId, requireCampaignId: false });
    if (!access) return;

    const membership = await checkExtensionMembership(access.userId, organizationId);
    if (membership.ok === false) {
      if ((membership as { outcome: string }).outcome === 'unavailable') {
        return res.status(503).json({ success: false, error: 'TENANT_LOOKUP_ERROR', retryable: true });
      }
      return res.status(403).json({
        success: false,
        error: 'EXTENSION_MEMBERSHIP_REQUIRED',
        message: 'The browser extension needs an active membership in this company.',
      });
    }

    const claim = await createClaimCode(access.userId, organizationId);
    return res.status(200).json({
      success: true,
      data: {
        claim_code: claim.code,
        expires_at: claim.expiresAt,
        ttl_ms: claim.expiresAt - claim.createdAt,
      },
    });
  } catch (error) {
    console.error('[extension/bootstrap]', error);
    // SEC91-W2B-5: a missing signing secret is a service condition (503) with a plain
    // code; never echo the error text (it names configuration variables).
    if (isSigningSecretUnavailable(error)) {
      return res.status(503).json({ success: false, error: 'SIGNING_SECRET_UNAVAILABLE' });
    }
    if (isExtensionHandshakeStoreUnavailable(error)) {
      return res.status(503).json({ success: false, error: 'CLAIM_STORE_UNAVAILABLE', retryable: true });
    }
    return res.status(500).json({ success: false, error: 'bootstrap failed' });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/extension/bootstrap' });
