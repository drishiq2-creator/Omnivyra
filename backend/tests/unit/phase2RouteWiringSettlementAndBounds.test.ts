/**
 * c6 2026-11-18 (engagement-replies v2; b3 ruling + 7c non-blocking):
 *  1. settlementPending: when the work SUCCEEDED but the settle outcome is unknown, wirePhase2Route returns the result
 *     AND reports the pending marker to the route (onSettlementPending), so the route answers 200 + settlementPending.
 *  2. every static ROUTE_UNIT_CALLS entry is an integer in 1..MAX_ROUTE_UNIT_CALLS (a per-request value is capped;
 *     a static one bypasses that cap, so it is bounded here).
 *  3. BOTH token bounds (input AND output) scale by the action's unit calls, with the action's per-call bounds.
 */
import * as fs from 'fs';
import * as path from 'path';

const engine = {
  executeWithEntryConsumption: jest.fn(),
  makeIdempotencyKey: jest.fn((u: string, a: string, r: string) => `${u}|${a}|${r}`),
};
jest.mock('../../services/creditExecutionService', () => engine);
jest.mock('../../services/requestContext', () => ({ getRequestContext: () => ({ idempotencyKey: 'click-1' }) }));
jest.mock('../../services/billing/phase2EnforcementGate', () => {
  const actual = jest.requireActual('../../services/billing/phase2EnforcementGate');
  return { ...actual, runWithPhase2Enforcement: async (args: any) => { const r = await args.enforce(); if (!r.ok) throw new Error(r.reason); return r.result; } };
});
jest.mock('../../services/creditDeductionService', () => ({ hasEnoughCredits: jest.fn(async () => ({ sufficient: true })) }));
const mockCounters: string[] = [];
jest.mock('../../services/billing/billingMetrics', () => ({ incrCounter: (n: string) => { mockCounters.push(n); } }));
jest.mock('../../services/billing/creditEconomyShadow', () => ({ emitCreditEconomyShadowEvaluation: jest.fn(async () => undefined) }));
jest.mock('../../services/billing/admissionControl', () => ({ evaluateActivityAdmission: jest.fn(async () => undefined) }));
jest.mock('../../services/billing/billingAuditEmitter', () => ({ emitAnomaly: jest.fn() }));
const mockWarn = jest.fn();
jest.mock('../../services/logger', () => ({ logger: { warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), error: jest.fn() } }));

import {
  wirePhase2Route, routeLlmPricingFor, ROUTE_UNIT_CALLS, ROUTE_CALL_TOKENS, MAX_ROUTE_UNIT_CALLS,
} from '../../services/billing/phase2RouteWiring';

const ARGS = { surface: 'test.surface' as any, organizationId: 'org-1', userId: 'user-1', action: 'reply_generation' as any, referenceType: 'r', referenceId: 'ref-1' };
const PENDING = { code: 'CREDIT_SETTLE_AMBIGUOUS', holdId: 'hold-9', state: 'unreadable', detail: 'x' };

beforeEach(() => { jest.clearAllMocks(); mockCounters.length = 0; });

describe('settlementPending reaches the route', () => {
  test('executed + pending: the result is returned AND onSettlementPending gets the marker; counted + logged', async () => {
    engine.executeWithEntryConsumption.mockImplementation(async (o: any) => ({ status: 'executed', result: await o.executor(), settlementPending: PENDING }));
    const seen: unknown[] = [];
    const out = await wirePhase2Route({ ...ARGS, run: async () => 'WORK', onSettlementPending: (p) => seen.push(p) });
    expect(out).toBe('WORK');
    expect(seen).toEqual([PENDING]);
    expect(mockCounters).toContain('phase2_route_settlement_pending_total');
    expect(mockWarn).toHaveBeenCalledWith('phase2_route_settlement_pending', expect.objectContaining({ holdId: 'hold-9' }));
  });
  test('control: executed WITHOUT pending never calls onSettlementPending', async () => {
    engine.executeWithEntryConsumption.mockImplementation(async (o: any) => ({ status: 'executed', result: await o.executor() }));
    const cb = jest.fn();
    expect(await wirePhase2Route({ ...ARGS, run: async () => 'WORK', onSettlementPending: cb })).toBe('WORK');
    expect(cb).not.toHaveBeenCalled();
    expect(mockCounters).not.toContain('phase2_route_settlement_pending_total');
  });
  test('a throwing callback never fails finished work', async () => {
    engine.executeWithEntryConsumption.mockImplementation(async (o: any) => ({ status: 'executed', result: await o.executor(), settlementPending: PENDING }));
    expect(await wirePhase2Route({ ...ARGS, run: async () => 'WORK', onSettlementPending: () => { throw new Error('x'); } })).toBe('WORK');
  });
  test.each([
    ['pages/api/engagement/refine-suggestion.ts', 'refined'],
    ['pages/api/engagement/suggestions.ts', 'suggestions'],
    ['pages/api/engagement/thread/bulk-ai-reply.ts', 'settlementPending } : {}'],
  ])('%s passes onSettlementPending and puts settlementPending in its 200 body', (f, bodyMarker) => {
    const s = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
    expect(s).toMatch(/onSettlementPending: \(\) => \{ settlementPending = \{ code: 'CREDIT_SETTLE_AMBIGUOUS' \}; \}/);
    expect(s).toContain(bodyMarker);
    expect(s).toMatch(/settlementPending \?/);
  });
});

describe('static unit-call bound', () => {
  test('every static ROUTE_UNIT_CALLS entry is an integer in 1..MAX_ROUTE_UNIT_CALLS', () => {
    const entries = Object.entries(ROUTE_UNIT_CALLS);
    expect(entries.length).toBeGreaterThan(0);   // a check over nothing passes vacuously
    for (const [k, v] of entries) {
      expect([k, Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_ROUTE_UNIT_CALLS]).toEqual([k, true]);
    }
  });
});

describe('both token bounds scale per action', () => {
  const actions = [...new Set([...Object.keys(ROUTE_UNIT_CALLS), ...Object.keys(ROUTE_CALL_TOKENS), 'content_basic'])];
  test.each(actions)('%s: maxInputTokens AND maxOutputTokens = per-call bound x unit calls', (a) => {
    const calls = ROUTE_UNIT_CALLS[a] ?? 1;
    const per = ROUTE_CALL_TOKENS[a] ?? { input: 8000, output: 2000 };
    const p = routeLlmPricingFor(a as any);
    expect([p.maxInputTokens, p.maxOutputTokens]).toEqual([per.input * calls, per.output * calls]);
  });
  test('a per-request unitCalls scales BOTH bounds and is capped at MAX_ROUTE_UNIT_CALLS', () => {
    const p = routeLlmPricingFor('reply_generation' as any, 500);
    expect([p.maxInputTokens, p.maxOutputTokens]).toEqual([3000 * MAX_ROUTE_UNIT_CALLS, 700 * MAX_ROUTE_UNIT_CALLS]);
  });
});
