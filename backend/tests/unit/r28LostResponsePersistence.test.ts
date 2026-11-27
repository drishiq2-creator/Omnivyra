/**
 * Round 28 — RPA lost-response handling (review M-6) and "never persist
 * sent_unverified" (Task 3), against a SCHEMA-FAITHFUL table double.
 *
 * Production `community_ai_actions_status_check` admits ONLY
 *   pending | approved | executed | failed | skipped
 * and the table has no `metadata` column. The double below rejects any write
 * whose status is outside the CHECK or that names a column Production does not
 * have, exactly like PostgREST would (error, row unchanged).
 *
 *   - an unknown RPA outcome (post-interaction miss, executor timeout) is
 *     neither success nor failure: in memory `skipped` / OUTCOME_UNKNOWN, on
 *     disk `skipped` + skip_reason OUTCOME_UNKNOWN, evidence in
 *     execution_result, idempotency key kept;
 *   - `sent_unverified` is never written: `skipped` + skip_reason
 *     SENT_UNVERIFIED (executed_at stamped: the send was issued);
 *   - every executor status maps into the CHECK.
 */

// Production column list (repo baseline supabase/_schema/baseline.sql:167-206
// plus the three CT-verified Production-only columns). NO `metadata`.
const PROD_COLUMNS = new Set([
  'id', 'tenant_id', 'organization_id', 'platform', 'action_type', 'target_id', 'suggested_text', 'tone',
  'risk_level', 'requires_human_approval', 'status', 'execution_result', 'created_at', 'updated_at',
  'scheduled_at', 'tone_used', 'requires_approval', 'final_text', 'execution_mode', 'playbook_id',
  'playbook_name', 'intent_classification', 'discovered_user_id', 'executed_at', 'skip_reason',
  'execution_correlation_id', 'approved_at', 'dispatch_lease_id', 'dispatch_lease_expires_at',
  'dispatch_lease_holder_id', 'dispatch_acknowledged_at', 'idempotency_key', 'command_chain',
  'command_chain_index', 'cancel_requested_at', 'acting_user_id',
  'submit_attempted_at', 'pre_submit_evidence', 'post_submit_evidence',
]);
const PROD_STATUS_CHECK = new Set(['pending', 'approved', 'executed', 'failed', 'skipped']);

type Row = Record<string, any>;
const mockStore: { rows: Row[]; rejected: { reason: string; patch: Row }[] } = { rows: [], rejected: [] };

const schemaViolation = (patch: Row): string | null => {
  for (const k of Object.keys(patch)) if (!PROD_COLUMNS.has(k)) return `column "${k}" does not exist`;
  if ('status' in patch && !PROD_STATUS_CHECK.has(String(patch.status))) {
    return 'new row for relation "community_ai_actions" violates check constraint "community_ai_actions_status_check"';
  }
  return null;
};

function mockActions(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  let insertRow: Row | null = null;
  const q: any = {
    select: () => q,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
    in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
    is: () => q, order: () => q, limit: () => q,
    update: (p: Row) => { patch = p; return q; },
    insert: (p: Row) => { insertRow = p; return q; },
    maybeSingle: async () => {
      if (table !== 'community_ai_actions') return { data: null, error: null };
      if (insertRow) {
        const v = schemaViolation(insertRow);
        if (v) { mockStore.rejected.push({ reason: v, patch: insertRow }); return { data: null, error: { code: '23514', message: v } }; }
        mockStore.rows.push({ ...insertRow });
        return { data: insertRow, error: null };
      }
      const hit = mockStore.rows.find((r) => filters.every((f) => f(r)));
      if (patch) {
        const v = schemaViolation(patch);
        if (v) { mockStore.rejected.push({ reason: v, patch }); return { data: null, error: { code: '23514', message: v } }; }
        if (hit) Object.assign(hit, patch);
        return { data: hit ? { id: hit.id, status: hit.status } : null, error: null };
      }
      return { data: hit ? { ...hit } : null, error: null };
    },
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      if (insertRow && table === 'community_ai_actions') {
        const v = schemaViolation(insertRow);
        if (v) { mockStore.rejected.push({ reason: v, patch: insertRow }); return Promise.resolve({ data: null, error: { code: '23514', message: v } }).then(ok, ko); }
        mockStore.rows.push({ ...insertRow });
      }
      return Promise.resolve({ data: [], error: null }).then(ok, ko);
    },
  };
  return q;
}
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => mockActions(t) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => mockActions(t) } }));

const mockExecuteRpaTask = jest.fn();
jest.mock('../../services/rpaWorker/rpaWorkerService', () => ({
  executeRpaTask: (...a: unknown[]) => mockExecuteRpaTask(...a),
}));
jest.mock('../../services/communityAiPlatformPolicyService', () =>
  jest.requireActual('../helpers/communityAiPolicyMock').policyServiceMock(
    () => ({ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false })));
jest.mock('../../services/communityAiContactGovernanceGate', () => ({
  checkCommunityActionContactGovernance: jest.fn(async () => ({ allowed: true, reason: 'not_suppressed', checked: 1 })),
  contactGateAuditPayload: jest.fn(() => ({})),
}));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
jest.mock('../../services/playbooks/playbookService', () => ({ getPlaybookById: jest.fn(async () => null) }));
jest.mock('../../services/playbooks/playbookValidator', () => ({ validateActionAgainstPlaybook: jest.fn(() => ({ allowed: true })) }));
jest.mock('../../services/usageEnforcementService', () => ({ checkUsageBeforeExecution: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageMeterService', () => ({ incrementUsageMeter: jest.fn(async () => undefined) }));
jest.mock('../../services/platformTokenService', () => ({ getToken: jest.fn(async () => null) }));

import {
  toPersistedCommunityActionStatus,
  presentCommunityActionStatus,
  COMMUNITY_AI_ACTION_DB_STATUSES,
} from '../../services/communityAiPersistedStatus';
import { runRpaExecution, EXECUTION_TIMEOUTS_MS } from '../../services/communityAiActionExecutorContracts';
import { executeAction, persistExecutionResult as persistRuntime } from '../../services/communityAiActionExecutorRuntime';
import { persistExecutionResult as persistLightweight } from '../../services/communityAiExecutionResultService';

const ORG = 'org-1';
const rpaAction = (over: Row = {}): any => ({
  id: 'act-rpa', tenant_id: ORG, organization_id: ORG, platform: 'linkedin', action_type: 'reply',
  target_id: 'https://www.linkedin.com/feed/update/urn:li:activity:1', suggested_text: 'thanks',
  playbook_id: null, execution_mode: 'rpa', requires_human_approval: false, risk_level: 'low', ...over,
});
const seedRow = (over: Row = {}) => {
  mockStore.rows.push({ id: 'act-1', organization_id: ORG, status: 'pending', idempotency_key: null, ...over });
};

beforeEach(() => {
  mockStore.rows = [];
  mockStore.rejected = [];
  mockExecuteRpaTask.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('the table double is schema-faithful (control)', () => {
  it('rejects sent_unverified, blocked and a metadata column, as Production does', async () => {
    seedRow();
    const { ownedDbTable } = jest.requireMock('../../db/writeOwner');
    for (const patch of [{ status: 'sent_unverified' }, { status: 'blocked' }, { status: 'executing' }, { metadata: {} }]) {
      const r = await ownedDbTable('community_ai_actions').update(patch).eq('id', 'act-1').select('id').maybeSingle();
      expect(r.error).toMatchObject({ code: '23514' });
    }
    expect(mockStore.rows[0].status).toBe('pending');
  });
});

describe('status mapping into the Production CHECK', () => {
  it.each([
    ['executed', 'executed', null],
    ['failed', 'failed', null],
    ['dispatched', 'pending', null],
    ['sent_unverified', 'skipped', 'SENT_UNVERIFIED'],
    ['blocked', 'skipped', 'CONTACT_SUPPRESSED'],
    ['skipped', 'skipped', 'OUTCOME_UNKNOWN'],
    ['executing', 'skipped', 'UNMAPPED_STATUS:executing'],
  ])('%s → %s (%s)', (status, db, reason) => {
    const reasonIn = status === 'blocked' ? 'CONTACT_SUPPRESSED' : status === 'skipped' ? 'OUTCOME_UNKNOWN' : undefined;
    const out = toPersistedCommunityActionStatus({ status, reason: reasonIn });
    expect(out).toEqual({ status: db, skip_reason: reason });
    expect(COMMUNITY_AI_ACTION_DB_STATUSES.has(out.status)).toBe(true);
  });

  it('presents a stored lost-response row as sent_unverified, never for a plain skip', () => {
    expect(presentCommunityActionStatus({ status: 'skipped', skip_reason: 'SENT_UNVERIFIED' })).toBe('sent_unverified');
    expect(presentCommunityActionStatus({ status: 'skipped', skip_reason: 'OUTCOME_UNKNOWN' })).toBe('sent_unverified');
    expect(presentCommunityActionStatus({ status: 'skipped', skip_reason: 'PLATFORM_POLICY' })).toBe('skipped');
    expect(presentCommunityActionStatus({ status: 'executed', skip_reason: null })).toBe('executed');
  });
});

describe('RPA lost response (runRpaExecution)', () => {
  it('a post-interaction miss (outcome_unknown) is OUTCOME_UNKNOWN, not failed', async () => {
    mockExecuteRpaTask.mockResolvedValue({ success: false, outcome_unknown: true, error: 'RPA_OUTCOME_UNKNOWN:RPA_POST_CONDITION_FAILED' });
    const r = await runRpaExecution(rpaAction());
    expect(mockExecuteRpaTask).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, status: 'skipped', reason: 'OUTCOME_UNKNOWN', execution_mode: 'rpa' });
    expect(r.response).toMatchObject({ outcome_unknown: true });
  });

  it('the executor timeout (task may still be posting) is OUTCOME_UNKNOWN, not failed', async () => {
    jest.useFakeTimers();
    mockExecuteRpaTask.mockImplementation(() => new Promise(() => undefined)); // never settles
    const p = runRpaExecution(rpaAction());
    await jest.advanceTimersByTimeAsync(EXECUTION_TIMEOUTS_MS.rpa + 1);
    const r = await p;
    expect(r).toMatchObject({ ok: false, status: 'skipped', reason: 'OUTCOME_UNKNOWN' });
    expect(r.response).toMatchObject({ outcome_unknown: true, timeout: true });
  });

  it('CONTROL: a definite, pre-side-effect failure stays failed (retryable)', async () => {
    mockExecuteRpaTask.mockResolvedValue({ success: false, error: 'RPA_ENV_NOT_READY:chromium' });
    expect(await runRpaExecution(rpaAction())).toMatchObject({ ok: false, status: 'failed', error: 'RPA_ENV_NOT_READY:chromium' });
  });

  it('CONTROL: a confirmed run is executed', async () => {
    mockExecuteRpaTask.mockResolvedValue({ success: true, platform_id: 'urn:li:comment:9' });
    expect(await runRpaExecution(rpaAction())).toMatchObject({ ok: true, status: 'executed' });
  });

  it('end to end: an unknown outcome persists as skipped/OUTCOME_UNKNOWN with evidence and the idempotency key', async () => {
    mockExecuteRpaTask.mockResolvedValue({ success: false, outcome_unknown: true, error: 'RPA_OUTCOME_UNKNOWN:Target closed' });
    mockStore.rows.push({ id: 'act-rpa', organization_id: ORG, status: 'approved', approved_at: '2026-11-27T00:00:00Z' });
    const r = await executeAction(rpaAction({ approved_at: '2026-11-27T00:00:00Z' }), true, {
      source: 'manual', persist: true, idempotency_key: 'idem-rpa-1',
    });
    expect(r).toMatchObject({ ok: false, status: 'skipped', reason: 'OUTCOME_UNKNOWN' });
    expect(mockStore.rejected).toEqual([]);
    const row = mockStore.rows.find((x) => x.id === 'act-rpa')!;
    expect(row).toMatchObject({ status: 'skipped', skip_reason: 'OUTCOME_UNKNOWN', idempotency_key: 'idem-rpa-1' });
    expect(row.execution_result).toMatchObject({ status: 'skipped', reason: 'OUTCOME_UNKNOWN', response: { outcome_unknown: true } });
    expect(row.executed_at).toBeUndefined(); // no claim of a send
  });
});

describe.each([
  ['runtime persistExecutionResult', persistRuntime],
  ['communityAiExecutionResultService persistExecutionResult', persistLightweight],
])('%s never writes a status outside the CHECK', (_name, persist) => {
  it('sent_unverified → skipped + SENT_UNVERIFIED, executed_at stamped, key kept', async () => {
    seedRow();
    const out = await (persist as any)({
      actionId: 'act-1', organizationId: ORG, correlationId: 'corr-1', idempotencyKey: 'idem-1',
      result: { ok: true, status: 'sent_unverified', execution_mode: 'browser', response: { confirmed: false } },
    });
    expect(mockStore.rejected).toEqual([]);
    expect(out).toMatchObject({ ok: true });
    expect(mockStore.rows[0]).toMatchObject({ status: 'skipped', skip_reason: 'SENT_UNVERIFIED', idempotency_key: 'idem-1' });
    expect(typeof mockStore.rows[0].executed_at).toBe('string');
    expect(mockStore.rows[0].execution_result).toMatchObject({ status: 'sent_unverified', response: { confirmed: false } });
  });

  it('blocked → skipped + its reason', async () => {
    seedRow();
    await (persist as any)({
      actionId: 'act-1', organizationId: ORG, correlationId: 'corr-1',
      result: { ok: false, status: 'blocked', reason: 'CONTACT_SUPPRESSED' },
    });
    expect(mockStore.rejected).toEqual([]);
    expect(mockStore.rows[0]).toMatchObject({ status: 'skipped', skip_reason: 'CONTACT_SUPPRESSED' });
  });

  it('CONTROL: executed is written as executed', async () => {
    seedRow();
    await (persist as any)({
      actionId: 'act-1', organizationId: ORG, correlationId: 'corr-1',
      result: { ok: true, status: 'executed', execution_mode: 'api' },
    });
    expect(mockStore.rejected).toEqual([]);
    expect(mockStore.rows[0].status).toBe('executed');
    expect(mockStore.rows[0].skip_reason).toBeUndefined();
  });
});
