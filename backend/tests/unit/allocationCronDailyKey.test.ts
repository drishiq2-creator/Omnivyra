/**
 * e9 (2026-11-14): the subscription-allocation cron runs DAILY and its runJob key is PER DAY.
 * runJob dead-letter-skips any run whose idempotency key is already in the DLQ (jobRunner.ts:145-150). With the old
 * ~30-day key, ONE failed (DLQ'd) run locked out every remaining day of the period, and paying orgs missed credits.
 *  (1) a DLQ'd day does not skip the NEXT day's run;
 *  (3) vercel.json schedules subscription-monthly-allocation DAILY (pin: the schedule cannot silently revert).
 * (2) "two runs in one period grant once" lives in allocationUnreadableRecoverable.test.ts (it needs the real service).
 * runJob is faked with its real DLQ semantics (a DLQ'd key -> dead_letter_skip; otherwise the job runs and completes).
 */
const dlq = new Set<string>();
const keys: string[] = [];
let sweeps = 0;

jest.mock('../../services/jobRunner', () => ({
  runJob: async (spec: { idempotencyKey: string }, fn: () => Promise<unknown>) => {
    keys.push(spec.idempotencyKey);
    if (dlq.has(spec.idempotencyKey)) return { status: 'dead_letter_skip', reason: 'idempotency-key in DLQ', ctx: {} };
    return { status: 'completed', result: await fn(), ctx: { executionId: `x-${keys.length}` } };
  },
}));
jest.mock('../../services/subscriptionAllocationService', () => ({
  runMonthlyAllocationSweep: async () => { sweeps += 1; return { processed: 1, allocated: 1, skipped: 0, dryRun: false, results: [], unreadable: 0, failed: 0, orgListUnreadable: false, incomplete: false }; },
}));
jest.mock('../../services/supabaseAuthService', () => ({ getSupabaseUserFromRequest: async () => ({ user: null, error: 'none' }) }));
jest.mock('../../services/rbacService', () => ({ isPlatformSuperAdmin: async () => false }));
jest.mock('../../services/superAdminSession', () => ({ getLegacySuperAdminSession: () => null }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

process.env.CRON_SECRET = 'cron-secret-test-only';
/* eslint-disable-next-line @typescript-eslint/no-var-requires */
const route = require('../../../pages/api/cron/subscription-monthly-allocation');

function run() {
  const out: any = { status: 0, body: null };
  const res: any = { status(c: number) { out.status = c; return res; }, json(b: unknown) { out.body = b; return res; }, setHeader() { return res; } };
  const req: any = { method: 'POST', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } };
  return Promise.resolve(route.default(req, res)).then(() => out);
}

beforeEach(() => { dlq.clear(); keys.length = 0; sweeps = 0; jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }); });
afterEach(() => jest.useRealTimers());

describe('(1) a DLQ\'d day does not skip the next day', () => {
  it('day 1 key in the DLQ -> day 1 dead_letter_skips, day 2 RUNS the sweep', async () => {
    dlq.add('cron:subscription-monthly-allocation:2026-12-01');
    jest.setSystemTime(new Date('2026-12-01T06:00:00Z'));
    const d1 = await run();
    jest.setSystemTime(new Date('2026-12-02T06:00:00Z'));
    const d2 = await run();
    expect(keys).toEqual(['cron:subscription-monthly-allocation:2026-12-01', 'cron:subscription-monthly-allocation:2026-12-02']);
    expect(d1).toMatchObject({ status: 202, body: { code: 'DEAD_LETTER_SKIP' } });
    expect(d2).toMatchObject({ status: 200, body: { ok: true } });
    expect(sweeps).toBe(1);                                   // day 2 really swept
  });
  it('CONTROL: the DLQ still works per key - a second run on the SAME DLQ\'d day is skipped', async () => {
    dlq.add('cron:subscription-monthly-allocation:2026-12-01');
    jest.setSystemTime(new Date('2026-12-01T06:00:00Z'));
    await run();
    jest.setSystemTime(new Date('2026-12-01T18:00:00Z'));
    const again = await run();
    expect(again.status).toBe(202);
    expect(sweeps).toBe(0);
  });
  it('the key is the UTC day (a run late on Dec 1 UTC and early Dec 2 UTC are different days)', () => {
    expect(route.allocationRunDay(new Date('2026-12-01T23:59:59Z'))).toBe('2026-12-01');
    expect(route.allocationRunDay(new Date('2026-12-02T00:00:00Z'))).toBe('2026-12-02');
  });
});

describe('(3) vercel.json schedules subscription-monthly-allocation DAILY (pin)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vercel = JSON.parse(require('fs').readFileSync(require('path').resolve(__dirname, '../../../vercel.json'), 'utf8'));
  const entries = (vercel.crons ?? []).filter((c: { path: string }) => c.path === '/api/cron/subscription-monthly-allocation');
  it('exactly one entry, and its schedule fires every day (day-of-month field is "*")', () => {
    expect(entries).toHaveLength(1);
    const fields = String(entries[0].schedule).trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    expect(fields[2]).toBe('*');                              // day of month: every day
    expect(fields[3]).toBe('*');                              // month: every month
    expect(fields[4]).toBe('*');                              // day of week: every day
  });
  it('POSITIVE CONTROL: the old monthly schedule would fail the pin', () => {
    expect('0 6 1 * *'.split(/\s+/)[2]).not.toBe('*');
  });
});
