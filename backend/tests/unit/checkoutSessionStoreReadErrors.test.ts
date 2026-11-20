/**
 * checkoutSessionStore - a FAILED read is never absence (c6 2026-11-20, dropped-error batch 4).
 *
 * Before: findPersistedCheckoutSession / findCheckoutSessionByProviderReference returned null on a read error,
 * recordSettlementEvent returned { duplicate: false } on any non-23505 error, findSettlementSweepCandidates returned [].
 *   - unread replay lookup      -> a SECOND provider checkout dispatched for the same idempotency key
 *   - unread settlement lookup  -> the webhook recorded its anchor as "unmatched" (2xx): the provider stopped
 *                                  redelivering and a paid session was never settled
 *   - failed anchor write       -> the event was actioned without its idempotency anchor (sweeper expired anyway)
 *   - unread sweep candidates   -> a broken sweep reported "0 candidates"
 * Each case below pairs the failure with a CONTROL on the same fixture that takes the normal path, so a test cannot
 * pass because the code never reached the guard.
 */

const mockDb = {
  single: async (): Promise<any> => ({ data: null, error: null }),
  insert: async (): Promise<any> => ({ error: null }),
  limit: async (): Promise<any> => ({ data: [], error: null }),
};
jest.mock('../../db/supabaseClient', () => {
  const chain: any = {};
  chain.select = () => chain; chain.eq = () => chain; chain.in = () => chain;
  chain.maybeSingle = () => mockDb.single();
  chain.insert = () => mockDb.insert();
  chain.limit = () => mockDb.limit();
  return { supabase: { from: () => chain } };
});

import {
  CheckoutSessionStoreReadError,
  findPersistedCheckoutSession,
  findCheckoutSessionByProviderReference,
  recordSettlementEvent,
  findSettlementSweepCandidates,
} from '../../services/billing/payments/checkoutSessionStore';
import { orchestrateCheckoutSession } from '../../services/billing/payments/checkoutSessionOrchestrator';
import { reconcileSettlementWebhook } from '../../services/billing/payments/paymentSettlementOrchestrator';
import { sweepStaleSettlements } from '../../services/billing/payments/settlementExpirySweeper';
import { runSettlementExpirySweepJob } from '../../jobs/settlementExpirySweepJob';

const READ_ERROR = { message: 'connection terminated unexpectedly', code: '08006' };
const EVENT = {
  provider: 'razorpay', providerEventId: 'evt_1', sessionReference: 'order_1', checkoutIdempotencyKey: 'idem-1',
  eventType: 'payment.captured', normalizedStatus: 'succeeded', providerRawStatus: 'captured', payload: {},
};

beforeEach(() => {
  mockDb.single = async () => ({ data: null, error: null });
  mockDb.insert = async () => ({ error: null });
  mockDb.limit = async () => ({ data: [], error: null });
});

describe('store - lookups throw on a failed read, null only for genuinely none', () => {
  test('findPersistedCheckoutSession: read error -> CheckoutSessionStoreReadError', async () => {
    mockDb.single = async () => ({ data: null, error: READ_ERROR });
    await expect(findPersistedCheckoutSession('idem-1')).rejects.toMatchObject({
      name: 'CheckoutSessionStoreReadError', code: 'CHECKOUT_SESSION_STATE_UNREADABLE',
    });
  });
  test('findPersistedCheckoutSession: CONTROL no row -> null; row -> session', async () => {
    await expect(findPersistedCheckoutSession('idem-1')).resolves.toBeNull();
    mockDb.single = async () => ({ data: { provider: 'razorpay', session_status: 'created' }, error: null });
    await expect(findPersistedCheckoutSession('idem-1')).resolves.toMatchObject({ provider: 'razorpay' });
  });
  test('findPersistedCheckoutSession: a thrown client error is also a read error (not null)', async () => {
    mockDb.single = async () => { throw new TypeError('fetch failed'); };
    await expect(findPersistedCheckoutSession('idem-1')).rejects.toBeInstanceOf(CheckoutSessionStoreReadError);
  });

  test('findCheckoutSessionByProviderReference: read error -> throws', async () => {
    mockDb.single = async () => ({ data: null, error: READ_ERROR });
    await expect(findCheckoutSessionByProviderReference('razorpay', 'order_1'))
      .rejects.toBeInstanceOf(CheckoutSessionStoreReadError);
  });
  test('findCheckoutSessionByProviderReference: CONTROL no row -> null', async () => {
    await expect(findCheckoutSessionByProviderReference('razorpay', 'order_1')).resolves.toBeNull();
  });

  test('findSettlementSweepCandidates: read error -> throws (not [])', async () => {
    mockDb.limit = async () => ({ data: null, error: READ_ERROR });
    await expect(findSettlementSweepCandidates()).rejects.toBeInstanceOf(CheckoutSessionStoreReadError);
  });
  test('findSettlementSweepCandidates: CONTROL empty table -> []', async () => {
    await expect(findSettlementSweepCandidates()).resolves.toEqual([]);
  });
});

describe('store - recordSettlementEvent', () => {
  test('a write error other than 23505 / absent table -> throws (not "not duplicate")', async () => {
    mockDb.insert = async () => ({ error: READ_ERROR });
    await expect(recordSettlementEvent(EVENT)).rejects.toBeInstanceOf(CheckoutSessionStoreReadError);
  });
  test('CONTROLS: success -> not duplicate; 23505 -> duplicate; absent table -> documented not-duplicate', async () => {
    await expect(recordSettlementEvent(EVENT)).resolves.toEqual({ duplicate: false });
    mockDb.insert = async () => ({ error: { code: '23505', message: 'duplicate key value' } });
    await expect(recordSettlementEvent(EVENT)).resolves.toEqual({ duplicate: true });
    mockDb.insert = async () => ({ error: { code: '42P01', message: 'relation "billing_settlement_events" does not exist' } });
    await expect(recordSettlementEvent(EVENT)).resolves.toEqual({ duplicate: false });
  });
});

describe('checkout orchestrator - unread replay lookup dispatches nothing', () => {
  const ARGS = {
    organizationId: 'org-1', initiatedByUserId: 'user-1', provider: 'razorpay' as const,
    intentType: 'topup' as const, reference: 'topup_credits_500',
  };
  // Everything after the replay lookup is a spy; the failure must stop BEFORE any of it.
  const spies = () => {
    const resolveOrgBillingContext = jest.fn(async () => ({ country: 'IN', currency: 'INR', region: null, source: 'none' }));
    const resolveAvailableProviders = jest.fn(async () => ({
      available: [], visible: [], supported_methods: [], recommended: null, source: 'db',
    }));
    const isProviderAvailableForCheckout = jest.fn(async () => ({ ok: false, reason: 'provider_disabled' }));
    const dispatchCheckout = jest.fn();
    return { resolveOrgBillingContext, resolveAvailableProviders, isProviderAvailableForCheckout, dispatchCheckout };
  };

  test('replay lookup read error -> rejects; no geography read, no dispatch', async () => {
    mockDb.single = async () => ({ data: null, error: READ_ERROR });
    const s = spies();
    await expect(orchestrateCheckoutSession(ARGS, s as any)).rejects.toBeInstanceOf(CheckoutSessionStoreReadError);
    expect(s.resolveOrgBillingContext).not.toHaveBeenCalled();
    expect(s.dispatchCheckout).not.toHaveBeenCalled();
  });
  test('CONTROL genuinely no persisted session -> proceeds past the lookup', async () => {
    const s = spies();
    const r = await orchestrateCheckoutSession(ARGS, s as any);
    expect(s.resolveOrgBillingContext).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, code: 'provider_disabled' }); // reached governance (fixture says disabled)
  });
});

describe('settlement webhook - unread session lookup records no anchor', () => {
  const payload = {
    id: 'evt_rzp_1', event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_1', order_id: 'order_abc', status: 'captured', amount: 50000 } } },
  };
  test('lookup read error -> rejects (route answers 500, provider redelivers); anchor NOT recorded', async () => {
    mockDb.single = async () => ({ data: null, error: READ_ERROR });
    const recordSettlementEventSpy = jest.fn(async () => ({ duplicate: false }));
    await expect(reconcileSettlementWebhook({ provider: 'razorpay', payload },
      { recordSettlementEvent: recordSettlementEventSpy }))
      .rejects.toBeInstanceOf(CheckoutSessionStoreReadError);
    expect(recordSettlementEventSpy).not.toHaveBeenCalled();
  });
  test('CONTROL genuinely no session -> anchor recorded, unmatched', async () => {
    const recordSettlementEventSpy = jest.fn(async () => ({ duplicate: false }));
    const r = await reconcileSettlementWebhook({ provider: 'razorpay', payload },
      { recordSettlementEvent: recordSettlementEventSpy });
    expect(recordSettlementEventSpy).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, status: 'unmatched' });
  });
});

describe('expiry sweeper - a failed anchor skips only that candidate', () => {
  const NOW = 1_700_000_000_000;
  const stale = (k: string) => ({
    idempotencyKey: k, provider: 'razorpay', providerReference: `order_${k}`, settlementStatus: 'created',
    createdAt: new Date(NOW - 60 * 60_000).toISOString(), lastReconciledAt: null,
  });
  const deps = (failKey: string | null) => {
    const transitions: string[] = [];
    return {
      transitions,
      d: {
        findSettlementSweepCandidates: async () => [stale('a'), stale('b')],
        recordSettlementEvent: async (i: any) => {
          if (i.checkoutIdempotencyKey === failKey) throw new CheckoutSessionStoreReadError('event record', 'boom');
          return { duplicate: false };
        },
        applySettlementTransition: async (i: any) => { transitions.push(i.idempotencyKey); return { applied: true }; },
      },
    };
  };
  test('anchor write fails for "a" -> "a" not expired, "b" still expired', async () => {
    const h = deps('a');
    const r = await sweepStaleSettlements({ nowMs: NOW }, h.d as any);
    expect(h.transitions).toEqual(['b']);
    expect(r).toMatchObject({ candidates: 2, expired: 1, skipped: 1 });
  });
  test('CONTROL no failure -> both expired', async () => {
    const h = deps(null);
    const r = await sweepStaleSettlements({ nowMs: NOW }, h.d as any);
    expect(h.transitions).toEqual(['a', 'b']);
    expect(r).toMatchObject({ expired: 2, skipped: 0 });
  });
});

describe('expiry sweep job - an unread candidate set is reported FAILED, not empty', () => {
  const runtime = {
    acquireLock: async () => ({ acquired: true, ownerToken: 't' }) as any,
    releaseLock: async () => undefined as any,
    recordMetric: async () => undefined,
  };
  test('candidate read error (real store) -> failed:true', async () => {
    mockDb.limit = async () => ({ data: null, error: READ_ERROR });
    const r = await runSettlementExpirySweepJob(undefined, undefined, runtime);
    expect(r).toMatchObject({ ran: true, failed: true });
  });
  test('CONTROL empty candidate set (real store) -> failed:false, 0 scanned', async () => {
    const r = await runSettlementExpirySweepJob(undefined, undefined, runtime);
    expect(r).toMatchObject({ ran: true, failed: false, candidates: 0 });
  });
});
