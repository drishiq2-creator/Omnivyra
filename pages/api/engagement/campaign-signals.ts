import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';

/**
 * GET /api/engagement/campaign-signals
 * SYSTEM 2: Campaign Activity Engagement Signals — signals from campaign_activity_engagement_signals.
 * Used by: engagement-inbox page, activity-workspace Community Responses tab.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { enforceCompanyAccess } from '../../../backend/services/userContextService';
import { supabase } from '../../../backend/db/supabaseClient';
import { tenantTable, tenantContextFor } from '../../../backend/db/tenantTable';

const SIGNAL_TYPES = ['comment', 'reply', 'mention', 'quote', 'discussion', 'buyer_intent_signal'];
const PLATFORMS = ['linkedin', 'twitter', 'x', 'discord', 'slack', 'reddit', 'github'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const companyId = (req.query.companyId ?? req.query.company_id) as string | undefined;
  const campaignId = (req.query.campaignId ?? req.query.campaign_id) as string | undefined;
  const activityId = (req.query.activityId ?? req.query.activity_id) as string | undefined;
  const platform = (req.query.platform as string)?.trim().toLowerCase();
  const signalType = (req.query.signalType ?? req.query.signal_type) as string;
  const dateFrom = (req.query.dateFrom ?? req.query.date_range_from) as string | undefined;
  const dateTo = (req.query.dateTo ?? req.query.date_range_to) as string | undefined;

  if (!companyId?.trim()) {
    return res.status(400).json({ error: 'companyId is required' });
  }

  try {
    const access = await enforceCompanyAccess({
      req,
      res,
      companyId: companyId.trim(),
      campaignId: campaignId || undefined,
      requireCampaignId: false,
    });
    if (!access) return;
    // S2 tenant seam: campaign_versions is read through tenantTable under the company the gate just AUTHORIZED (the
    // trimmed id it received), never the raw query string. A non-uuid id throws TENANT_CONTEXT_MISSING -> 500 below.
    const versions = tenantTable('campaign_versions', tenantContextFor(access, companyId.trim()));

    let query = supabase
      .from('campaign_activity_engagement_signals')
      .select('id, campaign_id, activity_id, platform, author, content, signal_type, conversation_url, engagement_score, detected_at, signal_status')
      .order('engagement_score', { ascending: false })
      .order('detected_at', { ascending: false })
      .limit(200);

    if (campaignId) {
      // S2-55: enforceCompanyAccess allows a campaignId that matches NO campaign, and signal rows of a deleted
      // campaign survive, so campaign_id alone could return another company's orphaned signals. Scope it the way the
      // no-campaign branch below does: only a campaign the company's own campaign_versions name is read; any other
      // id answers the empty list (no existence oracle).
      const { data: owned, error: ownedError } = await versions
        .select('campaign_id')
        .eq('campaign_id', campaignId)
        .limit(1)
        .maybeSingle();
      if (ownedError) {
        console.warn('[engagement/campaign-signals] campaign scope', ownedError.message);
        return res.status(500).json({ error: 'Failed to fetch campaign signals' });
      }
      if (!owned) return res.status(200).json({ signals: [] });
      query = query.eq('campaign_id', campaignId);
    }
    if (activityId) query = query.eq('activity_id', activityId);
    if (platform && PLATFORMS.includes(platform)) {
      query = query.eq('platform', platform === 'x' ? 'twitter' : platform);
    }
    if (signalType && SIGNAL_TYPES.includes(signalType)) {
      query = query.eq('signal_type', signalType);
    }
    if (dateFrom) query = query.gte('detected_at', dateFrom);
    if (dateTo) {
      // dateTo may be a full ISO timestamp (e.g. 2026-07-02T03:46:52.884Z from the inbox)
      // or a bare date (2026-07-02). Only append end-of-day to a bare date — appending it
      // to a full timestamp produced "...ZT23:59:59.999Z" → Postgres "time zone not
      // recognized" → 500 (the inbox never loaded signals).
      const dateToBound = dateTo.includes('T') ? dateTo : `${dateTo}T23:59:59.999Z`;
      query = query.lte('detected_at', dateToBound);
    }

    // S2-55: also when only an activityId is given - activity_id alone is not scoped to any company either.
    if (!campaignId) {
      const { data: ownVersions } = await versions
        .select('campaign_id')
        .limit(500);
      const campaignIds = (ownVersions ?? []).map((v: { campaign_id: string }) => v.campaign_id).filter(Boolean);
      if (campaignIds.length > 0) {
        query = query.in('campaign_id', campaignIds);
      } else {
        return res.status(200).json({ signals: [] });
      }
    }

    const { data, error } = await query;

    if (error) {
      if (error.code === '42P01') {
        return res.status(200).json({ signals: [] });
      }
      console.warn('[engagement/campaign-signals]', error.message);
      return res.status(500).json({ error: 'Failed to fetch campaign signals' });
    }

    const signals = (data ?? []).map((row: Record<string, unknown>) => ({
      id: row.id,
      campaign_id: row.campaign_id,
      activity_id: row.activity_id,
      platform: row.platform,
      author: row.author ?? null,
      content: row.content ?? null,
      signal_type: row.signal_type,
      conversation_url: row.conversation_url ?? null,
      engagement_score: Number(row.engagement_score) ?? 0,
      detected_at: row.detected_at,
      signal_status: row.signal_status ?? 'new',
    }));

    return res.status(200).json({ signals });
  } catch (err) {
    console.error('[engagement/campaign-signals]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/engagement/campaign-signals' });
