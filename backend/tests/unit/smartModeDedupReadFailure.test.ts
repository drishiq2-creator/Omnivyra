/**
 * Reads contract A9 (e9 BLOCKING; e1 hunk list): wasRecentlyRun - the smart-mode dedup read.
 * Before: `{ data }` only -> a FAILED read was "not recently run" -> deductCreditsAwaited skipped the dedup and
 * charged again inside the window. Now wasRecentlyRun throws CreditStateUnreadableError; deductCreditsAwaited's
 * existing catch answers { success:false, reason:'error' } and executeWithCredits is never reached (no hold, no charge).
 * The fake mirrors PostgREST (maybeSingle resolves { data, error }, never throws); the dedup read is identified by its
 * filters (credit_transactions + execution_phase).
 */
type Res = { data: unknown; error: { message: string } | null };
const st: { dedup: Res; dedupReads: number } = { dedup: { data: null, error: null }, dedupReads: 0 };

jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const f: Record<string, unknown> = {};
      const b: any = {};
      for (const m of ['select', 'gt', 'lt', 'order', 'limit', 'in']) b[m] = () => b;
      b.eq = (c: string, v: unknown) => { f[c] = v; return b; };
      b.maybeSingle = async (): Promise<Res> => {
        if (table === 'credit_transactions' && f.execution_phase) { st.dedupReads += 1; return st.dedup; }
        if (table === 'credit_cost_config') return { data: { smart_dedup_seconds: 300, credits: 5, credit_cost: 5, cost: 5 }, error: null };
        return { data: null, error: null };
      };
      b.then = (res: (r: Res) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res, rej);
      return b;
    },
  },
}));
const executeWithCredits = jest.fn(async () => ({ status: 'executed', result: undefined }));
jest.mock('../../services/creditExecutionServiceRuntimeCore', () => ({ executeWithCredits: (...a: unknown[]) => (executeWithCredits as any)(...a) }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { wasRecentlyRun } = require('../../services/creditDeductionService');
const { deductCreditsAwaited } = require('../../services/creditExecutionServiceRuntimeEntry');
const { CreditStateUnreadableError } = require('../../repositories/creditExecutionRepository');
/* eslint-enable @typescript-eslint/no-var-requires */

const ORG = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { st.dedup = { data: null, error: null }; st.dedupReads = 0; executeWithCredits.mockClear(); });

it('wasRecentlyRun: a FAILED read throws the typed retryable error (not false)', async () => {
  st.dedup = { data: null, error: { message: 'connection reset' } };
  const p = wasRecentlyRun(ORG, 'content_generation', 300);
  await expect(p).rejects.toBeInstanceOf(CreditStateUnreadableError);
  await expect(p).rejects.toMatchObject({ code: 'CREDIT_STATE_UNREADABLE', retryable: true });
});

it('deductCreditsAwaited: the dedup read FAILS -> success:false and executeWithCredits is called 0 times', async () => {
  st.dedup = { data: null, error: { message: 'connection reset' } };
  const r = await deductCreditsAwaited(ORG, 'content_generation', { referenceId: 'ref-1' });
  expect(st.dedupReads).toBe(1);                        // the read under test ran
  expect(r).toMatchObject({ success: false, reason: 'error' });
  expect(String(r.detail)).toContain('smart-mode dedup read failed');
  expect(executeWithCredits).toHaveBeenCalledTimes(0);
});

it('CONTROL: a readable recent confirm -> the existing smart_mode_dedup skip, no charge', async () => {
  st.dedup = { data: { id: 'c1' }, error: null };
  const r = await deductCreditsAwaited(ORG, 'content_generation', { referenceId: 'ref-1' });
  expect(r).toEqual({ success: true, skipped: true, reason: 'smart_mode_dedup' });
  expect(executeWithCredits).toHaveBeenCalledTimes(0);
});

it('CONTROL: readable and empty -> the charge proceeds (the fixture really would charge)', async () => {
  await deductCreditsAwaited(ORG, 'content_generation', { referenceId: 'ref-1' });
  expect(st.dedupReads).toBe(1);
  expect(executeWithCredits).toHaveBeenCalledTimes(1);
});
