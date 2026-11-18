/**
 * B3 (e9 BLOCKING; e1 hunk list): costGovernanceService.evaluateCost.
 * Before: loadBudget / rollingSpend read with { data } only -> a failed budget read was "no active budget" (allowed) and
 * a failed spend read was 0 (under every ceiling). Now each throws BudgetUnverifiableError (error object or thrown),
 * evaluateCost refuses, and the cost-governance route answers 503 + Retry-After.
 * The fake mirrors PostgREST: builders resolve { data, error } and never throw (the thrown shape is separate).
 */
export {}; // a module, not a global script: top-level names must not collide with other test files (CI-496)
type Mode = 'ok' | 'error' | 'throw';
const st: { budget: unknown; budgetMode: Mode; spend: unknown[]; spendMode: Mode; reads: string[] } = {
  budget: null, budgetMode: 'ok', spend: [], spendMode: 'ok', reads: [],
};
const answer = (mode: Mode, data: unknown) => {
  if (mode === 'throw') return Promise.reject(new Error('socket hang up'));
  return Promise.resolve(mode === 'error' ? { data: null, error: { message: 'connection reset' } } : { data, error: null });
};

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    const b: any = {};
    for (const m of ['select', 'eq', 'gt']) b[m] = () => b;
    b.maybeSingle = () => { st.reads.push(table); return answer(st.budgetMode, st.budget); };
    b.in = () => { st.reads.push(table); return answer(st.spendMode, st.spend); };
    return b;
  },
}));

/* eslint-disable-next-line @typescript-eslint/no-var-requires */
const { evaluateCost, BudgetUnverifiableError } = require('../../services/costGovernanceService');

const BUDGET = { enabled: true, monthly_hard_ceiling: 100, monthly_soft_ceiling: 80, alert_threshold_percent: 90 };
const args = { organizationId: 'org-1', category: 'llm', units: 10 };
beforeEach(() => { st.budget = null; st.budgetMode = 'ok'; st.spend = []; st.spendMode = 'ok'; st.reads = []; });

describe.each<[string, Mode]>([['an error object', 'error'], ['a thrown rejection', 'throw']])('a failed read (%s)', (_n, mode) => {
  it('budget read -> BudgetUnverifiableError (never "no_active_budget -> allowed")', async () => {
    st.budgetMode = mode;
    const p = evaluateCost(args);
    await expect(p).rejects.toBeInstanceOf(BudgetUnverifiableError);
    await expect(p).rejects.toMatchObject({ code: 'BUDGET_UNVERIFIABLE', retryable: true });
    expect(st.reads).toContain('cost_budgets');
  });
  it('spend read -> BudgetUnverifiableError (never "0 spent")', async () => {
    st.budget = BUDGET; st.spendMode = mode;
    await expect(evaluateCost(args)).rejects.toBeInstanceOf(BudgetUnverifiableError);
    expect(st.reads).toEqual(['cost_budgets', 'cost_events']);
  });
});

describe('CONTROLS - readable state keeps the existing decisions', () => {
  it('a READ that finds no budget -> allowed (no_active_budget)', async () => {
    await expect(evaluateCost(args)).resolves.toMatchObject({ decision: 'allowed', reasons: ['no_active_budget'] });
  });
  it('spend over the hard ceiling -> denied; under the soft ceiling -> allowed', async () => {
    st.budget = BUDGET; st.spend = [{ units: 95 }];
    await expect(evaluateCost(args)).resolves.toMatchObject({ decision: 'denied' });
    st.spend = [{ units: 10 }];
    await expect(evaluateCost(args)).resolves.toMatchObject({ decision: 'allowed' });
  });
  it('zero units short-circuits before any read', async () => {
    await expect(evaluateCost({ ...args, units: 0 })).resolves.toMatchObject({ decision: 'allowed' });
    expect(st.reads).toEqual([]);
  });
});

it('route pin: cost-governance answers BUDGET_UNVERIFIABLE with 503 + Retry-After', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const src: string = require('fs').readFileSync(require('path').resolve(__dirname, '../../../pages/api/active-leads/cost-governance.ts'), 'utf8');
  expect(src).toMatch(/err instanceof BudgetUnverifiableError\) \{[\s\S]{0,200}?setHeader\('Retry-After'[\s\S]{0,40}?status\(503\)/);
});
