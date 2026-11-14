import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
/**
 * GET/POST /api/cron/subscription-monthly-allocation
 *
 * Monthly sweep that allocates recurring subscription FREE credits for each plan-assigned org.
 * Delegates to subscriptionAllocationService.runMonthlyAllocationSweep — idempotent per
 * (org, plan, billing period) and gated by canReceiveSubscriptionCredits (ACTIVE/TRIALING only).
 * Cron-only wiring; no balance/ordering logic changes here.
 *
 * Auth: CRON_SECRET bearer OR super-admin session OR SUPER_ADMIN role.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSupabaseUserFromRequest } from '../../../backend/services/supabaseAuthService';
import { isPlatformSuperAdmin } from '../../../backend/services/rbacService';
import { runMonthlyAllocationSweep } from '../../../backend/services/subscriptionAllocationService';
import { runJob } from '../../../backend/services/jobRunner';
import { getLegacySuperAdminSession } from '@/backend/services/superAdminSession';
import { bearerTokenMatches } from '../../../backend/security/constantTimeEqual';

/** UTC calendar day (YYYY-MM-DD) - the runJob idempotency unit for this cron. Exported for tests. */
export function allocationRunDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function isAuthorized(req: NextApiRequest): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && bearerTokenMatches(req.headers.authorization, cronSecret)) return true;
  if (getLegacySuperAdminSession(req) !== null) return true;
  const { user, error } = await getSupabaseUserFromRequest(req);
  if (!error && user?.id && await isPlatformSuperAdmin(user.id)) return true;
  return false;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await isAuthorized(req))) return res.status(403).json({ error: 'NOT_AUTHORIZED' });

  const triggeredByCronSecret = bearerTokenMatches(req.headers.authorization, process.env.CRON_SECRET);
  const dryRun = req.query.dryRun === 'true';
  // Per-DAY run key (e9, 2026-11-14; was a ~30-day window). The job now runs DAILY, and runJob dead-letter-skips every
  // later run that reuses a DLQ'd key - with a monthly key ONE failed run locked out the rest of the period and paying
  // orgs missed their credits. Granting stays idempotent per (org, plan, period), so daily keys never double-grant.
  const runDay = allocationRunDay(new Date());

  const outcome = await runJob(
    {
      jobName: 'cron:subscription-monthly-allocation',
      triggerSource: triggeredByCronSecret ? 'cron' : 'admin',
      tenantId: null,
      principalKind: triggeredByCronSecret ? 'cron-secret' : 'super-admin',
      idempotencyKey: `cron:subscription-monthly-allocation:${runDay}`,
    },
    async () => runMonthlyAllocationSweep({ dryRun }),
  );

  if (outcome.status === 'completed') {
    // B1b: an incomplete sweep is VISIBLE (non-2xx) but the job itself completed - never DLQ'd, so the next run in the
    // period re-attempts the undecided orgs (allocation is idempotent per org/plan/period).
    if (outcome.result.incomplete) {
      return res.status(503).json({ ok: false, code: 'ALLOCATION_INCOMPLETE', summary: outcome.result, executionId: outcome.ctx.executionId, dryRun });
    }
    return res.status(200).json({ ok: true, summary: outcome.result, executionId: outcome.ctx.executionId, dryRun });
  }
  if (outcome.status === 'dead_letter_skip') return res.status(202).json({ ok: false, code: 'DEAD_LETTER_SKIP', reason: outcome.reason });
  return res.status(500).json({ ok: false, error: outcome.status === 'failed' && outcome.error instanceof Error ? outcome.error.message : String(outcome.status) });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/cron/subscription-monthly-allocation' });
