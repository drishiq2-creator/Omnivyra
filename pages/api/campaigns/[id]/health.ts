import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';

/**
 * GET /api/campaigns/[id]/health
 * Returns persisted report_json only. No fallback reconstruction.
 * If older than 24h (evaluated_at), triggers background refresh.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { tenantTable, tenantContextFor, TenantSeamError } from '../../../../backend/db/tenantTable';
import { seamDenial, SEAM_RETRY_AFTER_SECONDS } from '../../../../backend/db/seamDenial';
import { resolveCampaignOwnership } from '../../../../backend/services/campaignOwnershipService';
import { enforceCompanyAccess } from '../../../../backend/services/userContextService';
import { evaluateAndPersistCampaignHealth } from '../../../../backend/jobs/campaignHealthEvaluationJob';

const HEALTH_TTL_MS = 24 * 60 * 60 * 1000;

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

    const access = await enforceCompanyAccess({
      req,
      res,
      companyId,
      campaignId,
      requireCampaignId: false,
    });
    if (!access) return;

    // S2 tenant seam: the tenant is the owner resolveCampaignOwnership derived and enforceCompanyAccess just
    // authorized for this principal.
    let healthRead: { data: any; error: any };
    try {
      healthRead = await tenantTable('campaign_health_reports', tenantContextFor(access, companyId))
        .select('report_json, evaluated_at, created_at')
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    } catch (err) {
      if (err instanceof TenantSeamError) return seamDenial(res, err, 404, { error: 'Campaign not found' });
      throw err;
    }
    const { data: row, error } = healthRead;

    if (error) {
      console.error('[campaigns/health]', error);
      return res.status(500).json({ error: 'Failed to fetch campaign health' });
    }

    const evalAt = row?.evaluated_at ?? row?.created_at;
    const isStale = evalAt && (Date.now() - new Date(evalAt as string).getTime() > HEALTH_TTL_MS);
    if (isStale && companyId) {
      evaluateAndPersistCampaignHealth(campaignId, companyId).catch((e) =>
        console.warn('[campaigns/health] TTL refresh failed:', e)
      );
    }

    const reportJson = row?.report_json as Record<string, unknown> | null | undefined;
    if (!reportJson || typeof reportJson !== 'object') {
      return res.status(404).json({
        error: 'No health report',
        message: 'No persisted report_json. Save or update the campaign plan to generate one.',
      });
    }

    return res.status(200).json(reportJson);
  } catch (err) {
    console.error('[campaigns/health]', err);
    return res.status(500).json({
      error: 'Failed to fetch campaign health',
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/campaigns/:id/health' });
