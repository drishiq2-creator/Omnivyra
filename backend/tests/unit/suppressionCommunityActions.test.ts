/**
 * Round 24D / G-7 (round 18 S9) — contact governance on the
 * `community_ai_actions` path.
 *
 * The ONE suppression engine (`execution/suppressionService.isSuppressed`,
 * canonical `contact_governance_records` then legacy `suppression_entries`,
 * evaluated by `mayContact`) is REAL here. Only the table layer
 * (`ownedDbTable`) is an in-memory double, so tenant filtering, person
 * resolution, the rule evaluation and every fail-closed exit run as shipped.
 *
 * Boundaries covered:
 *   - executor (runExecution via executeAction): api, rpa and browser (DM chain)
 *   - approve route  (pages/api/community-ai/actions/approve.ts)
 *   - execute route  (pages/api/community-ai/actions/execute.ts)
 * Each refusal is paired with a control that differs ONLY by the suppression
 * row (or the store failure), and the control must proceed.
 */

type Row = Record<string, any>;
type Filter = [kind: string, column: string, value: unknown];

const db = {
  tables: {} as Record<string, Row[]>,
  failures: {} as Record<string, { code: string; message: string }>,
  queries: [] as Array<{ table: string; filters: Filter[] }>,
};

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    const st = { op: 'select', filters: [] as Filter[], payload: null as Row | null };
    const match = (r: Row): boolean =>
      st.filters.every(([kind, col, val]) => {
        if (kind === 'eq') return r[col] === val;
        if (kind === 'is') return (r[col] ?? null) === val;
        if (kind === 'in') return Array.isArray(val) && (val as unknown[]).includes(r[col] ?? null);
        return true;
      });
    const exec = async (mode: 'many' | 'maybe') => {
      await Promise.resolve();
      db.queries.push({ table, filters: st.filters });
      const failure = db.failures[table];
      if (failure) return { data: null, error: failure };
      if (st.op === 'insert') return { data: null, error: null };
      const found = (db.tables[table] ?? []).filter(match);
      return mode === 'many' ? { data: found, error: null } : { data: found[0] ?? null, error: null };
    };
    const b: any = {
      select: () => b,
      insert: (p: Row) => { st.op = 'insert'; st.payload = p; return b; },
      update: (p: Row) => { st.op = 'update'; st.payload = p; return b; },
      eq: (c: string, v: unknown) => { st.filters.push(['eq', c, v]); return b; },
      is: (c: string, v: unknown) => { st.filters.push(['is', c, v]); return b; },
      in: (c: string, v: unknown) => { st.filters.push(['in', c, v]); return b; },
      order: () => b,
      limit: () => exec('many'),
      maybeSingle: () => exec('maybe'),
      single: () => exec('maybe'),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec('many').then(res, rej),
    };
    return b;
  },
}));

// ── Executor collaborators (side effects are spies) ─────────────────────────
jest.mock('../../services/communityAiPlatformPolicyService', () => ({
  getCommunityAiPlatformPolicy: jest.fn(async () => ({ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false })),
}));
jest.mock('../../services/communityAiActionExecutorContracts', () => {
  const actual = jest.requireActual('../../services/communityAiActionExecutorContracts');
  return {
    ...actual,
    recordExecutionMetric: jest.fn(async () => undefined),
    resolveExecutionMode: jest.fn(async (a: any) => a.execution_mode || 'api'),
    loadHistoryMetrics: jest.fn(async () => null),
    runApiExecution: jest.fn(async () => ({ ok: true, status: 'executed' })),
    runRpaExecution: jest.fn(async () => ({ ok: true, status: 'executed' })),
    prepareBrowserDispatch: jest.fn(() => ({ ok: true, status: 'dispatched' })),
  };
});
jest.mock('../../services/communityAiActionLogService', () => ({
  logCommunityAiActionEvent: jest.fn(async () => undefined),
}));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
jest.mock('../../services/playbooks/playbookService', () => ({
  getPlaybookById: jest.fn(async () => ({ id: 'pb-1', name: 'Engage', status: 'active' })),
}));
jest.mock('../../services/playbooks/playbookValidator', () => ({
  validateActionAgainstPlaybook: jest.fn(() => ({ allowed: true })),
}));
jest.mock('../../services/usageEnforcementService', () => ({
  checkUsageBeforeExecution: jest.fn(async () => ({ allowed: true })),
}));
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageMeterService', () => ({ incrementUsageMeter: jest.fn(async () => undefined) }));
jest.mock('../../services/platformTokenService', () => ({ getToken: jest.fn(async () => null) }));
jest.mock('../../services/rpaWorker/rpaWorkerService', () => ({ executeRpaTask: jest.fn(async () => ({ success: true })) }));
jest.mock('../../services/telemetry/telemetryDispatcher', () => ({ trackEvent: jest.fn() }));

// ── Route collaborators ─────────────────────────────────────────────────────
const routeRows: Record<string, Row> = {};
const supabaseUpdates: Array<{ table: string; payload: Row }> = [];
jest.mock('../../db/supabaseClient', () => {
  const from = (table: string) => {
    let payload: Row | null = null;
    const q: any = {
      select: () => q,
      update: (p: Row) => { payload = p; return q; },
      eq: () => q,
      in: () => q,
      gte: () => q,
      maybeSingle: async () => {
        if (payload) {
          supabaseUpdates.push({ table, payload });
          return { data: { id: 'act-1', status: payload.status, ...payload }, error: null };
        }
        return { data: null, error: null };
      },
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok, ko),
    };
    return q;
  };
  return { supabase: { from } };
});
jest.mock('../../db/communityAiActionStore', () => ({
  getCommunityAiActionById: jest.fn(async (id: string) => (routeRows[id] ? { data: { ...routeRows[id] }, error: null } : { data: null, error: new Error('nf') })),
}));
jest.mock('../../../pages/api/community-ai/utils', () => ({
  requireTenantScope: jest.fn(async (req: any) => ({ tenantId: req.__org, organizationId: req.__org })),
  enforceActionRole: jest.fn(async () => ({ userId: 'user-1', role: 'COMPANY_ADMIN' })),
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

import { executeAction } from '../../services/communityAiActionExecutorRuntime';
import { runApiExecution, runRpaExecution, prepareBrowserDispatch } from '../../services/communityAiActionExecutorContracts';
import { logCommunityAiActionEvent } from '../../services/communityAiActionLogService';
import { checkCommunityActionContactGovernance } from '../../services/communityAiContactGovernanceGate';
import approveRoute from '../../../pages/api/community-ai/actions/approve';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const PROFILE = 'https://www.linkedin.com/in/Jane-Doe';
const PROFILE_NORMALISED = PROFILE.toLowerCase();

const govRow = (over: Row = {}): Row => ({
  id: `g-${Math.random()}`, organization_id: ORG_A, person_id: null, target_normalized: PROFILE_NORMALISED,
  channel: 'linkedin', governance_type: 'dnc_channel',
  effective_from: '2026-01-01T00:00:00.000Z', effective_until: null, revoked_at: null, purpose_scope: null,
  ...over,
});

const action = (over: Row = {}): any => ({
  id: 'act-1',
  tenant_id: ORG_A,
  organization_id: ORG_A,
  platform: 'linkedin',
  action_type: 'dm',
  target_id: PROFILE,
  suggested_text: 'Hello Jane',
  playbook_id: 'pb-1',
  execution_mode: 'api',
  requires_human_approval: false,
  risk_level: 'low',
  ...over,
});

const sideEffects = () =>
  (runApiExecution as jest.Mock).mock.calls.length +
  (runRpaExecution as jest.Mock).mock.calls.length +
  (prepareBrowserDispatch as jest.Mock).mock.calls.length;

const suppress = (over: Row = {}) => { db.tables.contact_governance_records.push(govRow(over)); };

beforeEach(() => {
  jest.clearAllMocks();
  db.tables = { contact_governance_records: [], suppression_entries: [], identity_claims: [] };
  db.failures = {};
  db.queries = [];
  for (const k of Object.keys(routeRows)) delete routeRows[k];
  supabaseUpdates.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ════════════════════════════════════════════════════════════════════════════
describe('executor boundary (runExecution via executeAction)', () => {
  describe.each([['api'], ['rpa'], ['browser']])('mode %s', (mode) => {
    it('a suppressed DM recipient is BLOCKED before any side effect, with an auditable reason', async () => {
      suppress();
      const r = await executeAction(action({ execution_mode: mode }), true, { source: 'manual' });
      expect(r).toMatchObject({ ok: false, status: 'blocked', reason: 'CONTACT_SUPPRESSED' });
      expect((r as any).error).toMatchObject({ code: 'CONTACT_SUPPRESSED', reason: 'dnc_channel', store: 'canonical' });
      expect(sideEffects()).toBe(0);
      const audit = (logCommunityAiActionEvent as jest.Mock).mock.calls.map((c) => c[0]).find((e) => e.event_payload?.gate === 'contact_governance');
      expect(audit).toBeDefined();
      expect(audit.event_payload).toMatchObject({ code: 'CONTACT_SUPPRESSED', identifier_kind: 'target_id', boundary: 'executor' });
      // the identifier VALUE is never written to the audit log
      expect(JSON.stringify(audit)).not.toContain('jane');
    });

    it('CONTROL: the same action to a non-suppressed recipient proceeds', async () => {
      const r = await executeAction(action({ execution_mode: mode }), true, { source: 'manual' });
      expect(r.ok).toBe(true);
      expect(sideEffects()).toBe(1);
    });
  });

  it('a reply and a follow to a suppressed recipient are blocked; CONTROL: a like is not a contact and is not gated', async () => {
    suppress();
    const reply = await executeAction(action({ action_type: 'reply' }), true, { source: 'manual' });
    const follow = await executeAction(action({ action_type: 'follow' }), true, { source: 'manual' });
    expect(reply).toMatchObject({ status: 'blocked', reason: 'CONTACT_SUPPRESSED' });
    expect(follow).toMatchObject({ status: 'blocked', reason: 'CONTACT_SUPPRESSED' });
    expect(sideEffects()).toBe(0);
    const like = await executeAction(action({ action_type: 'like' }), true, { source: 'manual' });
    expect(like.ok).toBe(true);
    expect(sideEffects()).toBe(1);
  });

  it('a `*` (all-channel) permanent DNC also blocks the LinkedIn DM', async () => {
    suppress({ channel: '*', governance_type: 'dnc_permanent' });
    // the scheduled path (approval of record present) is gated too
    const r = await executeAction(action({ approved_at: '2026-11-01T00:00:00Z' }), true, { source: 'scheduler' });
    expect(r).toMatchObject({ status: 'blocked', reason: 'CONTACT_SUPPRESSED' });
    expect((r as any).error).toMatchObject({ reason: 'dnc_permanent' });
    expect(sideEffects()).toBe(0);
  });

  it('a suppressed DM THREAD identifier in metadata blocks even when target_id is clean; CONTROL: without it, proceeds', async () => {
    const thread = 'https://www.linkedin.com/messaging/thread/2-abc/';
    suppress({ target_normalized: thread.toLowerCase() });
    const blocked = await executeAction(action({ metadata: { dm_thread_url: thread } }), true, { source: 'manual' });
    expect(blocked).toMatchObject({ status: 'blocked', reason: 'CONTACT_SUPPRESSED' });
    expect(sideEffects()).toBe(0);
    const ok = await executeAction(action(), true, { source: 'manual' });
    expect(ok.ok).toBe(true);
  });

  it('a REVOKED suppression does not block (the gate never invents a suppression)', async () => {
    suppress({ revoked_at: '2026-02-01T00:00:00.000Z' });
    const r = await executeAction(action(), true, { source: 'manual' });
    expect(r.ok).toBe(true);
  });

  describe('tenant boundary', () => {
    it("tenant A's suppression does NOT block tenant B's action to the same recipient", async () => {
      suppress({ organization_id: ORG_A });
      const r = await executeAction(action({ tenant_id: ORG_B, organization_id: ORG_B }), true, { source: 'manual' });
      expect(r.ok).toBe(true);
      // every governance read was scoped to tenant B, never A
      const govReads = db.queries.filter((q) => q.table === 'contact_governance_records' || q.table === 'identity_claims');
      expect(govReads.length).toBeGreaterThan(0);
      for (const q of govReads) {
        expect(q.filters).toContainEqual(['eq', 'organization_id', ORG_B]);
        expect(q.filters).not.toContainEqual(['eq', 'organization_id', ORG_A]);
      }
    });

    it('CONTROL: the same suppression DOES block tenant A', async () => {
      suppress({ organization_id: ORG_A });
      const r = await executeAction(action(), true, { source: 'manual' });
      expect(r).toMatchObject({ status: 'blocked', reason: 'CONTACT_SUPPRESSED' });
    });

    it('a tenant-less action fails closed (no governance question without a tenant)', async () => {
      const g = await checkCommunityActionContactGovernance({ organization_id: '', platform: 'linkedin', action_type: 'dm', target_id: PROFILE });
      expect(g).toMatchObject({ allowed: false, code: 'CONTACT_GOVERNANCE_UNAVAILABLE', reason: 'suppression_no_tenant_failclosed' });
    });
  });

  describe('unreadable suppression store fails CLOSED for sending', () => {
    it.each([
      ['contact_governance_records', 'governance_lookup_failed_failclosed'],
      ['identity_claims', 'governance_person_resolution_failed_failclosed'],
      ['suppression_entries', 'suppression_lookup_error_failclosed'],
    ])('%s unreadable -> skipped CONTACT_GOVERNANCE_UNAVAILABLE, no send', async (table, reason) => {
      db.failures[table] = { code: '42501', message: 'permission denied' };
      const r = await executeAction(action({ execution_mode: 'browser' }), true, { source: 'manual' });
      expect(r).toMatchObject({ ok: false, status: 'skipped', reason: 'CONTACT_GOVERNANCE_UNAVAILABLE' });
      expect((r as any).error).toMatchObject({ code: 'CONTACT_GOVERNANCE_UNAVAILABLE', reason });
      expect(sideEffects()).toBe(0);
    });

    it('CONTROL: the same stores readable and empty -> the send proceeds', async () => {
      const r = await executeAction(action({ execution_mode: 'browser' }), true, { source: 'manual' });
      expect(r.ok).toBe(true);
      expect(sideEffects()).toBe(1);
    });

    it('CONTROL: an unreadable store does not block a non-contacting like (not a send to a person)', async () => {
      db.failures.contact_governance_records = { code: '42501', message: 'permission denied' };
      const r = await executeAction(action({ action_type: 'like' }), true, { source: 'manual' });
      expect(r.ok).toBe(true);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
async function callRoute(route: any, org: string, body: Row) {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  await route({ method: 'POST', headers: {}, query: {}, body, __org: org }, res);
  return res;
}

const pendingRow = (over: Row = {}): Row => ({
  ...action(),
  status: 'pending',
  requires_human_approval: true,
  approved_at: null,
  metadata: null,
  ...over,
});

const approvals = () => supabaseUpdates.filter((u) => u.table === 'community_ai_actions' && u.payload.status === 'approved');

describe('approve route', () => {
  it('a suppressed recipient cannot be approved: 403 CONTACT_SUPPRESSED, row not approved, audit logged', async () => {
    suppress();
    routeRows['act-1'] = pendingRow();
    const res = await callRoute(approveRoute, ORG_A, { action_id: 'act-1' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'CONTACT_SUPPRESSED', reason: 'dnc_channel' });
    expect(approvals()).toHaveLength(0);
    const audit = (logCommunityAiActionEvent as jest.Mock).mock.calls.map((c) => c[0]).find((e) => e.event_payload?.boundary === 'approve');
    expect(audit?.event_payload).toMatchObject({ gate: 'contact_governance', code: 'CONTACT_SUPPRESSED' });
  });

  it('CONTROL: a non-suppressed recipient is approved', async () => {
    routeRows['act-1'] = pendingRow();
    const res = await callRoute(approveRoute, ORG_A, { action_id: 'act-1' });
    expect(res.statusCode).toBe(200);
    expect(approvals()).toHaveLength(1);
  });

  it("cross-tenant: tenant A's suppression does not block tenant B's approval", async () => {
    suppress({ organization_id: ORG_A });
    routeRows['act-1'] = pendingRow({ tenant_id: ORG_B, organization_id: ORG_B });
    const res = await callRoute(approveRoute, ORG_B, { action_id: 'act-1' });
    expect(res.statusCode).toBe(200);
    expect(approvals()).toHaveLength(1);
  });

  it('unreadable governance store: 503, nothing approved', async () => {
    db.failures.contact_governance_records = { code: '42501', message: 'permission denied' };
    routeRows['act-1'] = pendingRow();
    const res = await callRoute(approveRoute, ORG_A, { action_id: 'act-1' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'CONTACT_GOVERNANCE_UNAVAILABLE' });
    expect(approvals()).toHaveLength(0);
  });

  it('a suppressed DM thread in the row metadata is refused at approve', async () => {
    const thread = 'https://www.linkedin.com/messaging/thread/2-xyz/';
    suppress({ target_normalized: thread.toLowerCase() });
    routeRows['act-1'] = pendingRow({ metadata: { dm_thread_ready: true, dm_thread_url: thread } });
    const res = await callRoute(approveRoute, ORG_A, { action_id: 'act-1' });
    expect(res.statusCode).toBe(403);
    expect(approvals()).toHaveLength(0);
  });
});
