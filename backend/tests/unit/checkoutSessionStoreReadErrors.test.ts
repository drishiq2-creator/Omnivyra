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

// ── a recorded anchor must never strand a session whose transition did not land (7c question, 2026-11-20) ──────────
// The anchor dedupes EFFECTS; the only effect is the forward-only CAS. Before: write_failed fell through to
// "reconciled" (2xx) and any redelivery / re-sweep short-circuited on the anchor as "duplicate" - stranded for good.
function settlementFake(initial: string) {
  const s = { state: initial, failWrites: 0 };
  const anchors = new Set<string>();
  const writes: string[] = [];
  const deps = {
    findCheckoutSessionByProviderReference: async () => ({
      idempotencyKey: 'idem-1', organizationId: 'org-1', provider: 'razorpay', providerReference: 'order_abc',
      sessionStatus: 'created', settlementStatus: s.state,
    }),
    recordSettlementEvent: async (i: any) => {
      const k = `${i.provider}:${i.providerEventId}`;
      if (anchors.has(k)) return { duplicate: true };
      anchors.add(k); return { duplicate: false };
    },
    applySettlementTransition: async (i: any) => {
      writes.push(i.settlementStatus);
      if (s.failWrites > 0) { s.failWrites--; return { applied: false as const, reason: 'write_failed' as const }; }
      if (i.fromStatus !== undefined && i.fromStatus !== s.state) return { applied: false as const, reason: 'state_changed' as const };
      s.state = i.settlementStatus; return { applied: true as const };
    },
  };
  return { s, anchors, writes, deps };
}
const captured = {
  id: 'evt_rzp_9', event: 'payment.captured',
  payload: { payment: { entity: { id: 'pay_9', order_id: 'order_abc', status: 'captured', amount: 50000 } } },
};

describe('settlement webhook - a failed transition write is never acknowledged, and its redelivery lands', () => {
  test('write_failed -> throws (route 500); the redelivery re-attempts past the anchor and settles', async () => {
    const f = settlementFake('created');
    f.s.failWrites = 1;
    await expect(reconcileSettlementWebhook({ provider: 'razorpay', payload: captured }, f.deps as any))
      .rejects.toBeInstanceOf(CheckoutSessionStoreReadError);
    expect(f.anchors.size).toBe(1);   // the anchor WAS recorded - this is what used to strand it
    const again = await reconcileSettlementWebhook({ provider: 'razorpay', payload: captured }, f.deps as any);
    expect(again).toMatchObject({ ok: true, status: 'reconciled', replayed: true, settlement_state: 'succeeded' });
    expect(f.s.state).toBe('succeeded');
  });
  test('CONTROL: a redelivery after a LANDED transition is still a duplicate no-op (no second write)', async () => {
    const f = settlementFake('created');
    await reconcileSettlementWebhook({ provider: 'razorpay', payload: captured }, f.deps as any);
    const again = await reconcileSettlementWebhook({ provider: 'razorpay', payload: captured }, f.deps as any);
    expect(again).toMatchObject({ ok: true, status: 'duplicate' });
    expect(f.writes).toEqual(['succeeded']);
  });
  test('CONTROL: state_changed (another writer first) stays a 2xx no_transition, not a throw', async () => {
    const f = settlementFake('created');
    f.deps.applySettlementTransition = async () => ({ applied: false as const, reason: 'state_changed' as const }) as any;
    await expect(reconcileSettlementWebhook({ provider: 'razorpay', payload: captured }, f.deps as any))
      .resolves.toMatchObject({ ok: true, status: 'no_transition' });
  });
});

describe('expiry sweeper - an existing expiry anchor does not strand a still-stale session', () => {
  const NOW = 1_700_000_000_000;
  const harness = (state: string) => {
    const f = settlementFake(state);
    const deps = {
      findSettlementSweepCandidates: async () => (['created', 'pending'].includes(f.s.state) ? [{
        idempotencyKey: 'idem-1', provider: 'razorpay', providerReference: 'order_abc', settlementStatus: f.s.state,
        createdAt: new Date(NOW - 120 * 60_000).toISOString(), lastReconciledAt: null,
      }] : []),
      recordSettlementEvent: f.deps.recordSettlementEvent,
      applySettlementTransition: f.deps.applySettlementTransition,
    };
    return { f, deps };
  };
  test('first sweep write_failed -> next sweep re-attempts past the anchor and expires', async () => {
    const h = harness('created');
    h.f.s.failWrites = 1;
    const first = await sweepStaleSettlements({ nowMs: NOW }, h.deps as any);
    expect(first.expired).toBe(0);
    const second = await sweepStaleSettlements({ nowMs: NOW }, h.deps as any);
    expect(second).toMatchObject({ expired: 1, duplicateSuppressed: 1 });
    expect(h.f.s.state).toBe('expired');
    expect(h.f.anchors.size).toBe(1);
  });
  test('first sweep CAS lost to a webhook (created -> pending) -> a later sweep of the stale pending expires it', async () => {
    const h = harness('created');
    const real = h.deps.applySettlementTransition;
    let raced = false;
    h.deps.applySettlementTransition = async (i: any) => { if (!raced) { raced = true; h.f.s.state = 'pending'; } return real(i); };
    expect((await sweepStaleSettlements({ nowMs: NOW }, h.deps as any)).expired).toBe(0);
    expect(h.f.s.state).toBe('pending');
    expect((await sweepStaleSettlements({ nowMs: NOW }, h.deps as any)).expired).toBe(1);
    expect(h.f.s.state).toBe('expired');
  });
  test('CONTROL: once expired the session is no candidate - no further writes', async () => {
    const h = harness('created');
    await sweepStaleSettlements({ nowMs: NOW }, h.deps as any);
    await sweepStaleSettlements({ nowMs: NOW }, h.deps as any);
    expect(h.f.writes).toEqual(['expired']);
  });
});
