/**
 * Owner decision 2026-11-22: 'blocked' actions are listed and counted as such - never hidden, never counted as
 * pending or failed. CONTROL: the other buckets keep their rows.
 */
type Row = Record<string, any>;
const ORG = 'org-1';
const rows: Row[] = [
  { id: 'p1', status: 'pending' }, { id: 'e1', status: 'executed' }, { id: 'f1', status: 'failed' },
  { id: 's1', status: 'skipped' }, { id: 'b1', status: 'blocked', execution_result: { error: { code: 'PLAN_LIMIT_EXCEEDED' } } },
].map((r) => ({ tenant_id: ORG, organization_id: ORG, platform: 'linkedin', action_type: 'reply', target_id: 't', risk_level: 'low', ...r }));

const supabaseDouble = {
  from: (t: string) => {
    const data = t === 'community_ai_actions' ? rows : [];
    const q: any = {
      select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q, gte: () => q, is: () => q, insert: () => q,
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data, error: null }).then(ok, bad),
    };
    return q;
  },
};
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../db/supabaseClient', () => ({ supabase: supabaseDouble }));
jest.mock('../../../pages/api/community-ai/utils', () => ({
  requireTenantScope: async () => ({ organizationId: ORG, tenantId: ORG }),
  enforceActionRole: async () => ({ userId: 'u1', role: 'COMPANY_ADMIN' }),
  resolveActionRole: () => 'COMPANY_ADMIN',
}));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAiBulk: async () => undefined }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: async () => undefined }));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: async () => undefined }));

import listRoute from '../../../pages/api/community-ai/actions';
import metricsRoute from '../../../pages/api/community-ai/metrics';

async function get(route: any) {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  await route({ method: 'GET', headers: {}, query: { tenant_id: ORG, organization_id: ORG }, body: {} }, res);
  return res;
}

beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());

it('the actions list returns blocked actions in their own list, with the stored reason; other lists unchanged', async () => {
  const res = await get(listRoute);
  expect(res.statusCode).toBe(200);
  const ids = (k: string) => (res.body[k] || []).map((a: Row) => a.action_id ?? a.id);
  expect(ids('blocked_actions')).toEqual(['b1']);
  expect(res.body.blocked_actions[0].execution_result).toEqual({ error: { code: 'PLAN_LIMIT_EXCEEDED' } });
  // CONTROL: the existing lists keep their rows and never contain the blocked one
  expect(ids('pending_actions')).toEqual(['p1']);
  expect(ids('completed_actions')).toEqual(['e1', 'f1']);
  expect(ids('skipped_actions')).toEqual(['s1']);
});

it('the dashboard counts blocked separately - not as pending, not as failed', async () => {
  const res = await get(metricsRoute);
  expect(res.statusCode).toBe(200);
  const counts = res.body.actions_by_status;
  expect(counts.blocked).toBe(1);
  expect(counts.pending).toBe(1);
  expect(counts.failed).toBe(1);
});
