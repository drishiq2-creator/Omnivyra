/**
 * Review SF-1 — scheduler vs manual execute on ONE approved row with a due
 * scheduled_at (the shape B-2 produces: refused -> approved -> "execute again").
 *
 * The real scheduler (runCommunityAiScheduler) and the real execute route run
 * over ONE in-memory community_ai_actions table whose update evaluates every
 * filter (id, tenant, org, status). executeAction is a spy that counts runs.
 * The other side's claim is injected at the exact interleaving point:
 *   - route first: inside the scheduler's guardrail check (the last step before
 *     its claim), the route executes the row;
 *   - scheduler first: inside the scheduler's executeAction, the route tries.
 * Exactly one execution in both orders. The scheduler's claim is the dispatch
 * lease (the real status CHECK has no 'executing'); the route's CAS requires
 * no live lease.
 */
import { orFilter } from '../helpers/rpaClaimQueueDouble';
type Row = Record<string, any>;
const db: { actions: Row[] } = { actions: [] };

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  const run = () => {
    const rows = table === 'community_ai_actions' ? db.actions : [];
    const hits = rows.filter((r) => filters.every((f) => f(r)));
    if (patch) { for (const h of hits) Object.assign(h, patch); }
    return hits;
  };
  const q: any = {
    select: () => q,
    insert: () => q,
    update: (p: Row) => { patch = p; return q; },
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
    in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return q; },
    or: (expr: string) => { filters.push(orFilter(expr)); return q; },
    is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
    gte: (k: string, v: string) => { filters.push((r) => r[k] != null && String(r[k]) >= v); return q; },
    lte: (k: string, v: string) => { filters.push((r) => r[k] != null && String(r[k]) <= v); return q; },
    order: () => q,
    limit: () => q,
    maybeSingle: async () => { const h = run(); return { data: h[0] ? { ...h[0] } : null, error: null }; },
    single: async () => { const h = run(); return { data: h[0] ? { ...h[0] } : null, error: null }; },
    then: (ok: any, ko: any) => Promise.resolve().then(() => ({ data: run().map((r) => ({ ...r })), error: null })).then(ok, ko),
  };
  return q;
}
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => query(t) } }));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => query(t) }));
jest.mock('../../db/communityAiActionStore', () => ({
  getCommunityAiActionById: jest.fn(async (id: string) => {
    const hit = db.actions.find((r) => r.id === id);
    return hit ? { data: { ...hit }, error: null } : { data: null, error: new Error('nf') };
  }),
}));
jest.mock('../../../pages/api/community-ai/utils', () => ({
  requireTenantScope: jest.fn(async () => ({ tenantId: 'org-1', organizationId: 'org-1' })),
  enforceActionRole: jest.fn(async () => ({ userId: 'user-1', role: 'COMPANY_ADMIN' })),
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
const runs: string[] = [];
let onSchedulerExecute: (() => Promise<void>) | null = null;
jest.mock('../../services/communityAiActionExecutor', () => ({
  executeAction: jest.fn(async (_a: any, _ok: boolean, opts: any) => {
    runs.push(opts?.source ?? 'unknown');
    if (opts?.source === 'scheduler' && onSchedulerExecute) { const f = onSchedulerExecute; onSchedulerExecute = null; await f(); }
    return { ok: true, status: 'executed' };
  }),
  persistExecutionResult: jest.fn(async () => ({ ok: true })),
  loadHistoryMetrics: jest.fn(async () => ({ replies_last_hour: 0, follows_today: 0, actions_today: 0 })),
}));
jest.mock('../../services/communityAiPlatformPolicyService', () =>
  jest.requireActual('../helpers/communityAiPolicyMock').policyServiceMock(() => ({ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false })));
jest.mock('../../services/communityAiContactGovernanceGate', () => ({
  checkCommunityActionContactGovernance: jest.fn(async () => ({ allowed: true })),
  contactGateAuditPayload: jest.fn(() => ({})),
}));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
jest.mock('../../services/playbooks/playbookService', () => ({ getPlaybookById: jest.fn(async () => ({ id: 'pb-1', status: 'active' })) }));
jest.mock('../../services/playbooks/playbookValidator', () => ({ validateActionAgainstPlaybook: jest.fn(() => ({ allowed: true, requires_approval: false })) }));
jest.mock('../../services/platformTokenService', () => ({ getToken: jest.fn(async () => null) }));
let onGuardrail: (() => Promise<void>) | null = null;
jest.mock('../../services/executionGuardrailService', () => ({
  canExecuteAction: jest.fn(async () => {
    if (onGuardrail) { const f = onGuardrail; onGuardrail = null; await f(); }
    return { allowed: true };
  }),
}));

import { runCommunityAiScheduler } from '../../services/communityAiScheduler';
import executeRoute from '../../../pages/api/community-ai/actions/execute';

const row = (): Row => ({
  id: 'act-1', tenant_id: 'org-1', organization_id: 'org-1', platform: 'linkedin', action_type: 'like',
  target_id: 'urn:li:share:1', suggested_text: 'hi', playbook_id: 'pb-1', execution_mode: 'manual',
  status: 'approved', requires_human_approval: true, approved_at: '2026-11-27T00:00:00Z', risk_level: 'low',
  scheduled_at: '2026-11-27T00:00:00Z', intent_classification: null,
  dispatch_lease_id: null, dispatch_lease_holder_id: null, dispatch_lease_expires_at: null,
});
async function routeExecute() {
  const res: any = { statusCode: 0 };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  await (executeRoute as any)({ method: 'POST', headers: {}, query: {}, body: { action_id: 'act-1', approved: true, execution_mode: 'manual' } }, res);
  return res;
}

beforeEach(() => {
  db.actions = [row()];
  runs.length = 0;
  onGuardrail = null;
  onSchedulerExecute = null;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'debug').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('SF-1: scheduler and manual execute claim the same row: exactly one runs', () => {
  it('the scenario exists: the scheduler alone loads and executes the due approved row', async () => {
    const out = await runCommunityAiScheduler(new Date('2026-11-28T00:00:00Z'));
    expect(out.processed).toBe(1);
    expect(runs).toEqual(['scheduler']);
  });

  it('route claims first (between the scheduler load and its claim): the scheduler skips; one run', async () => {
    let routeStatus = 0;
    onGuardrail = async () => { routeStatus = (await routeExecute()).statusCode; };
    await runCommunityAiScheduler(new Date('2026-11-28T00:00:00Z'));
    expect(routeStatus).toBe(200);
    expect(runs).toEqual(['manual']);
  });

  it('scheduler claims first: the route answers 409 and does not run; one run; the scheduler lease is released after', async () => {
    let routeRes: any = null;
    let leaseDuringRun: string | null = null;
    onSchedulerExecute = async () => { leaseDuringRun = db.actions[0].dispatch_lease_holder_id; routeRes = await routeExecute(); };
    await runCommunityAiScheduler(new Date('2026-11-28T00:00:00Z'));
    expect(leaseDuringRun).toBe('community_ai_scheduler');
    expect(db.actions[0].status).toBe('approved'); // claim never writes a status the CHECK refuses
    expect(routeRes.statusCode).toBe(409);
    expect(routeRes.body.error).toBe('ACTION_NOT_PENDING');
    expect(runs).toEqual(['scheduler']);
    expect(db.actions[0].dispatch_lease_id).toBeNull();
  });

  // Lease predicate (coordinator, scheduler-lease item): only a row with NO lease is claimable. An expired lease
  // that was never released (dispatch_lease_id still set) may already have sent - it blocks both sides.
  it('an EXPIRED but UNRELEASED lease (a tick that died / an extension that lost its result) blocks the route: 409, nothing runs', async () => {
    db.actions[0].dispatch_lease_id = 'dead';
    db.actions[0].dispatch_lease_holder_id = 'community_ai_scheduler';
    db.actions[0].dispatch_lease_expires_at = '2026-01-01T00:00:00.000Z';
    const r = await routeExecute();
    expect(r.statusCode).toBe(409);
    expect(runs).toEqual([]);
  });
});

describe('scheduler lease predicate: dispatch_lease_id IS NULL, never "expired"', () => {
  const tick = () => runCommunityAiScheduler(new Date('2026-11-28T00:00:00Z'));

  it('expired-unreleased extension lease -> the scheduler skips the row (no run, lease untouched)', async () => {
    Object.assign(db.actions[0], { dispatch_lease_id: 'lease-ext', dispatch_lease_holder_id: 'holder-ext', dispatch_lease_expires_at: '2026-01-01T00:00:00.000Z' });
    await tick();
    expect(runs).toEqual([]);
    expect(db.actions[0]).toMatchObject({ dispatch_lease_id: 'lease-ext', dispatch_lease_holder_id: 'holder-ext' });
  });

  it('CONTROL: a RELEASED lease (all lease fields nulled, as every release does) -> claimable and run once', async () => {
    Object.assign(db.actions[0], { dispatch_lease_id: null, dispatch_lease_holder_id: null, dispatch_lease_expires_at: null, dispatch_acknowledged_at: null });
    await tick();
    expect(runs).toEqual(['scheduler']);
  });

  it('CONTROL: a never-leased row -> claimable; the scheduler releases its own lease after (dispatch_lease_id null)', async () => {
    await tick();
    expect(runs).toEqual(['scheduler']);
    expect(db.actions[0]).toMatchObject({ dispatch_lease_id: null, dispatch_lease_holder_id: null, dispatch_lease_expires_at: null });
  });

  it('CONTROL: a released row is executable by hand too (the route CAS uses the same predicate)', async () => {
    expect((await routeExecute()).statusCode).toBe(200);
    expect(runs).toEqual(['manual']);
  });

  it('the scheduler claim is tenant/org scoped: a row whose stored org differs is not claimed or run', async () => {
    db.actions = [{ ...row() }];
    onGuardrail = async () => { db.actions[0].organization_id = 'org-2'; };
    await runCommunityAiScheduler(new Date('2026-11-28T00:00:00Z'));
    expect(runs).toEqual([]);
    expect(db.actions[0]).toMatchObject({ status: 'approved', dispatch_lease_id: null });
  });
});
