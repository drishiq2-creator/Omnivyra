/**
 * Phase C — /api/community-ai/actions/execute: closed execution-mode enum,
 * playbook permission for rpa/browser, requires_approval honoured, playbook
 * limits evaluated against real history, queued rpa answered 202.
 *
 * Real validator + real mode enum; the executor is a spy. Every refusal is
 * paired with a CONTROL that differs in one input and reaches the executor.
 */
type Row = Record<string, any>;
const store: { actions: Row[]; updates: Row[]; reads: number } = { actions: [], updates: [], reads: 0 };

function actionsQuery() {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  const q: any = {
    select: () => q,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
    in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return q; },
    is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
    gte: () => q,
    update: (p: Row) => { patch = p; return q; },
    maybeSingle: async () => {
      const hit = store.actions.find((r) => filters.every((f) => f(r)));
      if (hit && patch) { Object.assign(hit, patch); store.updates.push(patch); }
      return { data: hit ? { ...hit } : null, error: null };
    },
    then: (ok: any, ko: any) => Promise.resolve({ data: [], error: null }).then(ok, ko),
  };
  return q;
}
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => actionsQuery() } }));
jest.mock('../../db/communityAiActionStore', () => ({
  getCommunityAiActionById: jest.fn(async (id: string) => {
    store.reads += 1;
    const hit = store.actions.find((r) => r.id === id);
    return hit ? { data: { ...hit }, error: null } : { data: null, error: new Error('nf') };
  }),
}));
jest.mock('../../../pages/api/community-ai/utils', () => ({
  requireTenantScope: jest.fn(async () => ({ tenantId: 'org-1', organizationId: 'org-1' })),
  enforceActionRole: jest.fn(async () => ({ userId: 'user-1', role: 'COMPANY_ADMIN' })),
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
const history = { replies_last_hour: 0, follows_today: 0, actions_today: 0 };
jest.mock('../../services/communityAiActionExecutor', () => ({
  executeAction: jest.fn(async () => ({ ok: true, status: 'executed' })),
  loadHistoryMetrics: jest.fn(async () => ({ ...history })),
}));
jest.mock('../../services/communityAiContactGovernanceGate', () => ({
  checkCommunityActionContactGovernance: jest.fn(async () => ({ allowed: true })),
  contactGateAuditPayload: jest.fn(() => ({})),
}));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
let currentPlaybook: any = null;
jest.mock('../../services/playbooks/playbookService', () => ({ getPlaybookById: jest.fn(async () => currentPlaybook) }));

import executeRoute from '../../../pages/api/community-ai/actions/execute';
import { executeAction, loadHistoryMetrics } from '../../services/communityAiActionExecutor';
import { validateActionAgainstPlaybook } from '../../services/playbooks/playbookValidator';

const row = (over: Row = {}): Row => ({
  id: 'act-1', tenant_id: 'org-1', organization_id: 'org-1', platform: 'linkedin', action_type: 'reply',
  target_id: 'urn:li:share:1', suggested_text: 'thanks', playbook_id: null, execution_mode: null,
  status: 'pending', requires_human_approval: false, approved_at: null, risk_level: 'low', ...over,
});
async function post(body: Row) {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  await (executeRoute as any)({ method: 'POST', headers: {}, query: {}, body: { action_id: 'act-1', approved: true, ...body } }, res);
  return res;
}
const transitioned = () => store.updates.some((u) => u.status === 'executing');

beforeEach(() => {
  jest.clearAllMocks();
  store.actions = [row()];
  store.updates = [];
  store.reads = 0;
  currentPlaybook = null;
  Object.assign(history, { replies_last_hour: 0, follows_today: 0, actions_today: 0 });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('closed execution-mode enum at the route', () => {
  it('an unknown body mode is a 400 before the action is even read', async () => {
    const res = await post({ execution_mode: 'selenium' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'EXECUTION_MODE_INVALID', allowed: ['manual', 'api', 'rpa', 'browser'] });
    expect(store.reads).toBe(0);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('a stored mode outside the enum is refused the same way (fail closed)', async () => {
    store.actions = [row({ execution_mode: 'legacy_bot' })];
    const res = await post({});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('EXECUTION_MODE_INVALID');
    expect(transitioned()).toBe(false);
  });

  it('CONTROL: manual (and no mode at all) reaches the executor as manual', async () => {
    const res = await post({ execution_mode: 'manual' });
    expect(res.statusCode).toBe(200);
    expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({ execution_mode: 'manual' }), true, expect.anything());
    store.actions = [row()];
    const res2 = await post({});
    expect(res2.statusCode).toBe(200);
  });
});

describe('rpa / browser need a playbook that explicitly permits them', () => {
  it.each(['rpa', 'browser'])('%s with no playbook: 400 PLAYBOOK_REQUIRED, no transition (was: ran)', async (mode) => {
    const res = await post({ execution_mode: mode });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'PLAYBOOK_VIOLATION', reason: 'PLAYBOOK_REQUIRED' });
    expect(transitioned()).toBe(false);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('browser with a playbook that permits only api/rpa: refused', async () => {
    store.actions = [row({ playbook_id: 'pb-1' })];
    currentPlaybook = { execution_modes: { api_allowed: true, rpa_allowed: true, manual_only: false } };
    const res = await post({ execution_mode: 'browser' });
    expect(res.statusCode).toBe(400);
    expect(res.body.reason).toBe('Browser execution is not permitted by playbook.');
  });

  it.each([['rpa', 'rpa_allowed'], ['browser', 'browser_allowed']])('CONTROL: %s with a permitting playbook reaches the executor', async (mode, flag) => {
    // rpa also needs an approval of record (S-2); browser does not.
    store.actions = [row({ playbook_id: 'pb-1', approved_at: mode === 'rpa' ? '2026-11-01T00:00:00Z' : null })];
    currentPlaybook = { execution_modes: { [flag]: true } };
    const res = await post({ execution_mode: mode });
    expect(res.statusCode).toBe(200);
    expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({ execution_mode: mode }), true, expect.anything());
  });

  it('a queued rpa run (non-worker runtime) is answered 202 queued, not 400', async () => {
    store.actions = [row({ playbook_id: 'pb-1', approved_at: '2026-11-01T00:00:00Z' })];
    currentPlaybook = { execution_modes: { rpa_allowed: true } };
    (executeAction as jest.Mock).mockImplementationOnce(async () => ({ ok: false, status: 'failed', error: 'RPA_QUEUED_FOR_WORKER', reason: 'NOT_ATTEMPTED' }));
    const res = await post({ execution_mode: 'rpa' });
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ status: 'queued', queued_for_worker: true });
  });
});

describe('requires_approval is honoured', () => {
  const pbApproval = { automation_rules: { require_human_approval_medium_risk: true, auto_execute_low_risk: true } };

  it('the scenario exists: the validator returns requires_approval for this action', () => {
    const v = validateActionAgainstPlaybook({ action_type: 'reply', text: 'thanks', execution_mode: 'manual', risk_level: 'medium' }, pbApproval as any, null);
    expect(v).toMatchObject({ allowed: true, requires_approval: true });
  });

  it('no approval of record: 403 APPROVAL_REQUIRED, row marked for approval (B-2) but not transitioned, executor never called (was: executed)', async () => {
    store.actions = [row({ playbook_id: 'pb-1', risk_level: 'medium' })];
    currentPlaybook = pbApproval;
    const res = await post({ execution_mode: 'manual' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'APPROVAL_REQUIRED', reason: 'PLAYBOOK_REQUIRES_APPROVAL', approval_required: true, status: 'pending' });
    expect(transitioned()).toBe(false);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('CONTROL: the same action with approved_at set executes', async () => {
    store.actions = [row({ playbook_id: 'pb-1', risk_level: 'medium', approved_at: '2026-11-01T00:00:00Z' })];
    currentPlaybook = pbApproval;
    const res = await post({ execution_mode: 'manual' });
    expect(res.statusCode).toBe(200);
    expect(executeAction).toHaveBeenCalledTimes(1);
  });
});

describe('playbook limits read real history (was: null)', () => {
  const pbLimit = { limits: { max_replies_per_hour: 1 } };
  it('at the hourly reply limit: 400 Playbook limit exceeded', async () => {
    store.actions = [row({ playbook_id: 'pb-1' })];
    currentPlaybook = pbLimit;
    history.replies_last_hour = 1;
    const res = await post({ execution_mode: 'manual' });
    expect(loadHistoryMetrics).toHaveBeenCalledWith('org-1', 'org-1', 'pb-1');
    expect(res.statusCode).toBe(400);
    expect(res.body.reason).toBe('Playbook limit exceeded');
  });
  it('CONTROL: under the limit executes', async () => {
    store.actions = [row({ playbook_id: 'pb-1' })];
    currentPlaybook = pbLimit;
    const res = await post({ execution_mode: 'manual' });
    expect(res.statusCode).toBe(200);
  });
});
