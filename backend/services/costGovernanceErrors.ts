/**
 * Reads contract (B3, e9 BLOCKING): the budget or the rolling spend could not be READ. Answered as "no active budget"
 * / "0 spent" it allowed spend past the hard ceiling. Typed and retryable; evaluateCost refuses instead (503).
 *
 * Its own module (CI-609, 2026-11-19): a test that mocks costGovernanceService replaces every export, so a route's
 * `err instanceof BudgetUnverifiableError` met `undefined` and threw INSIDE its catch ("Right-hand side of
 * 'instanceof' is not an object"). The service re-exports it, so existing importers are unchanged.
 */
export class BudgetUnverifiableError extends Error {
  readonly code = 'BUDGET_UNVERIFIABLE' as const;
  readonly retryable = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'BudgetUnverifiableError';
  }
}
