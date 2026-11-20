/**
 * 7c 2026-11-20 (non-blocking finding on f5a7a23f6): a webhook whose provider status we do not map is answered 400
 * BEFORE any anchor is recorded. It is terminal only while our mapping is complete, so it must never vanish: it is
 * logged at error level and counted durably with the raw status + identifiers (no pricing).
 * Plus the hardening: a MISSING transition answer is never read as success (orchestrator throws, sweeper skips).
 */
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => { throw new Error('INERT: unexpected DB access'); } } }));
const mockLog = { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
jest.mock('../../services/logger', () => ({ logger: mockLog }));
const mockMetrics: unknown[][] = [];
jest.mock('../../services/systemHealthMetricsService', () => ({
  recordMetric: async (...a: unknown[]) => { mockMetrics.push(a); },
}));

import { reconcileSettlementWebhook } from '../../services/billing/payments/paymentSettlementOrchestrator';
import { sweepStaleSettlements } from '../../services/billing/payments/settlementExpirySweeper';

const rzp = (event: string, status: string) => ({
  id: 'evt_rzp_u1', event,
  payload: { payment: { entity: { id: 'pay_1', order_id: 'order_u1', status, amount: 50000 } } },
});
const deps = () => ({
  findCheckoutSessionByProviderReference: jest.fn(async () => null),
  recordSettlementEvent: jest.fn(async () => ({ duplicate: false })),
  applySettlementTransition: jest.fn(async () => ({ applied: true as const })),
});

beforeEach(() => { mockLog.error.mockClear(); mockMetrics.length = 0; });

describe('unmapped provider status - refused, but never silently', () => {
  test('unmapped -> invalid_payload, error-logged and counted with raw status + identifiers', async () => {
    const d = deps();
    const r = await reconcileSettlementWebhook({ provider: 'razorpay', payload: rzp('payment.disputed_v9', 'disputed_v9') }, d as any);
    expect(r).toMatchObject({ ok: false, status: 'invalid_payload' });
    expect(mockLog.error).toHaveBeenCalledWith('settlement_webhook_unmapped_status', expect.objectContaining({
      provider: 'razorpay', providerEventId: 'evt_rzp_u1', sessionReference: 'order_u1',
    }));
    expect(mockMetrics).toHaveLength(1);
    expect(mockMetrics[0].slice(0, 3)).toEqual(['billing', 'settlement_unmapped_status', 1]);
    expect(JSON.stringify(mockMetrics[0][4])).toMatch(/disputed_v9/);
    expect(JSON.stringify(mockMetrics[0][4])).not.toMatch(/50000|amount/); // no pricing
    expect(d.recordSettlementEvent).not.toHaveBeenCalled();
  });
  test('CONTROL: a missing session reference is invalid_payload WITHOUT the unmapped alert', async () => {
    const payload = { id: 'evt_x', event: 'payment.captured', payload: { payment: { entity: { id: 'p', status: 'captured' } } } };
    const r = await reconcileSettlementWebhook({ provider: 'razorpay', payload }, deps() as any);
    expect(r).toMatchObject({ ok: false, status: 'invalid_payload' });
    expect(mockMetrics).toHaveLength(0);
  });
  test('CONTROL: a mapped status is reconciled, nothing counted', async () => {
    const d = deps();
    d.findCheckoutSessionByProviderReference.mockResolvedValue({
      idempotencyKey: 'k', organizationId: 'o', provider: 'razorpay', providerReference: 'order_u1',
      sessionStatus: 'created', settlementStatus: 'created',
    } as any);
    const r = await reconcileSettlementWebhook({ provider: 'razorpay', payload: rzp('payment.captured', 'captured') }, d as any);
    expect(r).toMatchObject({ ok: true, status: 'reconciled' });
    expect(mockMetrics).toHaveLength(0);
  });
});

describe('hardening - a missing transition answer is never success', () => {
  const session = {
    idempotencyKey: 'k', organizationId: 'o', provider: 'razorpay', providerReference: 'order_u1',
    sessionStatus: 'created', settlementStatus: 'created',
  };
  test('orchestrator: undefined answer -> throws (route 500, provider redelivers), never "reconciled"', async () => {
    const d = deps();
    d.findCheckoutSessionByProviderReference.mockResolvedValue(session as any);
    d.applySettlementTransition.mockResolvedValue(undefined as any);
    await expect(reconcileSettlementWebhook({ provider: 'razorpay', payload: rzp('payment.captured', 'captured') }, d as any))
      .rejects.toThrow(/write failed/);
  });
  test('sweeper: undefined answer -> skipped, not expired', async () => {
    const NOW = 1_700_000_000_000;
    const r = await sweepStaleSettlements({ nowMs: NOW }, {
      findSettlementSweepCandidates: async () => [{
        idempotencyKey: 'k', provider: 'razorpay', providerReference: 'o', settlementStatus: 'created',
        createdAt: new Date(NOW - 120 * 60_000).toISOString(), lastReconciledAt: null,
      }],
      recordSettlementEvent: async () => ({ duplicate: false }),
      applySettlementTransition: async () => undefined as any,
    });
    expect(r).toMatchObject({ expired: 0, skipped: 1 });
  });
});
