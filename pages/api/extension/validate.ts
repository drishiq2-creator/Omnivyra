import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireExtensionAuth } from '@/backend/middleware/extensionAuthMiddleware';
import { withExtensionRawBody } from '@/backend/middleware/extensionRawBody';
import { checkExtensionMembership } from '@/backend/services/extensionMembershipService';

type SuccessResponse = {
  success: true;
  data: {
    valid: true;
    user_id: string;
    org_id: string;
    sync_mode: 'batch';
    polling_interval: number;
  };
  timestamp: number;
};

type ErrorResponse = {
  success: false;
  error: string;
  timestamp: number;
};

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<SuccessResponse | ErrorResponse>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed', timestamp: Date.now() });
  }

  const auth = await requireExtensionAuth(req, res);
  if (!auth) return;
  const { session } = auth;

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  const requestedOrgId = String(body.orgId || body.organization_id || body.organizationId || '').trim();

  // Session token (HMAC-verified) is authoritative for orgId. The body field
  // is only used to assert the client's view matches the session — if the
  // client omits it, fall back to the session's pinned orgId rather than
  // 400-ing a request that's otherwise valid.
  const effectiveOrgId = requestedOrgId || session.orgId;

  if (requestedOrgId && session.orgId !== requestedOrgId) {
    return res.status(403).json({ success: false, error: 'Extension session organization mismatch', timestamp: Date.now() });
  }

  // In dev-bypass mode the middleware uses a sentinel userId that has no
  // user_company_roles row by design — the bypass IS the trust signal.
  // Skip the role check so validation succeeds and the extension can
  // start polling. Production paths still run the check below.
  const isBypassSession = session.userId === '00000000-0000-4000-8000-000000000001';

  if (!isBypassSession) {
    // Item F: requireExtensionAuth already applied this rule for (session user, session org) and answered the same
    // 403 body; effectiveOrgId equals session.orgId here (a mismatch was refused above), so this is a backstop.
    // Phase E: the ONE extension membership rule (also applied at bootstrap and redeem): an active
    // user_company_roles row AND an active company. The 403 body text is load-bearing: the extension's
    // core/authBridge.js VALIDATE_DEAD_403 maps exactly 'Access denied to organization' to ORG_ACCESS_REVOKED.
    const membership = await checkExtensionMembership(session.userId, effectiveOrgId);
    if (membership.ok === false) {
      if ((membership as { outcome: string }).outcome === 'unavailable') {
        // Transient: never a denial (the extension keeps its session on a non-403 failure).
        return res.status(503).json({ success: false, error: 'Failed to validate organization access', timestamp: Date.now() });
      }
      return res.status(403).json({ success: false, error: 'Access denied to organization', timestamp: Date.now() });
    }
  }

  return res.status(200).json({
    success: true,
    data: {
      valid: true,
      user_id: session.userId,
      org_id: effectiveOrgId,
      sync_mode: 'batch',
      polling_interval: 60,
    },
    timestamp: Date.now(),
  });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
// Phase E: the extension request signature covers the RAW body bytes - Next must not consume the stream;
// withExtensionRawBody captures them and parses req.body exactly as the default parser did.
export const config = { api: { bodyParser: false } };
export default __createApiRoute(withExtensionRawBody(handler), { route: '/api/extension/validate' });
