/**
 * B1 (e9 BLOCKING; e1 hunk list + Q1 (a) + addendum): an UNREADABLE subscription state.
 * Before:
 *   resolveSubscriptionState  - a failed read fell back to "plan assignment -> ACTIVE" -> monthly credits granted to a
 *                               canceled org;
 *   resolveTopupEntitlement   - a failed read (error ignored, or thrown) -> { usable: true, NO_SUBSCRIPTION } -> an
 *                               EXPIRED / CANCELED org regained top-up;
 *   isTopupUsable             - a DENY-list, so any new state would have been usable.
 * Now: resolveSubscriptionState -> 'UNKNOWN' (refused by every predicate); resolveTopupEntitlement throws the typed
 * SubscriptionStateUnreadableError; the expiry sweep skips that org (never expires on UNKNOWN) and continues.
 * Fakes mirror PostgREST: builders resolve { data, error } and never throw; the thrown shape is covered separately.
 */
import {
  canReceiveSubscriptionCredits,
  isEntitled,
  isTopupUsable,
  resolveSubscriptionState,
  resolveTopupEntitlement,
  SubscriptionStateUnreadableError,
} from '../../services/subscriptionStateResolver';
import { allocateMonthlyCreditsForOrg } from '../../services/subscriptionAllocationService';
import { runSubscriptionCreditExpirySweep, type ExpiryDeps } from '../../services/subscriptionCreditExpiryService';

const NOW = Date.parse('2026-06-24T00:00:00Z');
const iso = (days: number) => new Date(NOW + days * 86_400_000).toISOString();
const canceledSub = { status: 'canceled', current_period_end: iso(20), trial_ends_at: null, cancel_at_period_end: false };
const activeSub = { status: 'active', current_period_end: iso(20), trial_ends_at: null, cancel_at_period_end: false };
type Mode = 'ok' | 'error' | 'throw';

/** Injected db: per-table result, by mode. */
function db(spec: { sub?: unknown[]; subMode?: Mode; plan?: unknown; planMode?: Mode }) {
  const reads: string[] = [];
  const resolve = (mode: Mode | undefined, data: unknown) => {
    if (mode === 'throw') return Promise.reject(new Error('socket hang up'));
    return Promise.resolve(mode === 'error' ? { data: null, error: { message: 'connection reset' } } : { data, error: null });
  };
  return {
    reads,
    from(table: string) {
      const api: any = { select: () => api, eq: () => api, order: () => api };
      api.limit = () => { reads.push(table); return resolve(table === 'billing_subscriptions' ? spec.subMode : 'ok', spec.sub ?? []); };
      api.maybeSingle = () => { reads.push(table); return resolve(spec.planMode, spec.plan ?? null); };
      return api;
    },
  };
}
const deps = (d: ReturnType<typeof db>) => ({ db: d, now: () => NOW });

describe('every entitlement predicate refuses UNKNOWN (allow-lists)', () => {
  it.each([
    ['canReceiveSubscriptionCredits', canReceiveSubscriptionCredits],
    ['isEntitled', isEntitled],
    ['isTopupUsable', isTopupUsable],
  ] as const)('%s(UNKNOWN) === false; CONTROL: (ACTIVE) === true', (_n, pred) => {
    expect(pred('UNKNOWN')).toBe(false);
    expect(pred('ACTIVE')).toBe(true);
  });
  it('isTopupUsable keeps its documented states: GRACE / PAST_DUE usable, EXPIRED / CANCELED not', () => {
    expect([isTopupUsable('GRACE'), isTopupUsable('PAST_DUE'), isTopupUsable('TRIALING')]).toEqual([true, true, true]);
    expect([isTopupUsable('EXPIRED'), isTopupUsable('CANCELED')]).toEqual([false, false]);
  });
});

describe('resolveSubscriptionState: a failed read is UNKNOWN, never "plan assignment -> ACTIVE"', () => {
  it.each<[string, Parameters<typeof db>[0]]>([
    ['subscription read: error object', { subMode: 'error', plan: { organization_id: 'o' } }],
    ['subscription read: thrown', { subMode: 'throw', plan: { organization_id: 'o' } }],
    ['plan-assignment read: error object', { sub: [], planMode: 'error' }],
    ['plan-assignment read: thrown', { sub: [], planMode: 'throw' }],
  ])('%s -> UNKNOWN', async (_n, spec) => {
    const d = db(spec);
    await expect(resolveSubscriptionState('org1', deps(d))).resolves.toBe('UNKNOWN');
    expect(d.reads.length).toBeGreaterThan(0);
  });
  it('CONTROL: readable, no row + plan assignment -> ACTIVE (legacy kept); no plan -> EXPIRED', async () => {
    await expect(resolveSubscriptionState('org1', deps(db({ sub: [], plan: { organization_id: 'o' } })))).resolves.toBe('ACTIVE');
    await expect(resolveSubscriptionState('org1', deps(db({ sub: [], plan: null })))).resolves.toBe('EXPIRED');
  });
  it('allocation: UNKNOWN -> subscription_state_unreadable (B1b: recoverable, never inactive), 0 credits (no grant); CONTROL: ACTIVE passes the gate', async () => {
    const r = await allocateMonthlyCreditsForOrg({ orgId: 'org1', planKey: 'growth', subscriptionState: 'UNKNOWN', now: new Date(NOW) });
    expect(r).toMatchObject({ status: 'subscription_state_unreadable', credits: 0 });
    const ok = await allocateMonthlyCreditsForOrg({ orgId: 'org1', planKey: 'growth', subscriptionState: 'ACTIVE', now: new Date(NOW), dryRun: true });
    expect(ok.status).toBe('dry_run');
  });
});

describe('resolveTopupEntitlement: a failed read throws the typed error, never "usable: NO_SUBSCRIPTION"', () => {
  it.each<[string, Mode]>([['an error object', 'error'], ['a thrown rejection', 'throw']])('%s -> SubscriptionStateUnreadableError', async (_n, mode) => {
    const d = db({ subMode: mode });
    const p = resolveTopupEntitlement('org1', deps(d));
    await expect(p).rejects.toBeInstanceOf(SubscriptionStateUnreadableError);
    await expect(p).rejects.toMatchObject({ code: 'SUBSCRIPTION_STATE_UNREADABLE', retryable: true });
    expect(d.reads).toEqual(['billing_subscriptions']);
  });
  it('CONTROL: readable, no row -> usable NO_SUBSCRIPTION (legacy); CANCELED row -> not usable', async () => {
    await expect(resolveTopupEntitlement('org1', deps(db({ sub: [] })))).resolves.toEqual({ usable: true, state: 'NO_SUBSCRIPTION' });
    await expect(resolveTopupEntitlement('org1', deps(db({ sub: [canceledSub] })))).resolves.toEqual({ usable: false, state: 'CANCELED' });
  });
});

describe('expiry sweep: an unreadable org is skipped (never expires) and the sweep CONTINUES (e1)', () => {
  function sweepDeps(perOrg: Record<string, { sub?: unknown[]; mode?: Mode }>, captured: { rpc: unknown[] }): ExpiryDeps {
    const d = {
      from(table: string) {
        let org = '';
        let cols = '';
        const api: any = {
          select: (c: string) => { cols = c; return api; },
          eq: (c: string, v: string) => { if (c === 'organization_id') org = v; return api; },
          order: () => api,
        };
        api.limit = () => {
          // the last subscription_allocation row (caps what may expire)
          if (table === 'credit_transactions') return Promise.resolve({ data: [{ free_delta: 1_000_000, credits_delta: 1_000_000 }], error: null });
          if (table !== 'billing_subscriptions') return Promise.resolve({ data: [], error: null });
          const o = perOrg[org];
          if (o.mode === 'throw') return Promise.reject(new Error('socket hang up'));
          return Promise.resolve(o.mode === 'error' ? { data: null, error: { message: 'connection reset' } } : { data: o.sub ?? [], error: null });
        };
        api.maybeSingle = () => {
          if (table === 'organization_credits') return Promise.resolve({ data: { free_balance: 100, paid_balance: 0, incentive_balance: 0 }, error: null });
          return Promise.resolve({ data: null, error: null });
        };
        api.then = (res: (r: unknown) => unknown) => {
          let data: unknown[] = [];
          if (table === 'billing_subscriptions' && cols === 'organization_id') data = Object.keys(perOrg).map((id) => ({ organization_id: id }));
          else if (table === 'credit_transactions') data = [{ free_delta: 1_000_000, credits_delta: 1_000_000 }];
          return Promise.resolve({ data, error: null }).then(res);
        };
        return api;
      },
    };
    return { db: d as any, rpc: async (args: unknown) => { captured.rpc.push(args); return { error: null }; }, now: () => NOW };
  }

  it.each<[string, Mode]>([['an error object', 'error'], ['a thrown rejection', 'throw']])('org A read fails with %s -> A skipped, LATER org B (canceled) still expires', async (_n, mode) => {
    const captured = { rpc: [] as any[] };
    const r = await runSubscriptionCreditExpirySweep(sweepDeps({ orgA: { mode }, orgB: { sub: [canceledSub] } }, captured));
    expect(r.processed).toBe(2);
    expect(captured.rpc).toHaveLength(1);                         // only org B
    expect(captured.rpc[0]).toMatchObject({ p_org_id: 'orgB', p_phase: 'expire' });
    expect(r).toMatchObject({ expired: 1, total_credits: 100 });
  });
  it('CONTROL: an ACTIVE org is not expired; the canceled one is', async () => {
    const captured = { rpc: [] as any[] };
    await runSubscriptionCreditExpirySweep(sweepDeps({ orgA: { sub: [activeSub] }, orgB: { sub: [canceledSub] } }, captured));
    expect(captured.rpc.map((x: any) => x.p_org_id)).toEqual(['orgB']);
  });
});
