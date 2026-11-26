import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { enforceCompanyAccess } from '../../../backend/services/userContextService';
import { enforceRole, Role } from '../../../backend/services/rbacService';
import {
  buildOutboundCrmReport,
  syncToCrm,
  type OutboundCrmProvider,
  type OutboundCrmEvent,
  type OutboundSyncStatus,
} from '../../../backend/services/intelligence/outboundCrmSyncService';

const VALID: OutboundCrmProvider[] = ['hubspot', 'salesforce', 'zoho', 'webhook_only'];
const EVENTS: OutboundCrmEvent[] = ['create', 'update', 'stage_change', 'closed_won'];

/**
 * HTTP status per sync outcome. `unknown` is 409 (not 5xx): the request may
 * already have been delivered, so it must not read as "failed, try again";
 * a repeat returns `unknown` again until an operator resolves it.
 */
const STATUS_CODE: Record<OutboundSyncStatus, number> = {
  synced: 200,
  deduped: 200,
  not_configured: 503,
  refused: 422,
  failed: 500,
  unknown: 409,
};

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId =
    typeof req.query.company_id === 'string' ? req.query.company_id :
    typeof req.body?.company_id === 'string' ? req.body.company_id : null;
  if (!companyId) return res.status(400).json({ error: 'company_id is required' });
  const access = await enforceCompanyAccess({ req, res, companyId });
  if (!access) return;
  const roleGate = await enforceRole({ req, res, companyId, allowedRoles: [Role.COMPANY_ADMIN, Role.SUPER_ADMIN] });
  if (!roleGate) return;

  if (req.method === 'GET') {
    try { return res.status(200).json(await buildOutboundCrmReport(companyId)); }
    catch { return res.status(500).json({ error: 'Failed to build outbound CRM report' }); }
  }
  if (req.method === 'POST') {
    const provider = req.body?.provider as string | undefined;
    if (!provider || !(VALID as string[]).includes(provider)) {
      return res.status(400).json({ error: `provider must be one of: ${VALID.join(', ')}` });
    }
    // Destinations and credentials are tenant-owned server-side state only.
    if (req.body && typeof req.body === 'object' && ['credentials', 'webhook_url', 'instance_url', 'access_token'].some((k) => k in req.body)) {
      return res.status(400).json({ error: 'credentials and destination overrides are not accepted' });
    }
    const leadId = typeof req.body?.lead_id === 'string' ? req.body.lead_id : null;
    const event = typeof req.body?.event === 'string' ? req.body.event : null;
    const payload = typeof req.body?.payload === 'object' && req.body.payload !== null && !Array.isArray(req.body.payload) ? req.body.payload : null;
    if (!leadId || !event || !payload) return res.status(400).json({ error: 'lead_id, event, and payload are required' });
    if (!(EVENTS as string[]).includes(event)) {
      return res.status(400).json({ error: 'event must be one of: create, update, stage_change, closed_won' });
    }
    try {
      const result = await syncToCrm({
        companyId,
        provider: provider as OutboundCrmProvider,
        leadId,
        event: event as OutboundCrmEvent,
        payload: payload as Record<string, unknown>,
        actor: { userId: roleGate.userId ?? access.userId ?? null },
      });
      return res.status(STATUS_CODE[result.status] ?? 500).json(result);
    } catch {
      return res.status(500).json({ error: 'Outbound CRM sync failed' });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/website-intelligence/outbound-crm-sync' });
