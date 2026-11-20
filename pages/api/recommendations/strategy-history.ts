import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
import { NextApiRequest, NextApiResponse } from 'next';
import { enforceCompanyAccess } from '../../../backend/services/userContextService';
import { withRBAC } from '../../../backend/middleware/withRBAC';
import { Role } from '../../../backend/services/rbacService';
import { getStrategyHistoryForCompany, STRATEGY_HISTORY_UNAVAILABLE } from '../../../backend/services/strategyHistoryService';

/**
 * GET /api/recommendations/strategy-history?companyId=...
 * Returns strategy memory: aspect usage and underused areas for the company.
 * Used to guide recommendations (continuation vs expansion) without changing ranking.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const companyId = typeof req.query.companyId === 'string' ? req.query.companyId.trim() : '';
  if (!companyId) {
    return res.status(400).json({ error: 'companyId is required' });
  }

  const access = await enforceCompanyAccess({
    req,
    res,
    companyId,
    requireCampaignId: false,
  });
  if (!access) return;

  try {
    const result = await getStrategyHistoryForCompany(companyId);
    return res.status(200).json(result);
  } catch (e) {
    // A failed read is NOT an empty history (b3 2026-11-20, read-failure rule): retryable 503 with a distinct code.
    console.warn('strategy-history error', e);
    res.setHeader('Retry-After', '5');
    return res.status(503).json({
      code: STRATEGY_HISTORY_UNAVAILABLE,
      error: 'Strategy history could not be loaded. Try again.',
    });
  }
}

export default __createApiRoute(withRBAC(handler, [Role.COMPANY_ADMIN, Role.CONTENT_CREATOR]), { route: '/api/recommendations/strategy-history' });
