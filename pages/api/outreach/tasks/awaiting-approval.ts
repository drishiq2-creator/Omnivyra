import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';
/**
 * GET /api/outreach/tasks/awaiting-approval?companyId=<id>&limit=<n>
 *
 * The outreach approval QUEUE for one company (a9, 2026-11-20; Audit §2 "Outbound approval": "No tenant approval route
 * or queue"). READ ONLY - approving stays a separate act (POST /api/super-admin/outreach/approve today).
 *
 * WHO (requireTenantAccess, the canonical tenant seam - backend/security/TenantGuard.ts): an ACTIVE COMPANY_ADMIN /
 * SUPER_ADMIN / ADMIN member of the NAMED company, or a platform super-admin acting on that explicitly named company.
 * Bridge principals are refused by the guard. Designed for both audiences (b3): the super-admin Outreach screen today,
 * a company-admin queue when tenant approval authority is decided. The companyId is never trusted as authorization -
 * the guard validates it against live membership - and every row is filtered by it.
 *
 * READ FAILURE: 503 { code: OUTREACH_TASKS_UNREADABLE } + Retry-After - never an empty queue.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTenantAccess } from '../../../../backend/security/TenantGuard';
import { listTasksAwaitingApproval, APPROVAL_QUEUE_DEFAULT_LIMIT } from '../../../../backend/services/leadOutreachExecution/approvalQueue';

const QUEUE_ROLES = ['COMPANY_ADMIN', 'SUPER_ADMIN', 'ADMIN'] as const;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const companyId = typeof req.query.companyId === 'string' && req.query.companyId.trim() ? req.query.companyId.trim() : null;
  if (!companyId) return res.status(400).json({ error: 'companyId is required' });

  const tenant = await requireTenantAccess(req, res, companyId, { requireRoleIn: QUEUE_ROLES });
  if (!tenant) return;

  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : APPROVAL_QUEUE_DEFAULT_LIMIT;

  const result = await listTasksAwaitingApproval(companyId, { limit });
  if (result.ok === false) {
    console.warn('[outreach/tasks/awaiting-approval] outreach_tasks unreadable', result.message);
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: 'The approval queue could not be read', code: result.code });
  }
  return res.status(200).json({ companyId, items: result.items, truncated: result.truncated });
}

export default __createApiRoute(handler, { route: '/api/outreach/tasks/awaiting-approval' });
