/**
 * B1 addendum 3b (e1 correction): deductCreditsAwaited's post-charge balanceAfter is DISPLAY-only. If that read fails
 * AFTER a successful charge, the result is still success with balanceAfter: null (UNKNOWN) - never a failure (the
 * charge happened) and never 0 (which reads as "you are out of credits").
 */
export {}; // a module, not a global script: top-level names must not collide with other test files (CI-496)
const st: { balance: () => Promise<number | null> } = { balance: async () => 42 };

jest.mock('../../services/creditPriorityService', () => ({
  getTotalAvailable: () => st.balance(),
  resolveDeduction: jest.fn(),
}));
jest.mock('../../services/creditExecutionServiceRuntimeCore', () => ({ executeWithCredits: async () => ({ status: 'executed', result: undefined }) }));
jest.mock('../../services/creditDeductionService', () => ({
  ...jest.requireActual('../../services/creditDeductionService'),
  getCreditCost: async () => 5,
  getSmartModeDedupSeconds: async () => undefined,
  wasRecentlyRun: async () => false,
}));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => { throw new Error('unexpected db read'); }, rpc: jest.fn() } }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { deductCreditsAwaited } = require('../../services/creditExecutionServiceRuntimeEntry');
const { CreditStateUnreadableError } = require('../../repositories/creditExecutionRepository');
/* eslint-enable @typescript-eslint/no-var-requires */

const ORG = '11111111-1111-4111-8111-111111111111';

it('the post-charge balance read FAILS -> success, creditsCharged, balanceAfter: null (not 0, not a failure)', async () => {
  st.balance = async () => { throw new CreditStateUnreadableError('billing_subscriptions read failed'); };
  const r = await deductCreditsAwaited(ORG, 'content_generation', { referenceId: 'ref-1' }, false);
  expect(r).toEqual({ success: true, creditsCharged: 5, balanceAfter: null });
});

it('CONTROL: a readable balance is reported as-is', async () => {
  st.balance = async () => 42;
  const r = await deductCreditsAwaited(ORG, 'content_generation', { referenceId: 'ref-1' }, false);
  expect(r).toEqual({ success: true, creditsCharged: 5, balanceAfter: 42 });
});
