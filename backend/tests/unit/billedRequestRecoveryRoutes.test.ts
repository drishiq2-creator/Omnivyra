/**
 * b3 rulings 2026-11-18 (BLOCKING-launch, money) - billed-request recovery on the activity-workspace billing helpers:
 *   runReservedFixedWorkflow (generate_variants) and runBilledAiCompletion (refine_variant + the assist routes).
 *   - KEY: the client's Idempotency-Key is REQUIRED (400, nothing charged) - the Date.now() fallbacks are gone;
 *   - PERSIST INSIDE the charge: not persisted -> released, the work returned free;
 *   - REPLAY: the same key -> the stored result, ONE charge; a different key -> a new run;
 *   - TERMINAL: durable read failures (3) -> the ORIGINAL charge is refunded by the system;
 *   - a released (failed) key -> REQUEST_ENDED.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockStore = require('../helpers/fakeIdempotencyStore').makeFakeIdempotencyStore();
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => mockStore.ownedDbTable(t) }));
const mockReplayFailures = new Map<string, number>();
jest.mock('../../db/supabaseClient', () => ({
  supabase: { rpc: async (_f: string, a: any) => {
    const k = `${a.p_scope}|${a.p_caller_id}|${a.p_key}`;
    const n = (mockReplayFailures.get(k) ?? 0) + 1; mockReplayFailures.set(k, n);
    return { data: [{ failures: n, first_failed_at: new Date().toISOString() }], error: null };
  } },
}));
const mockRefundCalls: any[] = [];
jest.mock('../../services/billing/owedRefunds', () => ({
  readOriginalCharge: async (k: string) => ({ confirmTxnId: `txn:${k}`, free: 3, paid: 0, incentive: 0 }),
  refundOriginalCharge: async (a: any) => { mockRefundCalls.push(a); return { status: 'granted', credits: 3 }; },
}));
jest.mock('../../services/billing/billingAuditEmitter', () => ({ emitAnomaly: jest.fn(), emitFinancialAudit: jest.fn() }));
jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

// ledger-faithful executeWithCredits: one settle per key; an executor throw releases (the key is then 'released')
const ledger = new Map<string, 'confirmed' | 'released'>();
let charges = 0;
jest.mock('../../services/creditExecutionService', () => ({
  makeIdempotencyKey: (...p: string[]) => p.join(':'),
  executeWithCredits: async (i: any) => {
    const st = ledger.get(i.idempotencyKey);
    if (st === 'confirmed') return { status: 'already_confirmed' };
    if (st === 'released') return { status: 'already_released' };
    try { const r = await i.executor(); ledger.set(i.idempotencyKey, 'confirmed'); charges++; return { status: 'executed', result: r }; }
    catch (e) { ledger.set(i.idempotencyKey, 'released'); throw e; }
  },
  executeWithEntryConsumption: jest.fn(),
}));
jest.mock('../../services/creditDeductionService', () => ({ getCreditCost: async () => 2 }));
// runBilledAiCompletion's orchestrator + gateway
jest.mock('../../services/billing/enterpriseBillingOrchestrator', () => ({
  runBilledOperation: async (o: any) => {
    const key = o.idempotency.requestHeaderIdempotency ?? 'none';
    const st = ledger.get(`ai:${key}`);
    if (st === 'confirmed') return { result: { status: 'already_confirmed' }, operationId: 'op', correlationId: 'c', idempotencyKey: key };
    if (st === 'released') return { result: { status: 'already_released' }, operationId: 'op', correlationId: 'c', idempotencyKey: key };
    try { const r = await o.executor(); ledger.set(`ai:${key}`, 'confirmed'); charges++; return { result: { status: 'executed', result: r.result, settlement: {} }, operationId: 'op', correlationId: 'c', idempotencyKey: key }; }
    catch (e) { ledger.set(`ai:${key}`, 'released'); throw e; }
  },
}));
let mockAiCalls = 0;
jest.mock('../../services/aiGateway', () => ({ runCompletionWithOperation: async () => { mockAiCalls++; return { output: 'raw text', metadata: { token_usage: {}, provider: 'openai', model: 'm' } }; } }));
jest.mock('../../services/billing/aiGatewayBillingGuard', () => ({ checkAiBillingGuard: async () => ({ allowed: true }), runWithCreditHandle: (_h: unknown, fn: () => unknown) => fn() }));

import { runReservedFixedWorkflow } from '../../services/activityWorkspace/contentRouteModel';
import { runBilledAiCompletion } from '../../services/billing/runBilledAiCompletion';
import { billedRouteHttpError } from '../../services/billing/billedRouteHttpError';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
beforeEach(() => { ledger.clear(); charges = 0; mockAiCalls = 0; mockStore.rows.length = 0; mockStore.failRead = false; mockStore.failInsert = false; mockReplayFailures.clear(); mockRefundCalls.length = 0; });

describe('generate_variants: runReservedFixedWorkflow with recovery', () => {
  const run = (header: unknown, executor = jest.fn(async () => ({ v: 1 }))) => runReservedFixedWorkflow({
    userId: USER, companyId: ORG, action: 'content_basic' as any, referenceType: 'activity_platform_variants', referenceId: 'workspace',
    note: 'Generated platform variants', executor,
    recovery: { surface: 'activity-workspace.generate_variants', scope: 'activity-workspace:generate_variants', idempotencyKeyHeader: header },
  });
  test.each([[undefined], [''], ['short']])('no usable key %p -> 400 IDEMPOTENCY_KEY_REQUIRED, nothing run or charged', async (h) => {
    const ex = jest.fn(async () => ({ v: 1 }));
    const e = await run(h, ex).catch((x) => x);
    expect(billedRouteHttpError(e)).toEqual({ status: 400, body: expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }) });
    expect(ex).not.toHaveBeenCalled();
    expect(charges).toBe(0);
  });
  test('the SAME key twice -> ONE run, ONE charge; the 2nd replays the stored result', async () => {
    const ex = jest.fn(async () => ({ v: 1 }));
    expect(await run('click-key-001', ex)).toEqual({ v: 1 });
    expect(await run('click-key-001', ex)).toEqual({ v: 1 });
    expect(ex).toHaveBeenCalledTimes(1);
    expect(charges).toBe(1);
  });
  test('a DIFFERENT key (a deliberate new click) -> a new run and a new charge', async () => {
    await run('click-key-001'); await run('click-key-002');
    expect(charges).toBe(2);
  });
  test('the result cannot be persisted -> NOT charged (released), the work still returned', async () => {
    mockStore.failInsert = true;
    expect(await run('click-key-001')).toEqual({ v: 1 });
    expect(charges).toBe(0);
  });
  test('the run FAILED (released) -> the same key is 409 REQUEST_ENDED (end the key)', async () => {
    await run('click-key-001', jest.fn(async () => { throw new Error('provider 500'); })).catch(() => undefined);
    const e = await run('click-key-001').catch((x) => x);
    expect(billedRouteHttpError(e)?.body.code).toBe('REQUEST_ENDED');
  });
  test('durable read failures: 503 twice, then TERMINAL -> the original charge is refunded by the system', async () => {
    await run('click-key-001');
    mockStore.failRead = true;
    for (let i = 0; i < 2; i++) expect(billedRouteHttpError(await run('click-key-001').catch((x) => x))?.body.code).toBe('REPLAY_UNAVAILABLE');
    const e = await run('click-key-001').catch((x) => x);
    expect(billedRouteHttpError(e)).toEqual({ status: 409, body: expect.objectContaining({ code: 'RESULT_UNAVAILABLE', error: "We couldn't recover this result, so your 3 credits have been returned." }) });
    expect(mockRefundCalls).toHaveLength(1);
    expect(mockRefundCalls[0].charge.confirmTxnId).toMatch(/:confirm$/);
  });
});

describe('refine_variant: runBilledAiCompletion with recovery', () => {
  const durable: unknown[] = [];
  const call = (header: unknown, durableWrite = async (v: unknown) => { durable.push(v); }) => runBilledAiCompletion({
    module: 'http:t', userId: USER, orgId: ORG, action: 'content_rewrite' as any, referenceType: 'variant_refine', referenceId: 'refine-linkedin',
    llmPricing: { provider: 'openai', model: 'm', maxInputTokens: 1, maxOutputTokens: 1, actionKey: 'content_rewrite' },
    idempotency: { kind: 'http', actorUserId: USER, action: 'content_rewrite', referenceId: 'refine-linkedin', requestBody: {}, requestHeaderIdempotency: header as string | undefined },
    completion: { model: 'm', temperature: 0, messages: [], operation: 'regenerateContent' },
    recovery: { surface: 'activity-workspace.refine_variant', scope: 'activity-workspace:refine_variant', postProcess: (t: string) => t.toUpperCase(), durableWrite },
  });
  beforeEach(() => { durable.length = 0; });
  test('no header -> 400 IDEMPOTENCY_KEY_REQUIRED, no AI call, no charge', async () => {
    const e = await call(undefined).catch((x) => x);
    expect(billedRouteHttpError(e)?.status).toBe(400);
    expect(mockAiCalls).toBe(0);
    expect(charges).toBe(0);
  });
  test('the post-processed value is durably written INSIDE the charge and returned; the same key replays it (no 2nd AI call)', async () => {
    const a = await call('click-key-001');
    expect(a.value).toBe('RAW TEXT');
    expect(durable).toEqual(['RAW TEXT']);
    const b = await call('click-key-001');
    expect(b).toMatchObject({ value: 'RAW TEXT', replayed: true });
    expect(mockAiCalls).toBe(1);
    expect(charges).toBe(1);
  });
  test('the route\'s durable write FAILS -> released, NOT charged, the refined text still returned (unbilled)', async () => {
    const r = await call('click-key-001', async () => { throw new Error('content write failed'); });
    expect(r).toMatchObject({ value: 'RAW TEXT', unbilled: true });
    expect(charges).toBe(0);
  });
});
