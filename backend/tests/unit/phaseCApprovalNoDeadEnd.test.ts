/**
 * B-2 / S-2 — an approval-required refusal at /api/community-ai/actions/execute is
 * not a dead end, and an rpa execute never answers 202 "queued" for work the
 * browser worker's gate (approved_at required) would refuse.
 *
 * Real execute + approve route handlers over ONE in-memory community_ai_actions
 * table (the update filters the routes use are evaluated, including the
 * tenant/org scope). The DB CHECK community_ai_actions_approval_integrity_check
 * is mirrored on every write, so a write the real table would reject fails here
 * too. The executor is a spy.
 *
 * Every refusal is paired with a CONTROL.
 */
import { orFilter } from '../helpers/rpaClaimQueueDouble';
type Row = Record<string, any>;
const store: { actions: Row[]; failNextUpdate: boolean; staleRead: Row | null; onHistory: (() => void) | null } = {
  actions: [], failNextUpdate: false, staleRead: null, onHistory: null,
};

// community_ai_actions_approval_integrity_check (20260522_community_ai_execution_integrity.sql)
const approvalIntegrityOk = (r: Row) =>
  r.requires_human_approval !== true || r.status === 'pending' || r.status === 'skipped' || r.approved_at != null;

function actionsQuery() {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  const q: any = {
    select: () => q,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
    in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return q; },
    or: (expr: string) => { filters.push(orFilter(expr)); return q; },
    is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
    gte: () => q,
    update: (p: Row) => { patch = p; return q; },
    maybeSingle: async () => {
      const hit = store.actions.find((r) => filters.every((f) => f(r)));
      if (patch) {
        if (store.failNextUpdate) { store.failNextUpdate = false; return { data: null, error: { message: 'db down' } }; }
        if (!hit) return { data: null, error: null };
        const next = { ...hit, ...patch };
        if (!approvalIntegrityOk(next)) return { data: null, error: { message: 'violates check constraint community_ai_actions_approval_integrity_check' } };
        Object.assign(hit, patch);
      }
      return { data: hit ? { ...hit } : null, error: null };
    },
    then: (ok: any, ko: any) => Promise.resolve({ data: [], error: null }).then(ok, ko),
  };
  return q;
}
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => actionsQuery() } }));
jest.mock('../../db/communityAiActionStore', () => ({
  getCommunityAiActionById: jest.fn(async (id: string) => {
    // A stale copy (what the route read a moment ago), when a test installs one.
    if (store.staleRead && store.staleRead.id === id) { const r = store.staleRead; store.staleRead = null; return { data: { ...r }, error: null }; }
    const hit = store.actions.find((r) => r.id === id);
    return hit ? { data: { ...hit }, error: null } : { data: null, error: new Error('nf') };
  }),
}));
jest.mock('../../../pages/api/community-ai/utils', () => ({
  requireTenantScope: jest.fn(async () => ({ tenantId: 'org-1', organizationId: 'org-1' })),
  enforceActionRole: jest.fn(async () => ({ userId: 'user-1', role: 'COMPANY_ADMIN' })),
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/communityAiActionExecutor', () => ({
  executeAction: jest.fn(async () => ({ ok: true, status: 'executed' })),
  loadHistoryMetrics: jest.fn(async () => {
    // runs after the route's read and before its marking write: an interleaving point
    if (store.onHistory) { const f = store.onHistory; store.onHistory = null; f(); }
    return { replies_last_hour: 0, follows_today: 0, actions_today: 0 };
  }),
}));
jest.mock('../../services/communityAiContactGovernanceGate', () => ({
  checkCommunityActionContactGovernance: jest.fn(async () => ({ allowed: true })),
  contactGateAuditPayload: jest.fn(() => ({})),
}));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
jest.mock('../../services/telemetry/telemetryDispatcher', () => ({ trackEvent: jest.fn() }));
let currentPlaybook: any = null;
jest.mock('../../services/playbooks/playbookService', () => ({ getPlaybookById: jest.fn(async () => currentPlaybook) }));

import executeRoute from '../../../pages/api/community-ai/actions/execute';
import approveRoute from '../../../pages/api/community-ai/actions/approve';
import { executeAction } from '../../services/communityAiActionExecutor';

const row = (over: Row = {}): Row => ({
  id: 'act-1', tenant_id: 'org-1', organization_id: 'org-1', platform: 'linkedin', action_type: 'like',
  target_id: 'https://www.linkedin.com/feed/update/urn:1', suggested_text: 'thanks', playbook_id: 'pb-1', execution_mode: null,
  status: 'pending', requires_human_approval: false, approved_at: null, risk_level: 'medium', ...over,
});
async function call(route: any, body: Row) {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  await route({ method: 'POST', headers: {}, query: {}, body }, res);
  return res;
}
const execute = (body: Row = {}) => call(executeRoute, { action_id: 'act-1', approved: true, ...body });
const approve = () => call(approveRoute, { action_id: 'act-1' });

const pbApproval = { automation_rules: { require_human_approval_medium_risk: true, auto_execute_low_risk: true } };

beforeEach(() => {
  jest.clearAllMocks();
  store.actions = [row()];
  store.failNextUpdate = false;
  store.staleRead = null;
  store.onHistory = null;
  currentPlaybook = pbApproval;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('B-2: PLAYBOOK_REQUIRES_APPROVAL -> approve -> execute', () => {
  it('the scenario exists: before the fix approve answered 400 APPROVAL_NOT_REQUIRED for this row', async () => {
    // A row the playbook requires approval for, but requires_human_approval=false (as the planner wrote it).
    const res = await approve();
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'APPROVAL_NOT_REQUIRED' });
  });

  it('END TO END: execute refuses and records the requirement; approve succeeds; execute then runs once', async () => {
    const refused = await execute({ execution_mode: 'manual' });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toMatchObject({
      error: 'APPROVAL_REQUIRED', reason: 'PLAYBOOK_REQUIRES_APPROVAL', status: 'pending', requires_human_approval: true, next_step: 'approve',
    });
    expect(executeAction).not.toHaveBeenCalled();
    expect(store.actions[0]).toMatchObject({ status: 'pending', requires_human_approval: true, approved_at: null });

    const approved = await approve();
    expect(approved.statusCode).toBe(200);
    expect(store.actions[0]).toMatchObject({ status: 'approved', approved_by: 'user-1' });
    expect(store.actions[0].approved_at).toEqual(expect.any(String));

    const ran = await execute({ execution_mode: 'manual' });
    expect(ran.statusCode).toBe(200);
    expect(executeAction).toHaveBeenCalledTimes(1);
  });

  it('a scheduled row is moved to pending (the DB CHECK admits the flag without approved_at only there) and can be approved', async () => {
    store.actions = [row({ status: 'scheduled' })];
    const refused = await execute({ execution_mode: 'manual' });
    expect(refused.statusCode).toBe(403);
    expect(store.actions[0]).toMatchObject({ status: 'pending', requires_human_approval: true });
    expect((await approve()).statusCode).toBe(200);
  });

  it('the marking write is tenant-scoped: a stale in-scope read of a row now stored under another org -> 409, stored row untouched', async () => {
    // The route's read check passes (the copy it read says org-1) ...
    store.staleRead = row();
    // ... but the stored row belongs to another organization by the time of the write.
    store.actions = [row({ organization_id: 'org-2', tenant_id: 'org-2' })];
    const res = await execute({ execution_mode: 'manual' });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('ACTION_STATE_CHANGED');
    expect(store.actions[0]).toMatchObject({ organization_id: 'org-2', status: 'pending', requires_human_approval: false });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('409 ACTION_STATE_CHANGED: an approval landing between the read and the marking write is not overwritten', async () => {
    store.onHistory = () => { Object.assign(store.actions[0], { status: 'approved', approved_at: '2026-11-27T10:00:00Z', approved_by: 'user-2' }); };
    const res = await execute({ execution_mode: 'manual' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'ACTION_STATE_CHANGED', reason: 'PLAYBOOK_REQUIRES_APPROVAL' });
    expect(store.actions[0]).toMatchObject({ status: 'approved', approved_by: 'user-2', requires_human_approval: false });
    expect(executeAction).not.toHaveBeenCalled();
    // CONTROL: executing again now runs (the approval of record is there)
    expect((await execute({ execution_mode: 'manual' })).statusCode).toBe(200);
  });

  it('a failed marking write is an honest 503 (retryable), nothing executed; CONTROL: the retry records it', async () => {
    store.failNextUpdate = true;
    const res = await execute({ execution_mode: 'manual' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'APPROVAL_STATE_WRITE_FAILED', retryable: true });
    expect(store.actions[0].requires_human_approval).toBe(false);
    expect(executeAction).not.toHaveBeenCalled();
    const again = await execute({ execution_mode: 'manual' });
    expect(again.statusCode).toBe(403);
    expect(store.actions[0].requires_human_approval).toBe(true);
  });

  it('CONTROL: an action the playbook does not require approval for executes at once (row untouched)', async () => {
    store.actions = [row({ risk_level: 'low' })];
    const res = await execute({ execution_mode: 'manual' });
    expect(res.statusCode).toBe(200);
    expect(store.actions[0].requires_human_approval).toBe(false);
  });
});

describe('S-2: rpa execute without an approval of record never answers 202 queued', () => {
  const pbRpa = { execution_modes: { rpa_allowed: true }, automation_rules: { auto_execute_low_risk: true } };

  it('no approved_at: 403 approval required, requirement recorded, executor (queue) never called', async () => {
    currentPlaybook = pbRpa;
    store.actions = [row({ risk_level: 'low' })];
    const res = await execute({ execution_mode: 'rpa' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'APPROVAL_REQUIRED', reason: 'RPA_REQUIRES_APPROVAL_OF_RECORD', requires_human_approval: true });
    expect(res.body.queued_for_worker).toBeUndefined();
    expect(executeAction).not.toHaveBeenCalled();
    expect(store.actions[0]).toMatchObject({ status: 'pending', requires_human_approval: true });
  });

  it('END TO END: refuse -> approve -> execute reaches the executor and the queued run is a 202 the worker gate will accept', async () => {
    currentPlaybook = pbRpa;
    store.actions = [row({ risk_level: 'low' })];
    expect((await execute({ execution_mode: 'rpa' })).statusCode).toBe(403);
    expect((await approve()).statusCode).toBe(200);
    (executeAction as jest.Mock).mockImplementationOnce(async () => ({ ok: false, status: 'failed', error: 'RPA_QUEUED_FOR_WORKER', reason: 'NOT_ATTEMPTED' }));
    const res = await execute({ execution_mode: 'rpa' });
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ status: 'queued', queued_for_worker: true });
    // the executor was handed the approval of record the worker gate checks
    expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({ approved_at: expect.any(String) }), true, expect.anything());
  });

  it('CONTROL: browser (not rpa) with the same unapproved low-risk row is not held for approval', async () => {
    currentPlaybook = { execution_modes: { browser_allowed: true }, automation_rules: { auto_execute_low_risk: true } };
    store.actions = [row({ risk_level: 'low' })];
    const res = await execute({ execution_mode: 'browser' });
    expect(res.statusCode).toBe(200);
    expect(store.actions[0].requires_human_approval).toBe(false);
  });
});
