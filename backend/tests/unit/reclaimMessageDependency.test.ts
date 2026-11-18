/**
 * RELEASE MARKER for RECLAIM_MESSAGE ("you weren't charged") in lib/billing/billedResponse.ts.
 *
 * That sentence is true only because failures on our side are refunded in full (owner ruling via
 * b3, 2026-11-18) and the credit runtime releases the entry fee when a run fails. c6 pinned that
 * server-side as `entryFeeOnFailure()` (c6, fix/engagement-replies-billed-v2-20261118 @f51a401a5):
 * the entry fee a failed run keeps, returned by executeWithEntryConsumption's failure path.
 *
 * An IMPLICATION (7c): IF the message claims "not charged", THEN the release must exist and be 0.
 *   - wording claims it, server change absent  -> RED (the false claim can't ship);
 *   - wording softened to something true        -> GREEN (an honest interim route);
 *   - server change present, wording restored   -> GREEN.
 * On a main without c6's change the export is undefined, so the failure is an assertion (shown in
 * the Tests: line), not a compile error. Expected-red name for cb: reclaimMessageDependency.
 */
import * as runtimeEntry from '../../services/creditExecutionServiceRuntimeEntry';
import { RECLAIM_MESSAGE } from '../../../lib/billing/billedResponse';

const CLAIMS_NOT_CHARGED = /weren’t charged|were not charged|weren't charged|not charged/i;

describe('RECLAIM_MESSAGE may claim "not charged" only if the server keeps no entry fee on failure', () => {
  it('claim => entryFeeOnFailure() is exported and returns exactly 0', () => {
    const fn = (runtimeEntry as Record<string, unknown>).entryFeeOnFailure;
    if (CLAIMS_NOT_CHARGED.test(RECLAIM_MESSAGE)) {
      expect(typeof fn).toBe('function');
      expect((fn as () => number)()).toBe(0);
    }
  });
  it('control: the claim detector recognises the current wording and a softened one', () => {
    expect(CLAIMS_NOT_CHARGED.test('That didn’t finish on our side and you weren’t charged. Please try again.')).toBe(true);
    expect(CLAIMS_NOT_CHARGED.test('That didn’t finish on our side. Please try again.')).toBe(false);
  });
});
