import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';
/**
 * POST /api/prospects/:id/linkedin-message?companyId=<uuid>  body { text }
 *
 * "Message on LinkedIn" on a lead in Prospects (owner-approved 2026-11-22). Records ONE pending action in the
 * existing approved-actions workflow; it is sent only after a person approves it, only by the requesting user's own
 * Omnivyra Sales Navigator extension, only to a first-degree connection (checked in the browser at send time).
 *
 * Recipient and sender are resolved on the server (backend/services/linkedinNewDm/requestService.ts): the lead's
 * LinkedIn profile from its Sales Navigator evidence, the sender's linked LinkedIn account from the Sales Navigator
 * binding. Membership is verified against the companyId from the QUERY; nothing in the body chooses a tenant, a
 * recipient or a sender.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTenantAccess } from '../../../../backend/security/TenantGuard';
import { requestLinkedInNewDm } from '../../../../backend/services/linkedinNewDm/requestService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '').trim();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const companyId = one(req.query.companyId);
  if (!UUID.test(companyId)) return res.status(400).json({ error: 'companyId must be a uuid' });

  const tenant = await requireTenantAccess(req, res, companyId);
  if (!tenant) return;
  // The sender must be a member of this company with their own linked LinkedIn account; a platform bypass is not one.
  if (tenant.bypass) return res.status(403).json({ error: 'SENDER_NOT_A_MEMBER' });

  const prospectId = one(req.query.id);
  if (!UUID.test(prospectId)) return res.status(400).json({ error: 'prospect id must be a uuid' });

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { text?: unknown };
  const r = await requestLinkedInNewDm({ organizationId: companyId, userId: tenant.userId, prospectId, text: body.text });
  if (r.ok !== true) return res.status(r.status).json({ error: r.error });
  return res.status(201).json({
    actionId: r.actionId,
    status: 'awaiting_approval',
    recipientProfileUrl: r.recipientProfileUrl,
  });
}

export default __createApiRoute(handler, { route: '/api/prospects/[id]/linkedin-message' });
