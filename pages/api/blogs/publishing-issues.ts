import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
/**
 * GET /api/blogs/publishing-issues?company_id=
 *
 * The company's dead-lettered CMS publishing jobs, one per blog, with the evidence an operator needs
 * to decide whether to retry (the CMS, the last attempt's answer and time, whether the post may
 * already be live). Company-scoped read; an unreadable queue (error object OR thrown) is 503 + Retry-After
 * PUBLISHING_ISSUES_UNREADABLE, never "no issues" (b3 standing rule, 2026-11-19); any other failure is a 500.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { enforceCompanyAccess } from '../../../backend/services/userContextService';
import { listPublishingIssues } from '../../../backend/services/publishingJobService';
import { PublishingStateUnreadableError } from '../../../backend/services/publishingStateUnreadable';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const companyId = typeof req.query.company_id === 'string' ? req.query.company_id : null;
  if (!companyId) return res.status(400).json({ error: 'company_id is required' });

  const access = await enforceCompanyAccess({ req, res, companyId });
  if (!access) return;

  try {
    const issues = await listPublishingIssues(companyId);
    return res.status(200).json({ issues });
  } catch (err) {
    console.error('[blogs/publishing-issues] read failed', err instanceof Error ? err.message : err);
    if (err instanceof PublishingStateUnreadableError) {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({
        code: 'PUBLISHING_ISSUES_UNREADABLE',
        error: "We couldn't check for publishing issues just now. This doesn't mean there are none - please try again.",
      });
    }
    return res.status(500).json({ error: 'Could not load publishing issues. Please try again.' });
  }
}

export default __createApiRoute(handler, { route: '/api/blogs/publishing-issues' });
