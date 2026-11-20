/**
 * PI-LDB 0004 NOT APPLIED -> the AI mapping proposal is REFUSED before any model call (7c + b3, 2026-11-20).
 *
 * lead_attribute_mapping is FIXED-priced: runBilledAiCompletion's fixedPricing mode calls runBilledOperation with NO
 * llmPricing (pinned in sec91DGatewaySpend "FIXED ... asked for its FIXED path"), whose fixed branch is
 * executeWithCredits without llmPricing. There the price is `getCreditCost(action)`
 * (creditExecutionServiceRuntimeCore.ts:143-145), BEFORE the executor runs (:~323). getCreditCost THROWS on a
 * missing credit_cost_config row (creditDeductionService.ts:163). This drives the REAL executeWithCredits with the
 * row absent and asserts the executor - the AI call - never runs. Control: the row present (2) -> it runs once.
 * The engine half (a throwing billed call -> ONE degraded entry, deterministic mapping) is pinned in
 * leadMappingGatewayProposer "a gateway outage degrades the run".
 *
 * Failure this guards: an UNPRICED AI call that still runs.
 */
export {};

const mockGetCreditCost = jest.fn();
const mockAnomalies: Array<Record<string, unknown>> = [];
jest.mock('../../services/billing/billingAuditEmitter', () => ({ emitAnomaly: (a: Record<string, unknown>) => { mockAnomalies.push(a); } }));
jest.mock('../../services/billing/billingMetrics', () => ({ incrCounter: jest.fn() }));
jest.mock('../../db/supabaseClient', () => {
  const b: any = {};
  for (const m of ['select', 'eq', 'in', 'is', 'limit', 'order']) b[m] = () => b;
  b.then = (ok: any, err: any) => Promise.resolve({ data: [], error: null }).then(ok, err);
  return { supabase: { from: () => b, rpc: async () => ({ data: null, error: null }) } };
});
jest.mock('../../repositories/creditExecutionRepository', () => ({
  findCreditTransaction: jest.fn(async () => null),
  loadCreditHoldSplit: jest.fn(async () => null),
  callCreditReservation: jest.fn(async () => ({ error: null, transactionId: 'hold-tx-fake-1' })),
  callCreditPartialConfirm: jest.fn(async () => ({ error: null, data: {} })),
}));
jest.mock('../../services/creditPriorityService', () => ({
  resolveDeduction: jest.fn(async () => ({ wallet: { id: 'wallet-fake' }, available: { total: 1000 }, split: { free: 0, incentive: 0, paid: 5 } })),
  getTotalAvailable: jest.fn(async () => 1000),
}));
jest.mock('../../services/creditDeductionService', () => ({
  getCreditCost: (...a: unknown[]) => mockGetCreditCost(...a),
  getSmartModeDedupSeconds: jest.fn(() => 0),
  wasRecentlyRun: jest.fn(async () => false),
}));
jest.mock('../../services/orgControlService', () => ({ preflightCheck: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../../services/billing/holdPolicySnapshot', () => ({ buildHoldPolicySnapshot: () => ({}), freezeHoldPolicySnapshot: jest.fn(async () => undefined) }));
jest.mock('../../services/billing/creditSafetyGate', () => ({ evaluateCreditSafetyGate: () => 'allow' }));
jest.mock('../../services/billing/billingPolicyResolver', () => ({ resolveBillingPolicy: jest.fn(async () => ({})) }));
jest.mock('../../services/usageTrackingService', () => ({ trackUsage: jest.fn(async () => undefined) }));
jest.mock('../../services/creditAlertService', () => ({ checkCreditAlerts: jest.fn(async () => undefined) }));
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { executeWithCredits } = require('../../services/creditExecutionServiceRuntimeCore');

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const REF = '44444444-4444-4444-8444-444444444444';

const run = (executor: () => Promise<unknown>, key: string) => executeWithCredits({
  userId: USER, orgId: ORG, action: 'lead_attribute_mapping', referenceType: 'manual_adjustment', referenceId: REF,
  idempotencyKey: key, validateMembership: false, executor,
});

beforeEach(() => { mockGetCreditCost.mockReset(); });

describe('PI-LDB unpriced path: no price row -> no AI call', () => {
  it('control: with the 2-credit row present, the AI executor runs exactly once', async () => {
    mockGetCreditCost.mockResolvedValue(2);
    const executor = jest.fn(async () => '{"proposals":[]}');
    const r = await run(executor, 'pi-ldb-unpriced-control');
    expect(executor).toHaveBeenCalledTimes(1);
    expect(r.status).not.toMatch(/insufficient|blocked|not_a_member|no_credit_account/);
  });

  it('with the credit_cost_config row ABSENT (0004 not applied), the call is refused and the executor NEVER runs', async () => {
    mockGetCreditCost.mockRejectedValue(new Error('[creditDeduction] missing credit cost config for lead_attribute_mapping'));
    const executor = jest.fn(async () => '{"proposals":[]}');
    await expect(run(executor, 'pi-ldb-unpriced-absent')).rejects.toThrow(/missing credit cost config/);
    expect(executor).not.toHaveBeenCalled();
    expect(mockGetCreditCost).toHaveBeenCalledWith('lead_attribute_mapping');
  });
});
