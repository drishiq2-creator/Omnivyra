/**
 * Owner decision 2026-11-22: a plan-limit restriction is a distinct action status, 'blocked' - never an execution
 * failure, never left in 'executing'. The REAL executor and its REAL terminal write run here; only the database, the
 * usage-limit check and the outside world are doubles.
 *   - the plan limit refuses -> nothing is sent, the row moves to 'blocked' (from 'executing'), its lease is cleared,
 *     the reason (PLAN_LIMIT_EXCEEDED) is stored, no 'execution_failed' metric, no usage recorded;
 *   - CONTROL: the limit allows -> the row is executed (proves the test reaches the send and the terminal write).
 */
type Row = Record<string, any>;
let row: Row;
const metricEvents: Row[] = [];

function table(name: string) {
  const filters: Array<[string, unknown]> = [];
  let patch: Row | null = null;
  let inserted: Row | null = null;
  const result = () => {
    if (name === 'community_ai_execution_metric_events' && inserted) { metricEvents.push(inserted); return { data: null, error: null }; }
    if (name === 'community_ai_actions' && patch) {
      const hit = filters.every(([k, v]) => row[k] === v);
      if (hit) row = { ...row, ...patch };
      return { data: hit ? { id: row.id, status: row.status } : null, error: null };
    }
    return { data: [], error: null };
  };
  const q: any = {
    select: () => q, order: () => q, limit: () => q, gte: () => q, lte: () => q, in: () => q, is: () => q,
    eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
    update: (p: Row) => { patch = p; return q; },
    insert: (r: Row) => { inserted = r; return q; },
    maybeSingle: async () => result(),
    single: async () => result(),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
  };
  return q;
}

jest.mock('../../db/writeOwner', () => ({ ownedDbTable: jest.fn((t: string) => table(t)) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: jest.fn((t: string) => table(t)) } }));
jest.mock('../../services/communityAiPlatformPolicyService', () => ({
  getCommunityAiPlatformPolicy: jest.fn(async () => ({ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false })),
}));
const usageCheck = jest.fn(async () => ({ allowed: true }));
jest.mock('../../services/usageEnforcementService', () => ({ checkUsageBeforeExecution: (...a: unknown[]) => usageCheck(...(a as [])) }));
const logUsage = jest.fn(async () => undefined);
const meter = jest.fn(async () => undefined);
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: (...a: unknown[]) => logUsage(...(a as [])) }));
jest.mock('../../services/usageMeterService', () => ({ incrementUsageMeter: (...a: unknown[]) => meter(...(a as [])) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/platformTokenService', () => ({ getToken: jest.fn(async () => ({ access_token: 't' })) }));
jest.mock('../../services/rpaWorker/rpaWorkerService', () => ({ executeRpaTask: jest.fn(async () => ({ success: true })) }));
const send = jest.fn(async () => ({ success: true, platform_id: 'urn:li:comment:(1,2)', platform_response: {} }));
jest.mock('../../services/platformConnectors/linkedinConnector', () => ({ executeAction: (...a: unknown[]) => send(...(a as [])) }));

import { executeAction } from '../../services/communityAiActionExecutor';

const action = () => ({
  id: 'act-1', tenant_id: 'org-1', organization_id: 'org-1', platform: 'linkedin', action_type: 'reply' as const,
  target_id: 'urn:li:share:1', suggested_text: 'thanks!', playbook_id: null, execution_mode: 'api' as const,
});

beforeEach(() => {
  row = { id: 'act-1', organization_id: 'org-1', status: 'executing', dispatch_lease_id: 'lease-x', dispatch_lease_holder_id: 'h', dispatch_lease_expires_at: 'later' };
  metricEvents.length = 0;
  [usageCheck, logUsage, meter, send].forEach((m) => m.mockClear());
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("plan-limit restriction -> 'blocked' (owner 2026-11-22)", () => {
  it('the plan limit refuses: nothing sent; executing -> blocked with the reason; lease cleared; no failure metric; no usage', async () => {
    usageCheck.mockResolvedValueOnce({ allowed: false, limit: 100, used: 100 } as any);
    const result = await executeAction(action(), true, { source: 'manual', persist: true, notify: false, webhook: false });
    expect(result.status).toBe('blocked');
    expect(send).not.toHaveBeenCalled();
    expect(row.status).toBe('blocked');                                   // never left in 'executing'
    expect(row.execution_result.error.code).toBe('PLAN_LIMIT_EXCEEDED');  // the reason the UI shows
    expect([row.dispatch_lease_id, row.dispatch_lease_holder_id, row.dispatch_lease_expires_at]).toEqual([null, null, null]);
    expect(metricEvents.map((m) => m.event_type)).not.toContain('execution_failed');
    expect(logUsage).not.toHaveBeenCalled();
    expect(meter).not.toHaveBeenCalled();
  });

  it('CONTROL: the limit allows -> sent and executed (the test reaches the send and the terminal write)', async () => {
    const result = await executeAction(action(), true, { source: 'manual', persist: true, notify: false, webhook: false });
    expect(result.status).toBe('executed');
    expect(send).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('executed');
  });
});
