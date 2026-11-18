import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
import { NextApiRequest, NextApiResponse } from 'next';
import { fromStructuredPlan } from '../../../backend/services/campaignBlueprintAdapter';
import { saveDraftBlueprint } from '../../../backend/db/campaignPlanStore';
import { requireCampaignTenantAccess } from '../../../backend/security/TenantGuard';
import { tenantContextFor, TenantSeamError } from '../../../backend/db/tenantTable';
import { seamDenial } from '../../../backend/db/seamDenial';

/**
 * POST /api/campaigns/save-draft-plan
 * Saves structured plan as draft (same table as committed; status=draft).
 * Used by "Save for Later" when user has a structured plan.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { campaignId, structuredPlan } = req.body;

    if (!campaignId || !structuredPlan?.weeks?.length) {
      return res.status(400).json({
        error: 'campaignId and structuredPlan.weeks are required',
      });
    }

    const access = await requireCampaignTenantAccess(req, res, campaignId);
    if (!access) return;

    const blueprint = fromStructuredPlan({
      weeks: structuredPlan.weeks,
      campaign_id: campaignId,
    });

    // S2-55 (7c): the tenant is the company requireCampaignTenantAccess resolved and authorized for this principal.
    await saveDraftBlueprint({ campaignId, blueprint, tenant: tenantContextFor({ userId: access.userId }, access.organizationId) });

    return res.status(200).json({
      success: true,
      message: 'Draft plan saved',
    });
  } catch (error) {
    if (error instanceof TenantSeamError) return seamDenial(res, error, 404, { error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
    console.error('Error in save-draft-plan:', error);
    return res.status(500).json({
      error: 'Failed to save draft plan',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/campaigns/save-draft-plan' });
