import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { enforceCompanyAccess } from '../../../backend/services/userContextService';
import { enforceRole, Role } from '../../../backend/services/rbacService';
import { WebsiteSetupReadError, createWebsiteFromSetup, getOrCreateWebsiteSetup, markWebsiteSetupStep, type WebsiteSetupStep } from '../../../backend/services/websiteSetupService';
import { WebsiteAlreadyExistsError } from '../../../backend/services/websiteService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId =
    typeof req.query.company_id === 'string' ? req.query.company_id :
    typeof req.body?.company_id === 'string' ? req.body.company_id : null;
  if (!companyId) return res.status(400).json({ error: 'company_id is required' });
  const access = await enforceCompanyAccess({ req, res, companyId });
  if (!access) return;

  if (req.method === 'GET') {
    try {
      const result = await getOrCreateWebsiteSetup({
        companyId,
        websiteId: typeof req.query.website_id === 'string' ? req.query.website_id : null,
      });
      return res.status(200).json(result);
    } catch (err) {
      // A failed read is never 200 { website: null } (= "brand-new site" to the wizard). State only.
      if (err instanceof WebsiteSetupReadError) {
        return res.status(503).json({ code: 'WEBSITE_SETUP_UNAVAILABLE', error: 'Website setup could not be loaded.' });
      }
      throw err;
    }
  }

  const roleGate = await enforceRole({ req, res, companyId, allowedRoles: [Role.COMPANY_ADMIN, Role.SUPER_ADMIN] });
  if (!roleGate) return;

  if (req.method === 'POST') {
    if (req.body?.action === 'create_website') {
      const { name, canonical_url, cms_provider } = req.body || {};
      if (!name || !canonical_url) return res.status(400).json({ error: 'name and canonical_url are required' });
      try {
        const result = await createWebsiteFromSetup({
          companyId,
          userId: roleGate.userId,
          name: String(name),
          canonicalUrl: String(canonical_url),
          cmsProvider: typeof cms_provider === 'string' ? cms_provider : null,
        });
        return res.status(201).json(result);
      } catch (err) {
        // uq_websites_company_canonical_url_active: this company already has a live website at this address.
        // State only (no retry advice); the client decides what to show.
        if (err instanceof WebsiteAlreadyExistsError) {
          return res.status(409).json({ code: 'WEBSITE_ALREADY_EXISTS', error: 'This company already has a website set up at this address.' });
        }
        throw err;
      }
    }

    const websiteId = typeof req.body?.website_id === 'string' ? req.body.website_id : null;
    const step = typeof req.body?.step === 'string' ? req.body.step as WebsiteSetupStep : null;
    if (!websiteId || !step) return res.status(400).json({ error: 'website_id and step are required' });
    const progress = await markWebsiteSetupStep({
      companyId,
      websiteId,
      step,
      state: typeof req.body?.state === 'object' && req.body.state !== null ? req.body.state : {},
      error: typeof req.body?.error === 'string' ? req.body.error : null,
    });
    return res.status(200).json({ progress });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/websites/setup' });
