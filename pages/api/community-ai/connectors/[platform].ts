import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireManageConnectors } from './utils';
import { revokeToken, getConnectorConnectedByUserId } from '../../../../backend/services/platformTokenService';
import { supabase } from '../../../../backend/db/supabaseClient';
import { disconnectSocialAccounts, type SocialAccountRow } from '../../../../backend/services/tenantCredentialDisconnect';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const platform = typeof req.query.platform === 'string' ? req.query.platform : '';
  const tenantId = typeof req.query.tenant_id === 'string' ? req.query.tenant_id : '';
  const organizationId = typeof req.query.organization_id === 'string' ? req.query.organization_id : '';

  if (!platform) {
    return res.status(400).json({ error: 'platform is required' });
  }
  if (!tenantId || !organizationId) {
    return res.status(400).json({ error: 'tenant_id and organization_id are required' });
  }

  const access = await requireManageConnectors(req, res, organizationId);
  if (!access) return;

  // G4.4 / G2.4: Disconnect allowed for Company Admin, Super Admin, OR connector owner
  const adminRoles = ['COMPANY_ADMIN', 'SUPER_ADMIN'];
  const isAdmin = adminRoles.includes(access.role);
  const connectedBy = await getConnectorConnectedByUserId(tenantId, organizationId, platform);
  const isOwner = connectedBy != null && connectedBy === access.userId;

  if (!isAdmin && !isOwner) {
    return res.status(403).json({
      error: 'FORBIDDEN_ROLE',
      message: 'Only Company Admin or the user who connected the account can disconnect.',
    });
  }

  try {
    // G5.5: Audit log
    console.info('[connector_audit]', JSON.stringify({ user_id: access.userId, company_id: organizationId, platform, action: 'disconnect' }));
    // R26 T-4: the tokens live in social_accounts (platformTokenService keeps metadata only). They belong to the
    // user who CONNECTED the account, which is not the caller when an admin disconnects someone else's connector,
    // so the owner's rows in THIS company are the target (the old deactivateSocialAccount used the caller's id and
    // only flipped is_active, keeping the encrypted tokens). Rows are wiped, revoked where supported, audited.
    const tokenOwner = connectedBy ?? access.userId;
    const key = platform.toLowerCase().trim();
    const aliases = key === 'x' || key === 'twitter' ? ['x', 'twitter'] : [key];
    const { data: rows, error: readErr } = await supabase
      .from('social_accounts')
      .select('id, platform, company_id, user_id')
      .eq('user_id', tokenOwner)
      .eq('company_id', organizationId)
      .in('platform', aliases)
      .eq('is_active', true);
    if (readErr) throw new Error(readErr.message);
    const outcomes = await disconnectSocialAccounts((rows ?? []) as SocialAccountRow[], {
      actorUserId: access.userId,
      companyId: organizationId,
      source: 'community-ai/connectors/disconnect',
    });
    // Integration review H-1: only a PROVEN wipe counts. Metadata goes last: if a wipe is unproven, the connector
    // still shows as connected and can be retried.
    const unproven = outcomes.filter((o) => !o.credentials_deleted);
    if (unproven.length) {
      return res.status(500).json({
        error: 'Disconnect incomplete: stored credentials could not be confirmed deleted. Try again.',
        code: 'CREDENTIALS_NOT_DELETED',
        credentials_deleted: false,
        failures: unproven.map((o) => ({ platform: o.platform, reason: o.credentials_reason ?? 'unknown' })),
      });
    }
    await revokeToken(tenantId, organizationId, platform);
    return res.status(200).json({
      success: true,
      message: 'Account disconnected',
      credentials_deleted: true,
      provider_revocation: outcomes.map((o) => ({ platform: o.platform, status: o.revocation.status })),
    });
  } catch (err: any) {
    console.error('[connectors/revoke]', err);
    return res.status(500).json({ error: 'Disconnect failed: the stored credentials could not be deleted. Try again.' });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/community-ai/connectors/:platform' });
