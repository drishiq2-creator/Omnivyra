/**
 * RELEASE MARKER for RECLAIM_MESSAGE ("you weren't charged") in lib/billing/billedResponse.ts.
 *
 * That sentence is true only because failures on our side are refunded in full (owner ruling via
 * b3, 2026-11-18) and the credit runtime releases the entry fee when a run fails. c6 pinned that
 * server-side as `entryFeeOnFailure()` (c6, fix/engagement-replies-billed-v2-20261118 @f51a401a5):
 * the entry fee a failed run keeps, returned by executeWithEntryConsumption's failure path.
 *
 * This test is RED until that change is on the same tree (on a main without it the export is
 * undefined, so it fails as an assertion, not a compile error), so the client wording can't ship
 * ahead of the server behaviour. If the server ever keeps an entry fee on failure, this fails and
 * the wording must change with it.
 */
import * as runtimeEntry from '../../services/creditExecutionServiceRuntimeEntry';
import { RECLAIM_MESSAGE } from '../../../lib/billing/billedResponse';

describe('RECLAIM_MESSAGE depends on the server keeping no entry fee on failure', () => {
  it('entryFeeOnFailure() is exported and returns exactly 0', () => {
    const fn = (runtimeEntry as Record<string, unknown>).entryFeeOnFailure;
    expect(typeof fn).toBe('function');
    expect((fn as () => number)()).toBe(0);
  });
  it('the client wording this guards still says "not charged"', () => {
    expect(RECLAIM_MESSAGE).toMatch(/weren’t charged|were not charged|weren't charged/);
  });
});
