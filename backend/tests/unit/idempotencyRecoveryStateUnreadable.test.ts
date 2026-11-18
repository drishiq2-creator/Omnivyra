/**
 * Reads contract A8 (e9 BLOCKING; e1 hunk list): idempotencyRecoveryService.
 * Before: `{ data }` only on four safety reads -
 *   key read (billing_operations)   failed -> null key -> checkFinancialDrift 'ok' -> recoverOperation EXPIRED the op
 *                                     without the HOLD check;
 *   settled read (confirm/grant)     failed -> COMPLETED_SETTLEMENT refusal skipped -> a fresh retry key was minted
 *                                     although money had moved;
 *   HOLD read                        failed -> 'ok' -> recovery / retry proceeded past an active HOLD;
 *   HOLD sibling read                failed -> 'drift_detected' (already fail-closed; now reported as unreadable).
 * Now each failed read refuses with STATE_UNREADABLE and NOTHING is written (no status update, no audit, no key).
 * The fake mirrors PostgREST (terminal calls resolve { data, error }, never throw) and identifies each read by its
 * filters, not by call order.
 */
export {}; // a module, not a global script: top-level names must not collide with other test files (CI-496)
type Res = { data: unknown; error: { message: string } | null };
type Step = 'key' | 'settled' | 'hold' | 'sibling' | 'current';
const st: {
  fail: Set<Step>; holdRows: unknown[]; siblingRows: unknown[]; settledRows: unknown[]; reads: Step[]; writes: string[];
  /** The execution_phase IN-list each credit_transactions read actually sent (pinned against the 058 vocabulary). */
  phaseSets: Partial<Record<'settled' | 'sibling', string[]>>;
} = {
  fail: new Set(), holdRows: [], siblingRows: [], settledRows: [], reads: [], writes: [], phaseSets: {},
};
const ERR = { message: 'connection reset' };

jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    rpc: async () => { st.writes.push('rpc'); return { data: null, error: null }; },
    from: (table: string) => {
      let cols = '';
      let isUpdate = false;
      const f: Record<string, unknown> = {};
      const b: any = {};
      const answer = (step: Step, data: unknown): Res => { st.reads.push(step); return st.fail.has(step) ? { data: null, error: ERR } : { data, error: null }; };
      b.select = (c: string) => { cols = c; return b; };
      b.update = () => { isUpdate = true; st.writes.push(`update:${table}`); return b; };
      b.eq = (c: string, v: unknown) => { f[c] = v; return b; };
      b.in = (c: string, v: unknown) => { f[c] = v; return b; };
      b.lt = () => b; b.order = () => b;
      b.limit = async (): Promise<Res> => {
        if (table !== 'credit_transactions') return { data: [], error: null };
        // Faithful to PostgREST: an IN filter on execution_phase only returns rows whose phase is in the list.
        const phaseIn = (rows: unknown[]) => rows.filter((x: any) => (f.execution_phase as string[]).includes(x.execution_phase));
        if (f.parent_transaction_id) { st.phaseSets.sibling = [...(f.execution_phase as string[])]; return answer('sibling', phaseIn(st.siblingRows)); }
        if (f.execution_phase === 'hold') return answer('hold', st.holdRows);
        if (Array.isArray(f.execution_phase) && (f.execution_phase as string[]).includes('grant')) {
          st.phaseSets.settled = [...(f.execution_phase as string[])];
          return answer('settled', phaseIn(st.settledRows));
        }
        return { data: [], error: null };
      };
      b.maybeSingle = async (): Promise<Res> => {
        if (table === 'billing_operations' && cols === 'idempotency_key') return answer('key', { idempotency_key: 'op-1' });
        if (cols === 'status, organization_id') return answer('current', { status: 'processing', organization_id: 'org-1' });
        return { data: null, error: null };
      };
      b.then = (res: (r: Res) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(isUpdate ? res : res, rej);
      return b;
    },
  },
}));
jest.mock('../../services/adminAuditService', () => ({ recordAdminAudit: async () => { st.writes.push('admin_audit'); } }));
jest.mock('../../services/billing/billingAuditEmitter', () => ({
  emitAnomaly: () => undefined,
  emitFinancialAudit: async () => { st.writes.push('financial_audit'); },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const svc = require('../../services/billing/idempotency/idempotencyRecoveryService');
/* eslint-enable @typescript-eslint/no-var-requires */

const RECOVER = { surface: 'billing_operations', id: 'bo-1', action: 'expire', actorUserId: 'admin-1', reason: 'stuck' };
const RETRY = { surface: 'billing_operations', id: 'bo-1', actorUserId: 'admin-1', reason: 'stuck' };
const HOLD = [{ id: 'h1' }];

beforeEach(() => { st.fail = new Set(); st.holdRows = []; st.siblingRows = []; st.settledRows = []; st.reads = []; st.writes = []; st.phaseSets = {}; });

describe('recoverOperation - a failed safety read expires NOTHING', () => {
  it.each<[Step, unknown[]]>([
    ['key', []],
    ['hold', []],
    ['sibling', HOLD],
  ])('the %s read fails -> STATE_UNREADABLE, no status update, no audit', async (step, holdRows) => {
    st.holdRows = holdRows; st.fail.add(step);
    const r = await svc.recoverOperation(RECOVER);
    expect(st.reads).toContain(step);                   // the read under test ran
    expect(r).toMatchObject({ ok: false, error: 'STATE_UNREADABLE', driftCheck: 'unreadable' });
    expect(st.writes).toEqual([]);
  });
  it('CONTROL: readable, no HOLD -> the op is expired (the fixture really would act)', async () => {
    const r = await svc.recoverOperation(RECOVER);
    expect(r.ok).toBe(true);
    expect(st.writes).toContain('update:billing_operations');
  });
  it('CONTROL: readable HOLD with no sibling -> the existing DRIFT_DETECTED refusal', async () => {
    st.holdRows = HOLD;
    await expect(svc.recoverOperation(RECOVER)).resolves.toMatchObject({ ok: false, error: 'DRIFT_DETECTED' });
    expect(st.writes).toEqual([]);
  });
});

describe('safeRetryOperation - a failed safety read mints NO retry key', () => {
  it.each<[Step, unknown[]]>([
    ['key', []],
    ['settled', []],
    ['hold', []],
    ['sibling', HOLD],
  ])('the %s read fails -> STATE_UNREADABLE, nothing written', async (step, holdRows) => {
    st.holdRows = holdRows; st.fail.add(step);
    const r = await svc.safeRetryOperation(RETRY);
    expect(st.reads).toContain(step);
    expect(r).toMatchObject({ ok: false, code: 'STATE_UNREADABLE' });
    expect(r).not.toHaveProperty('newIdempotencyKey');
    expect(st.writes).toEqual([]);
  });
  it('CONTROL: a readable CONFIRM row -> the existing COMPLETED_SETTLEMENT refusal', async () => {
    st.settledRows = [{ id: 'c1', execution_phase: 'confirm' }];
    await expect(svc.safeRetryOperation(RETRY)).resolves.toMatchObject({ ok: false, code: 'COMPLETED_SETTLEMENT' });
  });
  it('CONTROL: everything readable and clean -> a retry key IS minted', async () => {
    const r = await svc.safeRetryOperation(RETRY);
    expect(r).toMatchObject({ ok: true });
    expect(r.newIdempotencyKey).toMatch(/^retry:op-1:/);
  });
});

describe('058: both settlement reads take their phase set from the shared vocabulary (c6)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vocab = require('../../../shared/billing/creditPhaseVocabulary');
  it('the SETTLED read sends exactly CONFIRM_PHASES + grant', async () => {
    await svc.safeRetryOperation(RETRY);
    expect([...(st.phaseSets.settled ?? [])].sort()).toEqual([...vocab.CONFIRM_PHASES, 'grant'].sort());
  });
  it('the SIBLING read sends exactly SETTLE_PHASES', async () => {
    st.holdRows = HOLD;
    await svc.checkFinancialDrift('billing_operations', 'bo-1');
    expect([...(st.phaseSets.sibling ?? [])].sort()).toEqual([...vocab.SETTLE_PHASES].sort());
  });
});

describe("e1/e9 BLOCKING: 'confirm_partial' (every token-priced settle) counts as settled", () => {
  it('safeRetry: a confirm_partial row -> COMPLETED_SETTLEMENT, no retry key minted', async () => {
    st.settledRows = [{ id: 'cp1', execution_phase: 'confirm_partial' }];
    const r = await svc.safeRetryOperation(RETRY);
    expect(r).toMatchObject({ ok: false, code: 'COMPLETED_SETTLEMENT' });
    expect(st.writes).toEqual([]);
  });
  it("checkFinancialDrift: a HOLD whose sibling is confirm_partial -> 'ok' (settled), not drift", async () => {
    st.holdRows = HOLD;
    st.siblingRows = [{ id: 'cp1', execution_phase: 'confirm_partial' }];
    await expect(svc.checkFinancialDrift('billing_operations', 'bo-1')).resolves.toBe('ok');
  });
  it('e9: the SETTLED read (:385) itself refuses a confirm_partial op with the correct reason - not via the drift accident', async () => {
    // HOLD present, its sibling is confirm_partial (so the fixed drift check says 'ok' and does NOT refuse), and the
    // settlement is confirm_partial. Before the fix this was refused only by accident (drift saw "no sibling" ->
    // ACTIVE_RESERVATION); the protection must come from :385 as COMPLETED_SETTLEMENT.
    st.holdRows = HOLD;
    st.siblingRows = [{ id: 'cp1', execution_phase: 'confirm_partial' }];
    st.settledRows = [{ id: 'cp1', execution_phase: 'confirm_partial' }];
    await expect(svc.checkFinancialDrift('billing_operations', 'bo-1')).resolves.toBe('ok');   // drift would let it through
    st.reads = [];
    const r = await svc.safeRetryOperation(RETRY);
    expect(r).toMatchObject({ ok: false, code: 'COMPLETED_SETTLEMENT' });
    expect(r.message).toContain('completed confirm_partial settlement');
    expect(st.reads).not.toContain('hold');                 // refused at :385, before the drift check ran
    expect(st.writes).toEqual([]);
  });
  it("CONTROL: the fake honours the phase filter - an unrelated phase ('hold') is NOT a sibling -> drift", async () => {
    st.holdRows = HOLD;
    st.siblingRows = [{ id: 'x1', execution_phase: 'hold' }];
    await expect(svc.checkFinancialDrift('billing_operations', 'bo-1')).resolves.toBe('drift_detected');
  });
});

describe('checkFinancialDrift / runReconciliationAfterRecovery', () => {
  it("a failed HOLD read answers 'unreadable', never 'ok'", async () => {
    st.fail.add('hold');
    await expect(svc.checkFinancialDrift('billing_operations', 'bo-1')).resolves.toBe('unreadable');
  });
  it("runReconciliationAfterRecovery: unreadable -> verdict 'unverifiable', not 'consistent'", async () => {
    st.fail.add('key');
    await expect(svc.runReconciliationAfterRecovery({ surface: 'billing_operations', id: 'bo-1', organizationId: 'org-1', actorUserId: 'a' }))
      .resolves.toMatchObject({ verdict: 'unverifiable' });
  });
  it("CONTROL: readable, no HOLD -> 'ok' / 'consistent'", async () => {
    await expect(svc.checkFinancialDrift('billing_operations', 'bo-1')).resolves.toBe('ok');
    await expect(svc.runReconciliationAfterRecovery({ surface: 'billing_operations', id: 'bo-1', organizationId: 'org-1', actorUserId: 'a' }))
      .resolves.toMatchObject({ verdict: 'consistent' });
  });
});

describe('admin routes map STATE_UNREADABLE to 503 (structural pin)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs'); const path = require('path');
  const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');
  it.each([
    ['pages/api/admin/credits/idempotency/safe-retry.ts', /result\.code === 'STATE_UNREADABLE'\s*\? 503/],
    ['pages/api/admin/credits/idempotency/recover.ts', /result\.error === 'STATE_UNREADABLE' \? 503/],
  ])('%s', (rel, re) => { expect(src(rel)).toMatch(re); });
});
