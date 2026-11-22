/**
 * Owner decision 2026-11-22: 'blocked' (plan-limit restriction) is a distinct status, not an execution failure.
 *   - execute route: a blocked result is reported as ACTION_BLOCKED with its reason; it is NOT logged as 'failed' and
 *     does not feed the "repeated failures" webhook (CONTROL: a real failure still is);
 *   - a blocked action never goes back into execution: execute and approve refuse it (CONTROL: an approved one runs).
 */
type Row = Record<string, any>;

const ORG = 'org-1';
let actionRow: Row;
let executorResult: Row;
const executed: Row[] = [];
const logged: Row[] = [];
const webhooks: Row[] = [];
let failedLogCount = 0;

const supabaseDouble = {
  from: (t: string) => {
    let patch: Row | null = null;
    const filters: Array<[string, string, unknown]> = [];
    const add = (op: string) => (k: string, v: unknown) => { if (patch) filters.push([op, k, v]); return q; };
    const passes = () => filters.every(([op, k, v]) =>
      op === 'eq' ? actionRow[k] === v : op === 'in' ? (v as unknown[]).includes(actionRow[k]) : (actionRow[k] ?? null) === v);
    const result = () => {
      if (t === 'community_ai_action_logs') return { data: Array.from({ length: failedLogCount }, (_, i) => ({ id: `l${i}` })), error: null };
      if (patch) { if (passes()) { actionRow = { ...actionRow, ...patch }; return { data: { ...actionRow }, error: null }; } return { data: null, error: null }; }
      return { data: null, error: null };
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
}));
jest.mock('../../services/communityAiActionExecutor', () => ({
  executeAction: async (action: Row) => { executed.push(action); return executorResult; },
}));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: async (e: Row) => { logged.push(e); } }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: async () => undefined }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: async (w: Row) => { webhooks.push(w); } }));
jest.mock('../../services/playbooks/playbookService', () => ({ getPlaybookById: async () => null }));
jest.mock('../../services/playbooks/playbookValidator', () => ({ validateActionAgainstPlaybook: () => ({ allowed: true }) }));
jest.mock('../../services/telemetry/telemetryDispatcher', () => ({ trackEvent: () => undefined }));

import executeRoute from '../../../pages/api/community-ai/actions/execute';
import approveRoute from '../../../pages/api/community-ai/actions/approve';

const ordinary = (over: Row = {}): Row => ({
  id: 'act-1', tenant_id: ORG, organization_id: ORG, platform: 'linkedin', action_type: 'reply', status: 'approved',
  target_id: 'urn:li:share:1', suggested_text: 'thanks!', requires_human_approval: true, approved_at: '2026-11-22T10:00:00Z',
  execution_mode: 'api', risk_level: 'low', dm_lead_id: null, ...over,
});
const BLOCKED_RESULT = { ok: false, status: 'blocked', error: { code: 'PLAN_LIMIT_EXCEEDED', limit: 100, used: 100 } };

async function call(route: any, body: Row = {}) {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  await route({ method: 'POST', headers: {}, query: {}, body: { organization_id: ORG, tenant_id: ORG, action_id: 'act-1', approved: true, ...body } }, res);
  return res;
}

beforeEach(() => {
  executed.length = 0; logged.length = 0; webhooks.length = 0; failedLogCount = 3;
  actionRow = ordinary();
  executorResult = BLOCKED_RESULT;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('execute route: a blocked result is a restriction, not a failure', () => {
  it('reported as ACTION_BLOCKED with its reason; no "failed" log; no repeated-failure webhook', async () => {
    const res = await call(executeRoute);
    expect(res.body.status).toBe('blocked');
    expect(res.body.error).toBe('ACTION_BLOCKED');
    expect(res.body.blocked_reason).toBe('PLAN_LIMIT_EXCEEDED');
    expect(logged.filter((e) => e.event_type === 'failed')).toHaveLength(0);
    expect(webhooks).toHaveLength(0);
  });

  it('CONTROL: a real failure is still logged as failed and feeds the repeated-failure webhook', async () => {
    executorResult = { ok: false, status: 'failed', error: 'CONNECTOR_ERROR' };
    const res = await call(executeRoute);
    expect(res.body.error).toBeUndefined();
    expect(logged.filter((e) => e.event_type === 'failed')).toHaveLength(1);
    expect(webhooks).toHaveLength(1);
  });
});

describe('a blocked action never goes back into execution', () => {
  it('execute refuses it (ACTION_NOT_PENDING); the executor is never called', async () => {
    actionRow = ordinary({ status: 'blocked' });
    const res = await call(executeRoute);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('ACTION_NOT_PENDING');
    expect(executed).toHaveLength(0);
    expect(actionRow.status).toBe('blocked');
  });

  it('a blocked LinkedIn new DM is refused too', async () => {
    actionRow = ordinary({ status: 'blocked', action_type: 'dm', dm_lead_id: 'lead-1', dm_sender_member_id: 'ACoAAMEMEMEMEMEMEMEMEMEMEME01', acting_user_id: 'u1', target_id: 'https://www.linkedin.com/in/a/' });
    const res = await call(executeRoute);
    expect(res.statusCode).toBe(409);
    expect(executed).toHaveLength(0);
  });

  it('approve refuses it (ACTION_NOT_PENDING); the row stays blocked', async () => {
    actionRow = ordinary({ status: 'blocked', approved_at: null });
    const res = await call(approveRoute);
    expect(res.statusCode).toBe(409);
    expect(actionRow.status).toBe('blocked');
  });

  it('CONTROL: an approved action is executed', async () => {
    executorResult = { ok: true, status: 'executed' };
    const res = await call(executeRoute);
    expect(res.statusCode).toBe(200);
    expect(executed).toHaveLength(1);
  });
});
