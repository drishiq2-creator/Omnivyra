import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';

/**
 * POST /api/engagement/thread/bulk-resolve
 * Mark selected threads resolved ("Mark resolved").
 * Body: thread_ids, organization_id
 *
 * E4 — resolve semantics (current persisted model, no schema change):
 *   The durable resolve marker is an `engagement_thread_events` row with
 *   event_type 'resolved' (created_at = when). The portal count definition
 *   (engagementPortalCountsService) and the Needs Response / People Reaction
 *   lists treat every inbound item at or before that time as handled; a newer
 *   inbound item re-opens the thread. There is no thread- or message-level
 *   status column to write instead (engagement_threads has only `ignored`,
 *   which is Ignore, a different decision).
 *
 *   The marker is therefore written FIRST and its failure fails the request —
 *   previously it was best-effort after the opportunity update, so a "resolved"
 *   thread could silently stay in Needs Response. The thread's open
 *   engagement_opportunities are still closed (resolved, resolved_at) as before.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { enforceCompanyAccess } from '../../../../backend/services/userContextService';
import { supabase } from '../../../../backend/db/supabaseClient';
import { recordThreadEvents } from '../../../../backend/services/engagementThreadEventService';

const MAX_BATCH = 20;

type Body = {
  thread_ids?: string[];
  organization_id?: string;
};

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = (req.body || {}) as Body;
    const rawThreadIds = Array.isArray(body.thread_ids)
      ? body.thread_ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
    if (rawThreadIds.length === 0) {
      return res.status(400).json({ error: 'thread_ids required' });
    }
    const threadIds = rawThreadIds.slice(0, MAX_BATCH);

    // E4 review #4: the company is resolved on the SERVER from the persisted
    // threads (engagement_threads.organization_id), never taken from the body.
    // A body organization_id is accepted only as an assertion: if it differs
    // from the resolved company the request is refused. The access check on
    // the resolved company is kept.
    const { data: threads, error: threadsErr } = await supabase
      .from('engagement_threads')
      .select('id, organization_id')
      .in('id', threadIds);

    // A failed ownership read is not "none of these threads are yours".
    if (threadsErr || !Array.isArray(threads)) {
      console.warn('[engagement/thread/bulk-resolve] thread read failed:', threadsErr?.message);
      return res.status(500).json({ error: 'Failed to resolve threads', code: 'THREAD_READ_FAILED' });
    }
    const companies = Array.from(
      new Set(
        (threads as Array<{ organization_id: string | null }>)
          .map((t) => t.organization_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );
    if (companies.length === 0) {
      return res.status(404).json({ error: 'Thread not found', code: 'THREAD_NOT_FOUND' });
    }
    if (companies.length > 1) {
      return res.status(400).json({ error: 'thread_ids span more than one company', code: 'MIXED_COMPANIES' });
    }
    const organizationId = companies[0];
    const assertedOrg = typeof body.organization_id === 'string' ? body.organization_id.trim() : '';
    if (assertedOrg && assertedOrg !== organizationId) {
      return res.status(403).json({ error: 'Access denied', code: 'COMPANY_MISMATCH' });
    }

    const access = await enforceCompanyAccess({ req, res, companyId: organizationId });
    if (!access) return;

    const validIds = new Set(
      (threads as Array<{ id: string; organization_id: string | null }>)
        .filter((t) => t.organization_id === organizationId)
        .map((t) => t.id),
    );
    const toResolve = threadIds.filter((id) => validIds.has(id));

    if (toResolve.length === 0) {
      return res.status(200).json({ success: true, resolved: 0 });
    }

    try {
      await recordThreadEvents({
        organizationId,
        threadIds: toResolve,
        actorUserId: access.userId,
        eventType: 'resolved',
      });
    } catch (eventErr) {
      console.warn('[engagement/thread/bulk-resolve] resolve marker write failed:', (eventErr as Error)?.message);
      return res.status(500).json({ error: 'Failed to resolve threads', code: 'RESOLVE_NOT_RECORDED' });
    }

    const { error: updateErr } = await supabase
      .from('engagement_opportunities')
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
      })
      .eq('organization_id', organizationId)
      .in('source_thread_id', toResolve);

    if (updateErr) {
      // The threads ARE resolved (marker written); only the opportunity
      // bookkeeping failed. Say exactly that instead of claiming nothing happened.
      console.warn('[engagement/thread/bulk-resolve]', updateErr.message);
      return res.status(500).json({
        error: 'Threads were resolved but their opportunities could not be closed',
        code: 'OPPORTUNITY_UPDATE_FAILED',
        resolved: toResolve.length,
        resolve_recorded: true,
      });
    }

    return res.status(200).json({ success: true, resolved: toResolve.length });
  } catch (err) {
    const msg = (err as Error)?.message ?? 'Failed';
    console.error('[engagement/thread/bulk-resolve]', msg);
    return res.status(500).json({ error: msg });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/engagement/thread/bulk-resolve' });
