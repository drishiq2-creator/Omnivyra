/**
 * What a purchase-closure outcome means to the PAYER (c6 2026-11-20, 7c/b3 BLOCKING on checkout/verify).
 * Its own module on purpose: route suites factory-mock purchaseClosureService, and a new export from a factory-mocked
 * module is `undefined` under test - the classifier would vanish exactly where the mapping is exercised.
 *
 *   paid        - fulfilled, or already_completed (status AND fulfillment_status completed - see purchaseClosureService)
 *   not_charged - closed / already_closed: the provider said unpaid and the purchase is closed
 *   unconfirmed - EVERYTHING ELSE, including actions added later. Never "not charged" by default.
 */
import type { ClosureAction } from './purchaseClosureService';

export type PayerOutcome = 'paid' | 'not_charged' | 'unconfirmed';

export function payerOutcomeOf(action: ClosureAction | string): PayerOutcome {
  switch (action) {
    case 'fulfilled':
    case 'already_completed':
      return 'paid';
    case 'closed':
    case 'already_closed':
      return 'not_charged';
    default:
      return 'unconfirmed';
  }
}
