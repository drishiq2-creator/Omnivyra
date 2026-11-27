import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { enforceCompanyAccess } from '../../../backend/services/userContextService';
import { enforceRole, Role } from '../../../backend/services/rbacService';
import { INTEGRATIONS_UNAVAILABLE } from '../../../shared/integrations/integrationsReadCodes';
import {
  createIntegration,
  getIntegrations,
  IntegrationType,
  IntegrationValidationError,
  toPublicIntegration,
} from '../../../backend/services/integrationService';

const ALLOWED_TYPES: IntegrationType[] = [
  'lead_webhook',
  'wordpress',
  'custom_blog_api',
  'ghost',
  'drupal',
  'joomla',
  'webflow',
  'shopify',
  'hubspot',
  'wix',
  'squarespace',
];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId =
    typeof req.query.company_id === 'string' ? req.query.company_id :
    typeof req.body?.company_id === 'string' ? req.body.company_id : null;

  if (!companyId) return res.status(400).json({ error: 'company_id is required' });

  const access = await enforceCompanyAccess({ req, res, companyId });
  if (!access) return;

  // GET — any company member can list integrations
  if (req.method === 'GET') {
    const type = typeof req.query.type === 'string' ? req.query.type as IntegrationType : undefined;
    // A failed read is NOT "no integrations" (Rule 1): it used to be `.catch(() => [])`, a 200 with an empty list.
    let integrations: Awaited<ReturnType<typeof getIntegrations>>;
    try {
      integrations = await getIntegrations(companyId, type);
    } catch (err) {
      console.error('[api/integrations] read failed', { company_id: companyId, message: err instanceof Error ? err.message : String(err) });
      return res.status(503).json({ error: "Couldn't load integrations.", code: INTEGRATIONS_UNAVAILABLE });
    }
    // R26 T-2: hydrated integrations carry DECRYPTED credentials, and no role is shown them, admins and SUPER_ADMIN
    // included. `secret_fields_set` says which secrets are stored; `secrets_visible` is kept (always false) for
    // clients that still read it.
    return res.status(200).json({
      integrations: integrations.map(toPublicIntegration),
      secrets_visible: false,
    });
  }

  // POST — only admins can create
  if (req.method === 'POST') {
    const roleGate = await enforceRole({
      req, res, companyId,
      allowedRoles: [Role.COMPANY_ADMIN, Role.SUPER_ADMIN],
    });
    if (!roleGate) return;

    const { type, name, config, website_id } = req.body || {};
    if (!type || !ALLOWED_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${ALLOWED_TYPES.join(', ')}` });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'config object is required' });
    }

    try {
      const integration = await createIntegration(companyId, roleGate.userId, type, name.trim(), config, {
        websiteId: typeof website_id === 'string' && website_id.trim() ? website_id.trim() : null,
      });
      return res.status(201).json({ integration: toPublicIntegration(integration) });
    } catch (err) {
      if (err instanceof IntegrationValidationError) return res.status(400).json({ error: err.message });
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create integration' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/integrations' });
