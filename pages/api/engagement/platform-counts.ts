import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';

/**
 * GET /api/engagement/platform-counts
 *
 * E4: serves THE portal count definition (engagement-portal-counts.v1, see
 * backend/services/engagementPortalCountsService.ts) for every platform at
 * once. The tab badges and header totals of /engagement read this; nothing is
 * recomputed in the browser.
 *
 * Company scope: the company is the one named in the query (the portal's
 * selected company) or the caller's default company, and it must pass
 * enforceCompanyAccess. A request body is never read.
 *
 * Read failure: 503 { code: 'ENGAGEMENT_COUNTS_UNAVAILABLE' } with NO counts —
 * a count we could not compute is unknown, never 0.
 *
 * Response:
 *   counts[platform]   — { needs_response, people_reaction, actionable_items,
 *                          high_priority } plus the legacy hook fields
 *                          (thread_count = unread_count = actionable_items).
 *   totals             — the same four numbers across all platforms.
 *   handled_threads    — thread_id → ISO time (see queueRules.isHandledByServer).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveUserContext, enforceCompanyAccess } from '../../../backend/services/userContextService';
import {
  computeEngagementPortalCounts,
  PortalCountsUnavailableError,
} from '../../../backend/services/engagementPortalCountsService';

function firstQueryValue(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const user = await resolveUserContext(req);
    const organizationId =
      firstQueryValue(req.query.organization_id)
      ?? firstQueryValue(req.query.organizationId)
      ?? firstQueryValue(user?.defaultCompanyId);

    if (!organizationId) {
      return res.status(400).json({ error: 'organization_id or organizationId required' });
    }

    const access = await enforceCompanyAccess({ req, res, companyId: organizationId });
    if (!access) return;

    const result = await computeEngagementPortalCounts(organizationId);
    const counts: Record<string, Record<string, unknown>> = {};
    for (const [platform, c] of Object.entries(result.platforms)) {
      counts[platform] = {
        ...c,
        // Legacy usePlatformCounts shape; same number, one definition.
        thread_count: c.actionable_items,
        unread_count: c.actionable_items,
        max_priority_tier: c.high_priority > 0 ? 'high' : 'low',
      };
    }
    return res.status(200).json({
      definition: result.definition,
      window_days: result.window_days,
      computed_at: result.computed_at,
      counts,
      totals: result.totals,
      handled_threads: result.handled_threads,
    });
  } catch (err) {
    if (err instanceof PortalCountsUnavailableError) {
      console.error('[engagement/platform-counts]', err.message);
      return res.status(503).json({ error: 'Engagement counts are unavailable right now.', code: err.code });
    }
    const msg = (err as Error)?.message ?? 'Failed to fetch platform counts';
    console.error('[engagement/platform-counts]', msg);
    return res.status(500).json({ error: msg });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/engagement/platform-counts' });
