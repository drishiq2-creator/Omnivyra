import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { generateCampaignStrategy } from '../../../backend/services/campaignRecommendationService';
import {
  saveCampaignVersion,
  saveTrendSnapshot,
  saveWeekVersions,
} from '../../../backend/db/campaignVersionStore';
import { saveCampaignBlueprintFromRecommendation } from '../../../backend/db/campaignPlanStore';
import {
  fromRecommendationPlan,
  blueprintWeekToLegacyWeekPlan,
} from '../../../backend/services/campaignBlueprintAdapter';
import { validateCapacityAndFrequency } from '../../../backend/services/capacityFrequencyValidationGateway';
import { getCampaignPlanningInputs } from '../../../backend/services/campaignPlanningInputsService';
import { enforceCompanyAccess } from '../../../backend/services/userContextService';
import { tenantContextFor, TenantSeamError, type TenantContext } from '../../../backend/db/tenantTable';
import { seamDenial } from '../../../backend/db/seamDenial';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      companyId,
      campaignId,
      campaignObjective,
      durationWeeks,
      contentCapabilities,
      platformRules,
      resourceConstraints,
    } = req.body || {};
    // ROUTE-AUTH-001: this route spends LLM budget and writes the campaign's
    // blueprint and versions under companyId. Authorize the company, and bind
    // the campaign to it when one is sent (404 for a foreign campaign).
    const ctx = await enforceCompanyAccess({ req, res, companyId, campaignId: campaignId || null });
    if (!ctx) return;
    // S2-55: the tenant is the company enforceCompanyAccess just authorized for ctx.userId. enforceCompanyAccess
    // allows a campaignId that matches NO campaign, so the campaign-keyed planning-inputs read and the
    // campaign_week_plan / campaign_resource_projection writes below are scoped to this company, never keyed on the
    // campaign id alone.
    let tenant: TenantContext;
    try {
      tenant = tenantContextFor(ctx, String(companyId));
    } catch (err) {
      if (err instanceof TenantSeamError) return seamDenial(res, err, 404, { error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
      throw err;
    }
    const result = await generateCampaignStrategy({
      companyId,
      objective: campaignObjective,
      durationWeeks,
      contentCapabilities,
      platformRules,
      resourceConstraints,
    });

    if (result.status === 'ready' && result.campaign && companyId) {
      const rawWeeklyPlan = result.weekly_plan ?? [];
      const blueprint = fromRecommendationPlan(rawWeeklyPlan, campaignId ?? '');
      const derivedWeeklyPlan = blueprint.weeks.map((w) => blueprintWeekToLegacyWeekPlan(w));

      if (blueprint.weeks.length > 0) {
        const planningInputs = await getCampaignPlanningInputs(campaignId ?? '', tenant);
        const validationResult = validateCapacityAndFrequency({
          weekly_capacity: planningInputs?.weekly_capacity,
          available_content: planningInputs?.available_content,
          exclusive_campaigns: planningInputs?.exclusive_campaigns,
          cross_platform_sharing: (planningInputs as any)?.cross_platform_sharing,
          blueprint,
        });
        if (
          validationResult &&
          validationResult.status === 'invalid' &&
          !validationResult.override_confirmed
        ) {
          return res.status(400).json({
            error: 'Capacity validation failed',
            validation_result: validationResult,
            result,
          });
        }
        // The seam refuses (TenantSeamError -> the catch below -> 404) unless campaignId is this company's own
        // campaigns row: the plan is never inserted under a missing or foreign campaign.
        await saveCampaignBlueprintFromRecommendation({
          campaignId: campaignId ?? '',
          companyId,
          blueprint,
          tenant,
        });
      }

      await saveCampaignVersion({
        companyId,
        campaignId,
        campaignSnapshot: {
          campaign: result.campaign,
          weekly_plan: derivedWeeklyPlan,
          daily_plan: result.daily_plan,
          trend_alerts: result.trend_alerts,
          schedule_hints: result.schedule_hints,
          omnivyra: result.omnivyra,
        },
        status: 'proposed',
        version: 1,
      });
      console.debug('Campaign strategy version created with status=proposed (blueprint-first)');

      if (derivedWeeklyPlan.length > 0) {
        await saveWeekVersions({ companyId, campaignId, weeks: derivedWeeklyPlan });
      }

      if (result.trend_alerts) {
        await saveTrendSnapshot({ companyId, campaignId, snapshot: result.trend_alerts });
      }
    }

    return res.status(200).json(result);
  } catch (error: any) {
    if (error instanceof TenantSeamError) return seamDenial(res, error, 404, { error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
    return res.status(500).json({ error: error?.message || 'Failed to validate company profile' });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/campaigns/recommendations' });
