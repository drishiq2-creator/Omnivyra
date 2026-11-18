/**
 * Reads contract A7 (e9 BLOCKING; e1 approved the hunk list): hasTerminalSibling's two reads (by parent, by key).
 * Before: `{ data }` only -> a FAILED read was "no terminal sibling" -> the reconciler classified the hold and
 * CONFIRMED or RELEASED it although it may already be settled. Now each read throws CreditStateUnreadableError; the
 * per-row catch counts it failed and leaves the hold alone.
 * e1: the "catch neither confirms nor releases" property is asserted directly (confirm / release called 0 times),
 * on holds whose report state WOULD otherwise confirm (completed) or release (failed).
 * The fake mirrors PostgREST: maybeSingle() / await resolve { data, error } and never throw.
 */
export {}; // a module, not a global script: top-level names must not collide with other test files (CI-496)
type Res = { data: unknown; error: { message: string } | null };
const db: { parentRead: Res; keyedRead: Res; reportStatus: string; reads: string[] } = {
  parentRead: { data: null, error: null }, keyedRead: { data: null, error: null }, reportStatus: 'failed', reads: [],
};
const HOLD = {
  id: 'h1', organization_id: 'org-1', free_delta: 0, paid_delta: -10, incentive_delta: 0, idempotency_key: 'rep-1:hold',
  reference_type: 'reports.snapshot', reference_id: 'rep-1', performed_by: 'u-1', created_at: '2026-11-13T00:00:00Z', metadata: null,
};

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    const f: Record<string, unknown> = {};
    let inCol: string | null = null;
    let isUpdate = false;
    const b: any = {};
    b.select = () => b; b.lt = () => b; b.order = () => b; b.limit = () => b;
    b.update = () => { isUpdate = true; return b; };
    b.eq = (c: string, v: unknown) => { f[c] = v; return b; };
    b.in = (c: string) => { inCol = c; return b; };
    b.maybeSingle = async (): Promise<Res> => {
      if (table === 'reports') return { data: { id: 'rep-1', status: db.reportStatus, data: { ok: 1 }, metadata: {} }, error: null };
      if (table === 'credit_transactions' && f.parent_transaction_id) { db.reads.push('parent'); return db.parentRead; }
      if (table === 'credit_transactions' && inCol === 'idempotency_key') { db.reads.push('keyed'); return db.keyedRead; }
      return { data: null, error: null };
    };
    b.then = (res: (r: Res) => unknown, rej?: (e: unknown) => unknown) => {
      const out: Res = !isUpdate && table === 'credit_transactions' && f.execution_phase === 'hold'
        ? { data: [HOLD], error: null } : { data: null, error: null };
      return Promise.resolve(out).then(res, rej);
    };
    return b;
  },
}));
jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));
const confirmCreditReservation = jest.fn(async () => ({ status: 'confirmed' }));
const releaseCreditReservation = jest.fn(async () => ({ status: 'released' }));
jest.mock('../../services/creditExecutionService', () => ({
  confirmCreditReservation: (...a: unknown[]) => (confirmCreditReservation as any)(...a),
  releaseCreditReservation: (...a: unknown[]) => (releaseCreditReservation as any)(...a),
}));
const events: string[] = [];
jest.mock('../../services/monetizationOpsService', () => ({ recordMonetizationOperationalEvent: async (e: { eventName: string }) => { events.push(e.eventName); } }));

/* eslint-disable-next-line @typescript-eslint/no-var-requires */
const { reconcileDurableMonetizationReservations } = require('../../services/monetizationReservationReconciliationService');

const ERR = { data: null, error: { message: 'connection reset' } };
beforeEach(() => {
  db.parentRead = { data: null, error: null }; db.keyedRead = { data: null, error: null }; db.reads = [];
  confirmCreditReservation.mockClear(); releaseCreditReservation.mockClear(); events.length = 0;
});

describe.each([
  ['completed', 'confirm'],
  ['failed', 'release'],
])('a hold whose report is %s (would %s)', (reportStatus, wouldDo) => {
  beforeEach(() => { db.reportStatus = reportStatus; });

  it('the BY-PARENT sibling read fails -> confirm and release each called 0 times; failed=1', async () => {
    db.parentRead = ERR;
    const r = await reconcileDurableMonetizationReservations();
    expect(db.reads).toEqual(['parent']);                     // the read under test ran (and stopped the row)
    expect(confirmCreditReservation).toHaveBeenCalledTimes(0);
    expect(releaseCreditReservation).toHaveBeenCalledTimes(0);
    expect(r).toMatchObject({ scanned: 1, failed: 1, confirmed: 0, released: 0, skippedTerminal: 0 });
    expect(events).toContain('monetization.reservation_reconciliation_failed');
  });

  it('parent read empty + the BY-KEY read fails -> confirm and release each called 0 times; failed=1', async () => {
    db.keyedRead = ERR;
    const r = await reconcileDurableMonetizationReservations();
    expect(db.reads).toEqual(['parent', 'keyed']);
    expect(confirmCreditReservation).toHaveBeenCalledTimes(0);
    expect(releaseCreditReservation).toHaveBeenCalledTimes(0);
    expect(r).toMatchObject({ failed: 1, confirmed: 0, released: 0 });
  });

  it(`CONTROL: both reads readable and empty -> the reconciler does ${wouldDo} (the fixture really would act)`, async () => {
    const r = await reconcileDurableMonetizationReservations();
    const fn = wouldDo === 'confirm' ? confirmCreditReservation : releaseCreditReservation;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ failed: 0 });
  });
});

it('CONTROL: a readable terminal sibling -> skippedTerminal, nothing settled', async () => {
  db.reportStatus = 'failed';
  db.parentRead = { data: { id: 't1', parent_transaction_id: 'h1', execution_phase: 'release', idempotency_key: 'rep-1:release' }, error: null };
  const r = await reconcileDurableMonetizationReservations();
  expect(confirmCreditReservation).toHaveBeenCalledTimes(0);
  expect(releaseCreditReservation).toHaveBeenCalledTimes(0);
  expect(r).toMatchObject({ skippedTerminal: 1, failed: 0 });
});
