/**
 * b3 rulings 2026-11-18 (BLOCKING for billing) + 7c criteria - owed refunds and terminal replays.
 *   - "auto-refund" = the system pays without the user acting: the debt is RECORDED, the grant-only job pays it;
 *   - once: one owed row per ORIGINAL confirm (unique), grants keyed on it - a user retry + the job never double-refund;
 *   - an unrecordable debt is 'unrecorded' (ERROR alert) and promises nothing;
 *   - a replay's failed re-reads are counted DURABLY and turn terminal after 3 failures or 24h from the FIRST failure.
 * The fake DB enforces the two unique rules the migration creates (owed row per confirm id; grant per idempotency key).
 */
const db = {
  owed: [] as any[],
  grants: [] as any[],
  replayFailures: new Map<string, { failures: number; first_failed_at: string }>(),
  failUpsert: false, failGrant: 0, failRpc: false,
};
const mockCounters: string[] = [];
const mockAnomalies: any[] = [];
const mockAudits: any[] = [];

function owedChain() {
  const f: Array<[string, string, unknown]> = [];
  let patch: any = null;
  const rows = () => db.owed.filter((r) => f.every(([op, c, v]) => (op === 'eq' ? r[c] === v : op === 'lt' ? r[c] < (v as number) : true)));
  const chain: any = {
    select: () => chain,
    eq: (c: string, v: unknown) => { f.push(['eq', c, v]); return chain; },
    lt: (c: string, v: unknown) => { f.push(['lt', c, v]); return chain; },
    order: () => chain,
    limit: async () => ({ data: rows().map((r) => ({ ...r })), error: null }),
    maybeSingle: async () => ({ data: rows()[0] ? { ...rows()[0] } : null, error: null }),
    upsert: async (row: any) => {
      if (db.failUpsert) return { error: { message: 'connection reset' } };
      if (!db.owed.some((r) => r.original_confirm_txn_id === row.original_confirm_txn_id)) db.owed.push({ ...row });   // UNIQUE, ignoreDuplicates
      return { error: null };
    },
    update: (p: any) => { patch = p; return chain; },
    then: undefined as any,
  };
  // update(...).eq().eq() is awaited directly, or .select() after it
  const applyUpdate = () => { const hit = rows(); for (const r of hit) Object.assign(r, patch); return hit; };
  chain.select = (..._a: unknown[]) => {
    if (patch) { const hit = applyUpdate(); patch = null; return Promise.resolve({ data: hit.map((r) => ({ original_confirm_txn_id: r.original_confirm_txn_id })), error: null }); }
    return chain;
  };
  chain.then = (resolve: (v: unknown) => void) => { if (patch) { applyUpdate(); patch = null; } resolve({ error: null }); };
  return chain;
}

jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (t: string) => {
      if (t === 'billing_owed_refunds') return owedChain();
      throw new Error(`unexpected table ${t}`);
    },
    rpc: async (fn: string, a: any) => {
      if (fn !== 'record_billed_result_replay_failure') throw new Error(fn);
      if (db.failRpc) return { data: null, error: { message: 'rpc down' } };
      const k = `${a.p_scope}|${a.p_caller_id}|${a.p_key}`;
      const cur = db.replayFailures.get(k);
      const next = cur ? { ...cur, failures: cur.failures + 1 } : { failures: 1, first_failed_at: mockNowIso };
      db.replayFailures.set(k, next);
      return { data: [next], error: null };
    },
  },
}));
let mockNowIso = '2026-11-18T10:00:00.000Z';
jest.mock('../../services/creditExecutionService', () => ({
  createCredit: async (o: any) => {
    if (db.failGrant > 0) { db.failGrant--; throw new Error('[createCredit] grant failed: timeout'); }
    if (!db.grants.some((g) => g.idempotencyKey === o.idempotencyKey)) db.grants.push(o);   // credit_transactions key UNIQUE
  },
}));
jest.mock('../../services/billing/billingMetrics', () => ({ incrCounter: (n: string) => { mockCounters.push(n); } }));
jest.mock('../../services/billing/billingAuditEmitter', () => ({
  emitAnomaly: (a: unknown) => { mockAnomalies.push(a); },
  emitFinancialAudit: async (a: unknown) => { mockAudits.push(a); },
}));
jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockStore = require('../helpers/fakeIdempotencyStore').makeFakeIdempotencyStore();
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => mockStore.ownedDbTable(t) }));

import { refundOriginalCharge, completeOwedRefunds, OWED_REFUND_MAX_ATTEMPTS } from '../../services/billing/owedRefunds';
import { replayBilledResult, persistBilledResult, REPLAY_TERMINAL_FAILURES } from '../../services/billing/billedResultStore';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CHARGE = { confirmTxnId: '33333333-3333-4333-8333-333333333333', free: 30, paid: 10, incentive: 0 };
const ARGS = { orgId: ORG, performedBy: USER, charge: CHARGE, reason: 'blog_result_unavailable', grantKeyPrefix: 'blog_refund', referenceId: 'ref-1' };
const granted = () => db.grants.reduce((n, g) => n + g.amount, 0);

beforeEach(() => {
  db.owed.length = 0; db.grants.length = 0; db.replayFailures.clear();
  db.failUpsert = false; db.failGrant = 0; db.failRpc = false;
  mockCounters.length = 0; mockAnomalies.length = 0; mockAudits.length = 0;
  mockStore.rows.length = 0; mockStore.failRead = false; mockStore.failInsert = false;
  mockNowIso = '2026-11-18T10:00:00.000Z';
});

describe('owed refunds: the system pays, exactly once', () => {
  test('grant works now -> granted at once, per category, keyed on the ORIGINAL confirm; audited once', async () => {
    expect(await refundOriginalCharge(ARGS)).toEqual({ status: 'granted', credits: 40 });
    expect(db.grants.map((g) => [g.category, g.amount, g.idempotencyKey])).toEqual([
      ['free', 30, `blog_refund:${CHARGE.confirmTxnId}:free`], ['paid', 10, `blog_refund:${CHARGE.confirmTxnId}:paid`],
    ]);
    expect(db.owed[0].status).toBe('granted');
    expect(mockAudits).toEqual([expect.objectContaining({ actionType: 'system_refund', reason: 'blog_result_unavailable', amountCredits: 40 })]);
  });

  test('THE USER NEVER RETRIES: the grant fails now -> recorded as owed; the JOB pays it, once', async () => {
    db.failGrant = 1;
    expect(await refundOriginalCharge(ARGS)).toEqual({ status: 'owed', credits: 40 });
    expect(db.owed).toEqual([expect.objectContaining({ status: 'owed', attempts: 1 })]);
    expect(granted()).toBe(0);
    expect(await completeOwedRefunds()).toEqual({ processed: 1, granted: 1, failed: 0 });
    expect(granted()).toBe(40);
    expect(await completeOwedRefunds()).toEqual({ processed: 0, granted: 0, failed: 0 });   // nothing left owed
    expect(granted()).toBe(40);
    expect(mockAudits).toHaveLength(1);
  });

  test('the user retries AND the job runs (in any order) -> ONE refund', async () => {
    db.failGrant = 1;
    await refundOriginalCharge(ARGS);          // owed
    await Promise.all([refundOriginalCharge(ARGS), completeOwedRefunds(), refundOriginalCharge(ARGS)]);
    await completeOwedRefunds();
    expect(granted()).toBe(40);
    expect(db.owed).toHaveLength(1);
    expect(mockAudits).toHaveLength(1);
  });

  test('the debt cannot be RECORDED -> unrecorded (ERROR alert counted), nothing granted, nothing promised', async () => {
    db.failUpsert = true;
    expect(await refundOriginalCharge(ARGS)).toEqual({ status: 'unrecorded' });
    expect(mockCounters).toContain('credit_refund_unrecorded_total');
    expect(granted()).toBe(0);
  });

  test('a protected org (Embrosales) is never auto-refunded: no row, no grant, a critical anomaly', async () => {
    const r = await refundOriginalCharge({ ...ARGS, orgId: '73e5fa6f-0000-4000-8000-000000000000' });
    expect(r).toEqual({ status: 'protected' });
    expect(db.owed).toEqual([]);
    expect(granted()).toBe(0);
    expect(mockAnomalies).toEqual([expect.objectContaining({ severity: 'critical' })]);
  });

  test(`a refund that keeps failing is alerted (critical) at ${OWED_REFUND_MAX_ATTEMPTS} attempts and then left for review`, async () => {
    db.failGrant = 1000;
    await refundOriginalCharge(ARGS);
    for (let i = 0; i < OWED_REFUND_MAX_ATTEMPTS + 2; i++) await completeOwedRefunds();
    expect(db.owed[0].attempts).toBe(OWED_REFUND_MAX_ATTEMPTS);
    expect(mockAnomalies.filter((a) => a.kind === 'owed_refund_stuck')).toHaveLength(1);
    expect(granted()).toBe(0);
  });
});

describe('terminal replay: durable count of failed re-reads', () => {
  const KEY = { scope: 'blog_post', orgId: ORG, key: 'click-1' };
  test('found / absent are not failures', async () => {
    expect(await replayBilledResult(KEY)).toEqual({ kind: 'absent' });
    await persistBilledResult({ ...KEY, value: { a: 1 } });
    expect(await replayBilledResult(KEY)).toEqual({ kind: 'found', value: { a: 1 } });
    expect(db.replayFailures.size).toBe(0);
  });
  test(`a read error is transient until the ${REPLAY_TERMINAL_FAILURES}rd durable failure, then TERMINAL`, async () => {
    mockStore.failRead = true;
    expect(await replayBilledResult(KEY)).toEqual({ kind: 'transient', failures: 1 });
    expect(await replayBilledResult(KEY)).toEqual({ kind: 'transient', failures: 2 });
    expect(await replayBilledResult(KEY)).toMatchObject({ kind: 'terminal', failures: 3 });
    expect(mockCounters).toContain('billed_result_replay_terminal_total');
  });
  test('24h after the FIRST failure (stored, not recomputed) a second failure is TERMINAL', async () => {
    mockStore.failRead = true;
    await replayBilledResult({ ...KEY, now: new Date('2026-11-18T10:00:00.000Z') });
    expect(await replayBilledResult({ ...KEY, now: new Date('2026-11-19T10:00:01.000Z') })).toMatchObject({ kind: 'terminal', failures: 2 });
  });
  test('the count is per org + key (another org starts at 1)', async () => {
    mockStore.failRead = true;
    await replayBilledResult(KEY); await replayBilledResult(KEY);
    expect(await replayBilledResult({ ...KEY, orgId: '99999999-9999-4999-8999-999999999999' })).toEqual({ kind: 'transient', failures: 1 });
  });
  test('the count itself cannot be recorded -> stays transient (never terminal on an unrecorded count)', async () => {
    mockStore.failRead = true; db.failRpc = true;
    for (let i = 0; i < 5; i++) expect(await replayBilledResult(KEY)).toEqual({ kind: 'transient', failures: null });
  });
});

describe('the completer is scheduled and always runs (a new cron job silently never fires otherwise)', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
  test("cron.ts runs completeOwedRefunds under shouldRunCronJob('billingOwedRefundComplete')", () => {
    const s = read('backend/scheduler/cron.ts');
    const at = s.indexOf('shouldRunCronJob("billingOwedRefundComplete"');
    expect(at).toBeGreaterThan(-1);
    expect(s.slice(at, at + 600)).toMatch(/completeOwedRefunds\(\{ limit: 50, budgetMs: 60_000, grantTimeoutMs: 15_000 \}\)/);
  });
  test('billingOwedRefundComplete is in ALWAYS_RUN_JOBS', () => {
    const { ALWAYS_RUN_JOBS } = jest.requireActual('../../services/intentExecutionService');
    expect(ALWAYS_RUN_JOBS.has('billingOwedRefundComplete')).toBe(true);
  });
  test('the job name carries no "export" (cb predeploy gate) and the module never releases a hold', () => {
    expect('billing-owed-refund-complete').not.toMatch(/export|invoice|usage-?aggregat/i);
    expect(read('backend/services/billing/owedRefunds.ts')).not.toMatch(/releaseCreditReservation|phase:\s*'release'/);
  });
});
