import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';

/**
 * GET /api/campaigns/[id]/strategic-insights
 * Aggregates Campaign Health, Engagement Health, Trend Signals, Inbox Signals
 * to generate CMO-level strategic insights.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { SEAM_RETRY_AFTER_SECONDS } from '../../../../backend/db/seamDenial';
import { getTrendSnapshots } from '../../../../backend/db/campaignVersionStore';
import { getDecisionReportView } from '../../../../backend/services/decisionReportService';
import { requireCompanyContext } from '../../../../backend/services/companyContextGuardService';
import { resolveCampaignOwnership } from '../../../../backend/services/campaignOwnershipService';
import { runInApiReadContext } from '../../../../backend/services/intelligenceExecutionContext';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Campaign ID required' });
  }
  const campaignId = id;

  try {
    // SEC91 A8 / 3AH-113: the owner is the canonical resolver's answer over EVERY owner record (campaigns.company_id
    // plus every campaign_versions row); never one version row, never a caller-supplied ?companyId=.
    // Mapping copied from pages/api/campaigns/[id].ts and approve-strategy.ts: a failed lookup is a retryable 503;
    // CONFLICT, UNOWNED and NOT_FOUND all answer one 404 (no existence oracle).
    const ownership = await resolveCampaignOwnership(campaignId);
    if (ownership.status === 'LOOKUP_FAILED') {
      res.setHeader('Retry-After', String(SEAM_RETRY_AFTER_SECONDS));
      return res.status(503).json({
        error: 'Campaign ownership check is temporarily unavailable. Please try again.',
        code: 'CAMPAIGN_LOOKUP_ERROR',
        retryable: true,
      });
    }
    if (ownership.status === 'INVALID') {
      return res.status(400).json({ error: 'Campaign ID required' });
    }
    if (ownership.status !== 'OWNED') {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const companyId = ownership.companyId;
    const companyContext = await requireCompanyContext({
      req,
      res,
      companyId,
      campaignId,
      requireCampaignId: false,
    });
    if (!companyContext) return;

    const reportView = await runInApiReadContext('campaignStrategicInsightsApi', async () =>
      getDecisionReportView({
        companyId: companyContext.companyId,
        reportTier: 'growth',
        entityType: 'campaign',
        entityId: campaignId,
        sourceService: 'strategicInsightService',
      })
    );

    return res.status(200).json(reportView);
  } catch (err) {
    console.error('[campaigns/strategic-insights]', err);
    return res.status(500).json({
      error: 'Failed to generate strategic insights',
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/campaigns/:id/strategic-insights' });
