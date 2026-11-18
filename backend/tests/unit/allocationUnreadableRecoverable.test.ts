/**
 * B1b (e1 BLOCKING finding on B1): monthly subscription allocation runs ONCE a month and is idempotent per
 * (org, plan, period). An unreadable state must therefore be RECOVERABLE, never a terminal skip:
 *   - UNKNOWN state -> 'subscription_state_unreadable' (never 'subscription_inactive'), 0 credits, nothing written, an
 *     ERROR operational event carrying the period's idempotency key; a LATER run in the same period with a readable
 *     ACTIVE state DOES allocate.
 *   - a failed plan read -> 'plan_unreadable' (never 'no_plan').
 *   - the sweep reports incomplete (unreadable / failed / org list unreadable) instead of a clean summary, and never
 *     throws (a failed job is DLQ'd by runJob and every later run in the window would dead_letter_skip).
 * The fake mirrors PostgREST: builders resolve { data, error } and never throw.
 */
export {}; // a module, not a global script: top-level names must not collide with other test files (CI-496)
type Res = { data: unknown; error: { message: string } | null };
const st: { orgList: Res; assignment: Res; plan: Res; sub: Res; planAssign: Res } = {} as any;
const reset = () => {
  st.orgList = { data: [{ organization_id: 'org-1' }], error: null };
  st.assignment = { data: { plan_id: 'p1' }, error: null };
  st.plan = { data: { plan_key: 'growth' }, error: null };
  st.sub = { data: [], error: null };
  st.planAssign = { data: { organization_id: 'org-1' }, error: null };
};
const ERR = { data: null, error: { message: 'connection reset' } };

jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      let cols = '';
      const b: any = {};
      b.select = (c: string) => { cols = c; return b; };
      b.eq = () => b; b.order = () => b;
      b.limit = async () => (table === 'billing_subscriptions' ? st.sub : { data: [], error: null });
      b.maybeSingle = async () => {
        if (table === 'organization_plan_assignments') return cols === 'plan_id' ? st.assignment : st.planAssign;
        if (table === 'pricing_plans') return st.plan;
        return { data: null, error: null };
      };
      b.then = (res: (r: Res) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(table === 'organization_plan_assignments' ? st.orgList : { data: [], error: null }).then(res, rej);
      return b;
    },
  },
}));
const createCredit = jest.fn(async () => ({ status: 'created' }));
jest.mock('../../services/creditExecutionService', () => ({ createCredit: (...a: unknown[]) => (createCredit as any)(...a) }));
const events: Array<{ eventName: string; metadata?: any }> = [];
jest.mock('../../services/monetizationOpsService', () => ({ recordMonetizationOperationalEvent: async (e: any) => { events.push(e); } }));

/* eslint-disable-next-line @typescript-eslint/no-var-requires */
const { allocateMonthlyCreditsForOrg, runMonthlyAllocationSweep } = require('../../services/subscriptionAllocationService');

const NOW = new Date('2026-12-01T06:00:00Z');
beforeEach(() => { reset(); createCredit.mockClear(); events.length = 0; });

describe('e1 (c): UNKNOWN is recoverable within the period', () => {
  it("UNKNOWN -> 'subscription_state_unreadable' (not inactive), 0 credits, nothing written, ERROR event with the period key", async () => {
    st.sub = ERR;
    const r = await allocateMonthlyCreditsForOrg({ orgId: 'org-1', now: NOW });
    expect(r).toMatchObject({ status: 'subscription_state_unreadable', credits: 0, subscriptionState: 'UNKNOWN' });
    expect(createCredit).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({
      eventName: 'monetization.subscription_allocation_unreadable',
      metadata: expect.objectContaining({ status: 'subscription_state_unreadable', idempotency_key: r.idempotencyKey }),
    })]);
  });
  it('a LATER run in the SAME period with a readable ACTIVE state DOES allocate (same idempotency key, nothing blocked it)', async () => {
    st.sub = ERR;
    const first = await allocateMonthlyCreditsForOrg({ orgId: 'org-1', now: NOW });
    reset();
    const later = await allocateMonthlyCreditsForOrg({ orgId: 'org-1', now: new Date('2026-12-02T06:00:00Z') });
    expect(later).toMatchObject({ status: 'allocated', subscriptionState: 'ACTIVE' });
    expect(later.idempotencyKey).toBe(first.idempotencyKey);
    expect(createCredit).toHaveBeenCalledTimes(1);
  });
  it("CONTROL: a readable CANCELED subscription is still 'subscription_inactive' (terminal, correctly) with no event", async () => {
    st.sub = { data: [{ status: 'canceled', current_period_end: '2026-12-20T00:00:00Z', trial_ends_at: null, cancel_at_period_end: false }], error: null };
    await expect(allocateMonthlyCreditsForOrg({ orgId: 'org-1', now: NOW })).resolves.toMatchObject({ status: 'subscription_inactive' });
    expect(events).toEqual([]);
  });
});

describe('e9 (2): DAILY runs in one period grant ONCE (idempotent per org, plan, period)', () => {
  it('runs on the 1st, 2nd and 15th of the same period -> one grant (same key); the next period grants again', async () => {
    // Faithful to the DB: the credit ledger's idempotency key is unique - a repeated key is a no-op, not a second grant.
    const granted = new Set<string>();
    createCredit.mockImplementation(async (cmd: any) => { const dup = granted.has(cmd.idempotencyKey); granted.add(cmd.idempotencyKey); return { status: dup ? 'duplicate' : 'created' }; });
    const days = ['2026-12-01T06:00:00Z', '2026-12-02T06:00:00Z', '2026-12-15T06:00:00Z'];
    const results = [];
    for (const d of days) results.push(await allocateMonthlyCreditsForOrg({ orgId: 'org-1', now: new Date(d) }));
    expect(new Set(results.map((r: any) => r.idempotencyKey)).size).toBe(1);
    expect(granted.size).toBe(1);                             // one grant for the period
    await allocateMonthlyCreditsForOrg({ orgId: 'org-1', now: new Date('2027-01-01T06:00:00Z') });
    expect(granted.size).toBe(2);                             // CONTROL: a new period grants again
    createCredit.mockImplementation(async () => ({ status: 'created' }));
  });
});

describe("a failed plan read is 'plan_unreadable', never 'no_plan'", () => {
  it.each<[string, () => void]>([
    ['plan assignment read', () => { st.assignment = ERR; }],
    ['pricing plan read', () => { st.plan = ERR; }],
  ])('%s fails -> plan_unreadable, 0 credits, ERROR event', async (_n, arrange) => {
    arrange();
    const r = await allocateMonthlyCreditsForOrg({ orgId: 'org-1', now: NOW });
    expect(r).toMatchObject({ status: 'plan_unreadable', credits: 0 });
    expect(createCredit).not.toHaveBeenCalled();
    expect(events.map((e) => e.metadata?.status)).toEqual(['plan_unreadable']);
  });
  it('CONTROL: a READ that finds no assignment -> no_plan (terminal, correct)', async () => {
    st.assignment = { data: null, error: null };
    await expect(allocateMonthlyCreditsForOrg({ orgId: 'org-1', now: NOW })).resolves.toMatchObject({ status: 'no_plan' });
  });
});

describe('the sweep reports incomplete - and never throws (no DLQ)', () => {
  it('org list read fails -> orgListUnreadable, incomplete, nothing attempted', async () => {
    st.orgList = ERR;
    await expect(runMonthlyAllocationSweep({ now: NOW })).resolves.toMatchObject({ orgListUnreadable: true, incomplete: true, processed: 0 });
  });
  it('an UNKNOWN org -> unreadable: 1, incomplete', async () => {
    st.sub = ERR;
    await expect(runMonthlyAllocationSweep({ now: NOW })).resolves.toMatchObject({ unreadable: 1, failed: 0, incomplete: true, allocated: 0 });
  });
  it('a per-org throw is COUNTED (failed: 1), not swallowed silently', async () => {
    createCredit.mockRejectedValueOnce(new Error('rpc down'));
    await expect(runMonthlyAllocationSweep({ now: NOW })).resolves.toMatchObject({ failed: 1, incomplete: true });
  });
  it('CONTROL: all readable -> allocated, complete', async () => {
    await expect(runMonthlyAllocationSweep({ now: NOW })).resolves.toMatchObject({ allocated: 1, unreadable: 0, failed: 0, incomplete: false });
  });
});

describe('routes surface an incomplete sweep as non-2xx (source pins)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs'); const path = require('path');
  const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8') as string;
  it('cron: completed + incomplete -> 503 ALLOCATION_INCOMPLETE (the job is NOT failed, so no DLQ)', () => {
    expect(src('pages/api/cron/subscription-monthly-allocation.ts')).toMatch(/outcome\.result\.incomplete\) \{\s*return res\.status\(503\)\.json\(\{ ok: false, code: 'ALLOCATION_INCOMPLETE'/);
  });
  it('admin allocate: incomplete -> 503, ok:false', () => {
    expect(src('pages/api/admin/billing/allocate.ts')).toMatch(/status\(summary\.incomplete \? 503 : 200\)\.json\(\{ ok: !summary\.incomplete/);
  });
});
