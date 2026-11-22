/**
 * Review of 8ed5275fd ('blocked', owner 2026-11-22):
 *   B1 - a blocked run whose own terminal write did not land (write error, or an idempotency collision answered with a
 *        DIFFERENT row) is written 'blocked' on its own row and reported blocked - never left 'executing', never
 *        reported as the other row's "executed". CONTROLS: a non-blocked write failure stays a 500; a genuine
 *        deduplication of a non-blocked run is reported as before.
 *   #4 - a blocked action is never skipped away (CONTROL: a pending one is skipped).
 *   #5 - the engagement action-status reason for a blocked action is the plain reason.
 */
type Row = Record<string, any>;
const ORG = 'org-1';
let actionRow: Row;
let executorResult: Row;

const supabaseDouble = {
  from: (t: string) => {
    let patch: Row | null = null;
    const filters: Array<[string, string, unknown]> = [];
    const add = (op: string) => (k: string, v: unknown) => { filters.push([op, k, v]); return q; };
    const passes = () => filters.every(([op, k, v]) =>
      op === 'eq' ? actionRow[k] === v : op === 'in' ? (v as unknown[]).includes(actionRow[k]) : (actionRow[k] ?? null) === v);
    const result = () => {
      if (t === 'community_ai_action_logs') return { data: [], error: null };
      if (patch) { if (passes()) { actionRow = { ...actionRow, ...patch }; return { data: { ...actionRow }, error: null }; } return { data: null, error: null }; }
      return { data: passes() ? { ...actionRow } : null, error: null };
    };
    const q: any = {
      select: () => q, eq: add('eq'), in: add('in'), is: add('is'), gte: () => q,
      update: (p: Row) => { patch = p; return q; },
      maybeSingle: async () => result(), single: async () => result(),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
    };
    return q;
  },
};
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../db/supabaseClient', () => ({ supabase: supabaseDouble }));
jest.mock('../../db/communityAiActionStore', () => ({ getCommunityAiActionById: async () => ({ data: actionRow, error: null }) }));
jest.mock('../../../pages/api/community-ai/utils', () => ({
  requireTenantScope: async () => ({ organizationId: ORG, tenantId: ORG }),
  enforceActionRole: async () => ({ userId: 'approver-1', role: 'COMPANY_ADMIN' }),
  resolveActionRole: () => 'COMPANY_ADMIN',
}));
jest.mock('../../services/userContextService', () => ({ enforceCompanyAccess: async () => ({ userId: 'u1' }) }));
jest.mock('../../services/communityAiActionExecutor', () => ({ executeAction: async () => executorResult }));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: async () => undefined }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: async () => undefined, notifyCommunityAiBulk: async () => undefined }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: async () => undefined }));
jest.mock('../../services/playbooks/playbookService', () => ({ getPlaybookById: async () => null }));
jest.mock('../../services/playbooks/playbookValidator', () => ({ validateActionAgainstPlaybook: () => ({ allowed: true }) }));

import executeRoute from '../../../pages/api/community-ai/actions/execute';
import actionsRoute from '../../../pages/api/community-ai/actions';
import actionStatusRoute from '../../../pages/api/engagement/action-status';

const PLAN = { code: 'PLAN_LIMIT_EXCEEDED', limit: 100, used: 100 };
const ordinary = (over: Row = {}): Row => ({
  id: 'act-1', tenant_id: ORG, organization_id: ORG, platform: 'linkedin', action_type: 'reply', status: 'approved',
  target_id: 'urn:li:share:1', suggested_text: 'thanks!', requires_human_approval: true, approved_at: '2026-11-22T10:00:00Z',
  execution_mode: 'api', risk_level: 'low', dm_lead_id: null, ...over,
});

async function call(route: any, { method = 'POST', body = {}, query = {} }: Row = {}) {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  await route({ method, headers: {}, query, body: { organization_id: ORG, tenant_id: ORG, action_id: 'act-1', approved: true, ...body } }, res);
  return res;
}

beforeEach(() => { actionRow = ordinary(); jest.spyOn(console, 'warn').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());

describe('B1: a blocked run never stays executing and is never reported as another row\'s outcome', () => {
  it('the executor\'s blocked write FAILED -> this row is written blocked with the plan-limit reason; reported blocked', async () => {
    executorResult = { ok: false, status: 'failed', error: 'duplicate key value', response: { persist_error: 'duplicate key value', original_status: 'blocked', original_error: PLAN } };
    const res = await call(executeRoute);
    expect(actionRow.status).toBe('blocked');
    expect(actionRow.execution_result.error).toEqual(PLAN);
    expect(res.body).toMatchObject({ status: 'blocked', error: 'ACTION_BLOCKED', blocked_reason: 'PLAN_LIMIT_EXCEEDED' });
  });

  it('the blocked write collided with ANOTHER row\'s key ("deduplicated" as executed) -> this row blocked; never reported executed', async () => {
    executorResult = { ok: true, status: 'executed', deduplicated: true, prior_action_id: 'act-OTHER', response: { original_status: 'blocked', original_error: PLAN } };
    const res = await call(executeRoute);
    expect(actionRow.status).toBe('blocked');
    expect(res.body.status).toBe('blocked');
    expect(res.statusCode).not.toBe(200);
  });

  it('CONTROL: a non-blocked write failure is still TERMINAL_WRITE_FAILED (no compensation)', async () => {
    executorResult = { ok: false, status: 'failed', error: 'x', response: { persist_error: 'x', original_status: 'executed', original_error: null } };
    const res = await call(executeRoute);
    expect(res.statusCode).toBe(500);
    expect(actionRow.status).toBe('executing');
  });

  it('CONTROL: a genuine deduplication of an executed run is reported as before', async () => {
    executorResult = { ok: true, status: 'executed', deduplicated: true, prior_action_id: 'act-OTHER', response: { original_status: 'executed' } };
    const res = await call(executeRoute);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('executed');
  });
});

describe('#4: a blocked action is never skipped away', () => {
  it('skip on a blocked action -> 409 ACTION_BLOCKED; the record stays blocked', async () => {
    actionRow = ordinary({ status: 'blocked' });
    const res = await call(actionsRoute, { body: { status: 'skipped' } });
    expect(res.statusCode).toBe(409);
    expect(actionRow.status).toBe('blocked');
  });
  it('CONTROL: a pending action is skipped', async () => {
    actionRow = ordinary({ status: 'pending' });
    const res = await call(actionsRoute, { body: { status: 'skipped' } });
    expect(res.statusCode).toBe(200);
    expect(actionRow.status).toBe('skipped');
  });
});

describe('#5: engagement action status gives the reason for a blocked action', () => {
  it('blocked -> the plain reason; CONTROL: failed keeps its own error', async () => {
    actionRow = ordinary({ status: 'blocked', execution_result: { status: 'blocked', error: PLAN } });
    let res = await call(actionStatusRoute, { method: 'GET', query: { organization_id: ORG, action_id: 'act-1' } });
    expect(JSON.stringify(res.body)).toContain('Plan limit reached - this action was not executed.');
    actionRow = ordinary({ status: 'failed', execution_result: { status: 'failed', error: 'CONNECTOR_ERROR' } });
    res = await call(actionStatusRoute, { method: 'GET', query: { organization_id: ORG, action_id: 'act-1' } });
    expect(JSON.stringify(res.body)).toContain('CONNECTOR_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('Plan limit');
  });
});
