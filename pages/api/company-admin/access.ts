import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
/**
 * GET /api/company-admin/access?company_id=  — "may I open the admin-only pages for this company?"
 *
 * Answered by the SAME gate the admin-only APIs use (requireCompanyAdmin), so the page's decision and the APIs'
 * decision cannot drift. 200 { admin: true } | 403 COMPANY_ADMIN_REQUIRED (member) | 403 non-member | 401.
 * The pages use it to render "Only company admins can manage this" instead of a page of failed panels; every API
 * behind those pages still enforces the gate itself.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { enforceCompanyAccess } from '../../../backend/services/userContextService';
import { requireCompanyAdmin } from '../../../backend/services/companyAdminGate';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const companyId = typeof req.query.company_id === 'string' ? req.query.company_id : null;
  if (!companyId) return res.status(400).json({ error: 'company_id is required' });
  const access = await enforceCompanyAccess({ req, res, companyId });
  if (!access) return;
  if (!(await requireCompanyAdmin({ req, res, companyId }))) return;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ admin: true });
}

export default __createApiRoute(handler, { route: '/api/company-admin/access' });
