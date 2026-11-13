/**
 * Reads contract A4 (e9 BLOCKING; e1): the orphan-hold reaper's sibling read.
 * Before: `{ data }` only -> a FAILED read of the confirm/release siblings was "no sibling" -> the reaper RELEASED the
 * hold, returning credits for work that may already have been CONFIRMED (charged). Now the hold is skipped (counted
 * as failed, logged, operational event) and nothing is released.
 * The fake mirrors PostgREST: the builder is awaited and resolves { data, error }; it never throws.
 */
type Res = { data: unknown; error: { message: string } | null };
const OLD = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
const HOLD = (id: string, key: string) => ({
  id, organization_id: 'org-1', free_delta: 0, paid_delta: -10, incentive_delta: 0, idempotency_key: key,
  reference_type: 'content_job', reference_id: `ref-${id}`, performed_by: 'u-1', created_at: OLD, metadata: null,
});
const db: { holds: Res; siblings: Record<string, Res>; siblingReads: string[][] } = { holds: { data: [], error: null }, siblings: {}, siblingReads: [] };
const released: Array<{ idempotencyKey: string; parentId: string }> = [];
const events: string[] = [];

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    if (table !== 'credit_transactions') throw new Error(`unexpected table ${table}`);
    let inKeys: string[] | null = null;
    const b: any = {};
    for (const m of ['select', 'eq', 'lt', 'gt', 'order', 'limit']) b[m] = () => b;
    b.in = (_c: string, keys: string[]) => { inKeys = keys; return b; };
    b.then = (res: (r: Res) => unknown, rej?: (e: unknown) => unknown) => {
      let out: Res;
      if (inKeys) { db.siblingReads.push(inKeys); out = db.siblings[inKeys[0]] ?? { data: [], error: null }; }
      else out = db.holds;
      return Promise.resolve(out).then(res, rej);
    };
    return b;
  },
}));
jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));
jest.mock('../../security/audit/SecurityAuditService', () => ({ logSecurityEvent: async () => undefined }));
jest.mock('../../repositories/creditExecutionRepository', () => ({
  callCreditReservation: async (i: { idempotencyKey: string; parentId: string }) => { released.push({ idempotencyKey: i.idempotencyKey, parentId: i.parentId }); return { data: null, error: null }; },
}));
jest.mock('../../services/monetizationReservationReconciliationService', () => ({ reconcileDurableMonetizationReservations: async () => undefined }));
jest.mock('../../services/monetizationOpsService', () => ({ recordMonetizationOperationalEvent: async (e: { eventName: string }) => { events.push(e.eventName); } }));

/* eslint-disable-next-line @typescript-eslint/no-var-requires */
const { reapOrphanHolds } = require('../../services/creditOrphanHoldReaper');

beforeEach(() => { db.holds = { data: [], error: null }; db.siblings = {}; db.siblingReads = []; released.length = 0; events.length = 0; });

it('the sibling read FAILS -> the hold is NOT released; counted failed, event recorded', async () => {
  db.holds = { data: [HOLD('h1', 'job-1:hold')], error: null };
  db.siblings['job-1:confirm'] = { data: null, error: { message: 'connection reset' } };
  const r = await reapOrphanHolds();
  expect(db.siblingReads).toEqual([['job-1:confirm', 'job-1:release']]);   // the read under test really ran
  expect(released).toEqual([]);
  expect(r).toMatchObject({ scanned: 1, released: 0, failed: 1, skippedHasSibling: 0, releasedHoldIds: [] });
  expect(events).toContain('monetization.orphan_hold_reaper_sibling_read_failed');
});

it('a failure on ONE hold does not stop the batch: the next (readable, no sibling) hold is still released', async () => {
  db.holds = { data: [HOLD('h1', 'job-1:hold'), HOLD('h2', 'job-2:hold')], error: null };
  db.siblings['job-1:confirm'] = { data: null, error: { message: 'timeout' } };
  const r = await reapOrphanHolds();
  expect(released).toEqual([{ idempotencyKey: 'job-2:release', parentId: 'h2' }]);
  expect(r).toMatchObject({ scanned: 2, released: 1, failed: 1, releasedHoldIds: ['h2'] });
});

it('CONTROL: a readable sibling (already confirmed) -> skippedHasSibling, nothing released', async () => {
  db.holds = { data: [HOLD('h1', 'job-1:hold')], error: null };
  db.siblings['job-1:confirm'] = { data: [{ id: 'c1', execution_phase: 'confirm' }], error: null };
  const r = await reapOrphanHolds();
  expect(released).toEqual([]);
  expect(r).toMatchObject({ skippedHasSibling: 1, failed: 0, released: 0 });
});

it('CONTROL: a readable EMPTY sibling set -> the orphan hold is released (the reaper still works)', async () => {
  db.holds = { data: [HOLD('h1', 'job-1:hold')], error: null };
  const r = await reapOrphanHolds();
  expect(released).toEqual([{ idempotencyKey: 'job-1:release', parentId: 'h1' }]);
  expect(r).toMatchObject({ released: 1, failed: 0 });
});
