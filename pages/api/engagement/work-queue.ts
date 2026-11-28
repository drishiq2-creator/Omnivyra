import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';

/**
 * GET /api/engagement/work-queue
 * Returns the daily work queue: actionable items per platform.
 *
 * E4: the numbers come from the same single definition as
 * /api/engagement/platform-counts (computeEngagementPortalCounts); this route
 * only reshapes them into the legacy work-queue envelope. A read failure is
 * 503 ENGAGEMENT_COUNTS_UNAVAILABLE, never a zero queue.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveUserContext, enforceCompanyAccess } from '../../../backend/services/userContextService';
import {
  computeEngagementPortalCounts,
  PortalCountsUnavailableError,
} from '../../../backend/services/engagementPortalCountsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const user = await resolveUserContext(req);
    const rawOrg = req.query.organization_id ?? req.query.organizationId ?? user?.defaultCompanyId;
    const organizationId = (Array.isArray(rawOrg) ? rawOrg[0] : rawOrg) as string | undefined;

    if (!organizationId) {
      return res.status(400).json({ error: 'organization_id or organizationId required' });
    }

    const access = await enforceCompanyAccess({ req, res, companyId: organizationId });
    if (!access) return;

    const result = await computeEngagementPortalCounts(organizationId);
    return res.status(200).json({
      definition: result.definition,
      total_actionable_threads: result.totals.actionable_items,
      platforms: Object.entries(result.platforms).map(([platform, c]) => ({
        platform,
        actionable_threads: c.actionable_items,
        high_priority_threads: c.high_priority,
        unread_messages: c.actionable_items,
      })),
    });
  } catch (err) {
    if (err instanceof PortalCountsUnavailableError) {
      console.error('[engagement/work-queue]', err.message);
      return res.status(503).json({ error: 'Engagement work queue is unavailable right now.', code: err.code });
    }
    const msg = (err as Error)?.message ?? 'Failed to fetch work queue';
    console.error('[engagement/work-queue]', msg);
    return res.status(500).json({ error: msg });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/engagement/work-queue' });
