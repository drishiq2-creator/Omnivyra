/**
 * Round 28 — kill-switch caller integration (review H-3 / P-1..P-5).
 *
 * "Disabling the policy prevents execution throughout every relevant caller":
 * caller × policy state → executes / refuses, with the REAL policy service
 * (resolver + fail-closed evaluator) reading an in-memory
 * `community_ai_platform_policy` table. Only I/O and the platform side effects
 * are replaced; every side effect is a spy that a refusal must leave uncalled.
 *
 * Policy states:
 *   none        — the read succeeds, no row (Production today)
 *   unreadable  — the read errors
 *   exec_off    — row, execution_enabled=false
 *   auto_off    — row, execution on, auto_rules_enabled=false
 *   enabled     — row, execution on, auto rules on, approval not required
 *
 * The extension hand-out is in r28KillSwitchHandoutMatrix.test.ts.
 */

type Row = Record<string, unknown>;
type PolicyMode = 'none' | 'unreadable' | 'exec_off' | 'auto_off' | 'enabled';

const mockDb: {
  mode: PolicyMode;
  policyReads: number;
  tables: Record<string, Row[]>;
  reads: string[];
  inserts: { table: string; row: Row }[];
  updates: { table: string; row: Row }[];
} = { mode: 'none', policyReads: 0, tables: {}, reads: [], inserts: [], updates: [] };

const mockPolicyRow = (): Row | null => {
  switch (mockDb.mode) {
    case 'exec_off': return { execution_enabled: false, auto_rules_enabled: true, require_human_approval: false, updated_at: '2026-11-27T00:00:00Z', updated_by: null };
    case 'auto_off': return { execution_enabled: true, auto_rules_enabled: false, require_human_approval: false, updated_at: '2026-11-27T00:00:00Z', updated_by: null };
    case 'enabled': return { execution_enabled: true, auto_rules_enabled: true, require_human_approval: false, updated_at: '2026-11-27T00:00:00Z', updated_by: null };
    default: return null;
  }
};

function mockBuilder(table: string) {
  let rows: Row[] = [...(mockDb.tables[table] ?? [])];
  let op: 'select' | 'insert' | 'update' = 'select';
  const b: Record<string, unknown> = {};
  const chain = () => b;
  const settle = async () => {
    if (table === 'community_ai_platform_policy') {
      mockDb.policyReads += 1;
      if (mockDb.mode === 'unreadable') return { data: null, error: { code: '57014', message: 'statement timeout' } };
      const r = mockPolicyRow();
      return { data: r ? [r] : [], error: null };
    }
    if (op === 'select') mockDb.reads.push(table);
    return { data: rows, error: null, count: rows.length };
  };
  Object.assign(b, {
    select: chain, order: chain, gte: chain, lte: chain, lt: chain, gt: chain, neq: chain, not: chain, is: chain, limit: chain,
    eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === undefined || r[c] === v); return b; },
    in: chain,
    insert: (row: Row) => { op = 'insert'; mockDb.inserts.push({ table, row }); return b; },
    update: (row: Row) => { op = 'update'; mockDb.updates.push({ table, row }); return b; },
    upsert: (row: Row) => { op = 'insert'; mockDb.inserts.push({ table, row }); return b; },
    delete: () => { op = 'update'; return b; },
    maybeSingle: async () => { const r = await settle(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }; },
    single: async () => { const r = await settle(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }; },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej),
  });
  return b;
}
const mockSupabase = { from: (t: string) => mockBuilder(t), rpc: async () => ({ data: null, error: null }) };
jest.mock('../../db/supabaseClient', () => ({ supabase: mockSupabase, default: mockSupabase }));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => mockBuilder(t) }));

// ── platform side effects (spies) ────────────────────────────────────────────
jest.mock('../../services/communityAiActionExecutorContracts', () => {
  const actual = jest.requireActual('../../services/communityAiActionExecutorContracts');
  return {
    ...actual,
    recordExecutionMetric: jest.fn(async () => undefined),
    resolveExecutionMode: jest.fn(async () => 'api'),
    loadHistoryMetrics: jest.fn(async () => null),
    runApiExecution: jest.fn(async () => ({ ok: true, status: 'executed', execution_mode: 'api' })),
    runRpaExecution: jest.fn(async () => ({ ok: true, status: 'executed', execution_mode: 'rpa' })),
    prepareBrowserDispatch: jest.fn(() => ({ ok: true, status: 'dispatched', execution_mode: 'browser' })),
  };
});
jest.mock('../../services/communityAiContactGovernanceGate', () => ({
  checkCommunityActionContactGovernance: jest.fn(async () => ({ allowed: true, reason: 'not_suppressed', checked: 1 })),
  contactGateAuditPayload: jest.fn(() => ({})),
}));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
const mockListPlaybooks = jest.fn(async () => []);
jest.mock('../../services/playbooks/playbookService', () => ({
  getPlaybookById: jest.fn(async () => ({ id: 'pb-1', name: 'Engage', status: 'active' })),
  listPlaybooks: (...a: unknown[]) => (mockListPlaybooks as unknown as (...x: unknown[]) => unknown)(...a),
}));
jest.mock('../../services/playbooks/playbookValidator', () => ({ validateActionAgainstPlaybook: jest.fn(() => ({ allowed: true })) }));
jest.mock('../../services/playbooks/playbookEvaluator', () => ({ evaluatePlaybookForEvent: jest.fn(() => null) }));
jest.mock('../../services/usageEnforcementService', () => ({ checkUsageBeforeExecution: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageMeterService', () => ({ incrementUsageMeter: jest.fn(async () => undefined) }));
jest.mock('../../services/platformTokenService', () => ({ getToken: jest.fn(async () => null) }));
jest.mock('../../services/executionGuardrailService', () => ({ canExecuteAction: jest.fn(async () => ({ allowed: true })) }));

// RPA worker internals: the Playwright run is the side effect.
const mockRunRpaScript = jest.fn(async () => ({ success: true }));
jest.mock('../../services/rpaWorker/rpaPlaywrightRunner', () => ({ runRpaScript: (...a: unknown[]) => (mockRunRpaScript as unknown as (...x: unknown[]) => unknown)(...a) }));
jest.mock('../../services/rpaWorker/rpaPlatformScripts', () => ({ buildScript: () => ({ steps: [] }) }));
jest.mock('../../services/rpaWorker/rpaEnv', () => ({
  rpaEnvReady: async () => ({ ok: true }),
  assertRpaEnvReady: async () => undefined,
  isProbeFailure: (r: { ok: boolean }) => r.ok === false,
  getRpaEnvProbeDiagnostics: () => ({ failure_streak: 0, next_probe_in_s: 0 }),
}));
jest.mock('../../services/rpaWorker/rpaQueueState', () => ({ admitRpaTask: async () => ({ admit: true }), observeAllActiveOrgs: async () => ({}) }));
jest.mock('../../services/rpaWorker/rpaTaskQueue', () => ({ enqueueRpaTask: jest.fn(), startRpaWorker: jest.fn() }));
jest.mock('../../queue/bullmqClient', () => ({ withHeavyJobSlot: (fn: () => unknown) => fn() }));
const RPA_TASK = {
  tenant_id: 'org-1', organization_id: 'org-1', platform: 'linkedin', action_type: 'reply',
  target_url: 'https://www.linkedin.com/feed/update/urn:li:activity:1', text: 'thanks', action_id: 'act-rpa',
};
jest.mock('../../services/rpaWorker/rpaRetryQueue', () => ({
  enqueueRpaRetry: jest.fn(async () => ({ queued: true })),
  countDueRpaRetries: async () => ({ due: 1, error: null }),
  flushRpaRetryQueueRoundRobin: async (input: { handler: (t: unknown) => Promise<{ success: boolean }> }) => {
    const r = await input.handler(RPA_TASK);
    return { orgs_visited: 1, claimed: 1, succeeded: r.success ? 1 : 0, failed: r.success ? 0 : 1, unknown: 0, errors: 0, remaining: 0 };
  },
}));

import { executeAction } from '../../services/communityAiActionExecutorRuntime';
import { runApiExecution } from '../../services/communityAiActionExecutorContracts';
import { __resetCommunityAiPlatformPolicyCacheForTests } from '../../services/communityAiPlatformPolicyService';
import { runCommunityAiScheduler } from '../../services/communityAiScheduler';
import { evaluateAutoRules } from '../../services/communityAiAutoRuleService';
import { rpaSchedulerHooks, checkRpaRetryAuthorised } from '../../services/rpaWorker/rpaWorkerService';

const STATES: PolicyMode[] = ['none', 'unreadable', 'exec_off', 'auto_off', 'enabled'];
const APPROVED_AT = '2026-11-26T10:00:00.000Z';

const action = (over: Row = {}) => ({
  id: 'act-1', tenant_id: 'org-1', organization_id: 'org-1', platform: 'linkedin', action_type: 'reply',
  target_id: 'urn:li:comment:1', suggested_text: 'Thanks!', playbook_id: 'pb-1', execution_mode: 'api',
  requires_human_approval: false, risk_level: 'low', ...over,
}) as any;

beforeEach(() => {
  jest.clearAllMocks();
  __resetCommunityAiPlatformPolicyCacheForTests();
  mockDb.mode = 'none';
  mockDb.policyReads = 0;
  mockDb.tables = {};
  mockDb.reads = [];
  mockDb.inserts = [];
  mockDb.updates = [];
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'debug').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const setMode = (m: PolicyMode) => { mockDb.mode = m; __resetCommunityAiPlatformPolicyCacheForTests(); };

// ── executor (every executeAction caller) ────────────────────────────────────
type Expect = 'executes' | 'refuses';
const EXECUTOR_MATRIX: Array<[string, Record<string, unknown>, Row, Record<PolicyMode, Expect>]> = [
  // human-initiated: manual sends stay available per execution_enabled
  ['manual (human click)', { source: 'manual' }, {}, { none: 'executes', unreadable: 'refuses', exec_off: 'refuses', auto_off: 'executes', enabled: 'executes' }],
  ['bulk (human bulk click)', { source: 'bulk' }, {}, { none: 'executes', unreadable: 'refuses', exec_off: 'refuses', auto_off: 'executes', enabled: 'executes' }],
  // automated: fail closed on missing / unreadable / disabled
  ['auto rules (source auto)', { source: 'auto' }, {}, { none: 'refuses', unreadable: 'refuses', exec_off: 'refuses', auto_off: 'refuses', enabled: 'executes' }],
  ['automationService (auto: true)', { source: 'auto', auto: true }, {}, { none: 'refuses', unreadable: 'refuses', exec_off: 'refuses', auto_off: 'refuses', enabled: 'executes' }],
  ['auto flag with a manual source', { source: 'manual', auto: true }, {}, { none: 'refuses', unreadable: 'refuses', exec_off: 'refuses', auto_off: 'refuses', enabled: 'executes' }],
  ['scheduler, approved row', { source: 'scheduler' }, { approved_at: APPROVED_AT }, { none: 'refuses', unreadable: 'refuses', exec_off: 'refuses', auto_off: 'executes', enabled: 'executes' }],
  ['scheduler, no approval of record', { source: 'scheduler' }, {}, { none: 'refuses', unreadable: 'refuses', exec_off: 'refuses', auto_off: 'refuses', enabled: 'refuses' }],
  // P-2 fail-open fixed: no / unknown source is NOT manual
  ['missing source', {}, {}, { none: 'refuses', unreadable: 'refuses', exec_off: 'refuses', auto_off: 'refuses', enabled: 'refuses' }],
  ['unknown source', { source: 'cron' }, {}, { none: 'refuses', unreadable: 'refuses', exec_off: 'refuses', auto_off: 'refuses', enabled: 'refuses' }],
];

describe('executor: caller × policy state', () => {
  for (const [name, opts, over, expected] of EXECUTOR_MATRIX) {
    describe(name, () => {
      it.each(STATES.map((st) => [st, expected[st]] as const))('policy %s → %s', async (state) => {
        setMode(state);
        const result = await executeAction(action(over), true, opts as any);
        expect(mockDb.policyReads).toBe(1); // the scenario exists: the policy was consulted
        if (expected[state] === 'executes') {
          expect(result).toMatchObject({ ok: true, status: 'executed' });
          expect(runApiExecution).toHaveBeenCalledTimes(1);
        } else {
          expect(result).toMatchObject({ ok: false, status: 'skipped' });
          expect(runApiExecution).not.toHaveBeenCalled();
        }
      });
    });
  }

  it('a refusal carries the evaluator reason code (missing row, scheduler)', async () => {
    setMode('none');
    const r = await executeAction(action({ approved_at: APPROVED_AT }), true, { source: 'scheduler' });
    expect(r).toMatchObject({ reason: 'PLATFORM_POLICY', policy_reason_code: 'policy_missing_fail_closed' });
  });

  it('an unknown source is refused initiator_unknown even under a fully enabled row', async () => {
    setMode('enabled');
    const r = await executeAction(action(), true, { source: 'cron' } as any);
    expect(r).toMatchObject({ reason: 'PLATFORM_POLICY', policy_reason_code: 'initiator_unknown' });
  });
});

// ── auto_insert approval of record (review K-1) ──────────────────────────────
describe('auto_insert approval of record', () => {
  const insertedApprovedAt = () =>
    mockDb.inserts.filter((i) => i.table === 'community_ai_actions').map((i) => i.row.approved_at ?? null);

  it.each([
    ['manual', { source: 'manual' }, true],
    ['bulk', { source: 'bulk' }, true],
    ['auto', { source: 'auto', auto: true }, false],
  ] as const)('%s insert stamps approved_at: %s', async (_n, opts, stamped) => {
    setMode('enabled');
    await executeAction(action(), true, { ...opts, persist: true, auto_insert: true } as any);
    const values = insertedApprovedAt();
    expect(values).toHaveLength(1); // the insert happened
    if (stamped) expect(typeof values[0]).toBe('string');
    else expect(values[0]).toBeNull();
  });
});

// ── community scheduler tick (P-1) ───────────────────────────────────────────
describe('community scheduler tick', () => {
  const RUNS: Record<PolicyMode, boolean> = { none: false, unreadable: false, exec_off: false, auto_off: true, enabled: true };
  it.each(STATES)('policy %s', async (state) => {
    setMode(state);
    const r = await runCommunityAiScheduler(new Date('2026-11-27T00:00:00Z'));
    expect(mockDb.policyReads).toBe(1);
    expect(r).toMatchObject({ processed: 0, executed: 0 });
    const readActions = mockDb.reads.includes('community_ai_actions');
    expect(readActions).toBe(RUNS[state]);
    if (!RUNS[state]) {
      const audit = mockDb.inserts.find((i) => i.table === 'audit_logs');
      expect(audit?.row).toMatchObject({ action: 'COMMUNITY_AI_PLATFORM_POLICY_BLOCK' });
    }
  });
});

// ── auto rules tick (P-5) ────────────────────────────────────────────────────
describe('auto-rule evaluation tick', () => {
  const RUNS: Record<PolicyMode, boolean> = { none: false, unreadable: false, exec_off: false, auto_off: false, enabled: true };
  it.each(STATES)('policy %s', async (state) => {
    setMode(state);
    const r = await evaluateAutoRules({ tenant_id: 'org-1', organization_id: 'org-1', platform: 'linkedin', suggested_actions: [] } as any);
    expect(mockDb.policyReads).toBe(1);
    expect(r).toMatchObject({ autoExecuted: 0 });
    expect(mockListPlaybooks.mock.calls.length > 0).toBe(RUNS[state]);
  });
});

// ── RPA retry flush (P-3 + D2 suppression, one gate) ─────────────────────────
describe('RPA retry flush', () => {
  const approvedFailedRow = (over: Row = {}): Row => ({
    id: 'act-rpa', organization_id: 'org-1', status: 'failed', approved_at: APPROVED_AT,
    platform: 'linkedin', action_type: 'reply', target_id: RPA_TASK.target_url, ...over,
  });
  const RUNS: Record<PolicyMode, boolean> = { none: false, unreadable: false, exec_off: false, auto_off: true, enabled: true };

  it.each(STATES)('policy %s (approved row due)', async (state) => {
    setMode(state);
    mockDb.tables.community_ai_actions = [approvedFailedRow()];
    const r = await rpaSchedulerHooks.flushRetries({ limit_per_org: 10, max_orgs: 10 });
    expect(mockDb.policyReads).toBeGreaterThanOrEqual(1);
    expect(mockRunRpaScript.mock.calls.length).toBe(RUNS[state] ? 1 : 0);
    if (!RUNS[state]) expect(r).toMatchObject({ skipped_policy: 1, claimed: 0 });
  });

  it.each([
    ['none', 'RPA_RETRY_POLICY_MISSING'],
    ['unreadable', 'RPA_RETRY_POLICY_UNREADABLE'],
    ['exec_off', 'RPA_RETRY_EXECUTION_DISABLED'],
  ] as const)('checkRpaRetryAuthorised refuses under %s before reading the action row', async (state, reason) => {
    setMode(state);
    mockDb.tables.community_ai_actions = [approvedFailedRow()];
    const g = await checkRpaRetryAuthorised(RPA_TASK as any);
    expect(g).toMatchObject({ ok: false, reason });
    expect(mockDb.reads).not.toContain('community_ai_actions');
  });

  it('an unapproved row is refused under an enabled row; CONTROL: the approved row is allowed', async () => {
    setMode('enabled');
    mockDb.tables.community_ai_actions = [approvedFailedRow({ approved_at: null })];
    expect(await checkRpaRetryAuthorised(RPA_TASK as any)).toMatchObject({ ok: false, reason: 'RPA_RETRY_NOT_APPROVED' });
    mockDb.tables.community_ai_actions = [approvedFailedRow()];
    expect(await checkRpaRetryAuthorised(RPA_TASK as any)).toEqual({ ok: true });
  });

  it('a lost-response row (stored skipped) is never re-run', async () => {
    setMode('enabled');
    mockDb.tables.community_ai_actions = [approvedFailedRow({ status: 'skipped', skip_reason: 'OUTCOME_UNKNOWN' })];
    expect(await checkRpaRetryAuthorised(RPA_TASK as any)).toMatchObject({ ok: false, reason: 'RPA_RETRY_ACTION_NOT_RETRYABLE' });
  });
});
