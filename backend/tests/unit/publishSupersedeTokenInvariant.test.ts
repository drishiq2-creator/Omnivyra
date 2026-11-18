/**
 * Invariant (7c, CI-124 publishing slice x #405): the SUPERSEDE marker is part of the claim TOKEN - never a segment
 * between PUBLISH_CLAIMED: and the token.
 *
 * Why it matters: D5's failure writes (publishNowService) compare-and-set on a RECONSTRUCTED value,
 * `.eq('error_code', publishClaimCode(claim.token))`. That matches a #405 superseding claim only because the stored
 * code is publishClaimCode(supersedeClaimToken(nonce)) = 'PUBLISH_CLAIMED:SUPERSEDE:<nonce>' with
 * token === 'SUPERSEDE:<nonce>'. If a "tidy-up" moved the marker outside the token (token = '<nonce>', stored =
 * 'PUBLISH_CLAIMED:SUPERSEDE:<nonce>'), the reconstruction would rebuild 'PUBLISH_CLAIMED:<nonce>', every D5 failure
 * write on a manual publish-now would move ZERO rows and report success, and the post would stay 'publishing' with
 * no failure recorded. Two correct changes, silently incompatible - so it is pinned, not left to a comment.
 */
export {};
import {
  PUBLISH_CLAIMED_PREFIX,
  PUBLISH_SUPERSEDE_CLAIM_MARK,
  PUBLISH_SUPERSEDE_CLAIM_PREFIX,
  publishClaimCode,
  supersedeClaimToken,
} from '../../queue/publishOutcome';

describe('the supersede marker lives INSIDE the claim token', () => {
  const nonce = '3f2a9c1e-0000-4000-8000-000000000001';

  it('a superseding token carries the marker itself', () => {
    expect(supersedeClaimToken(nonce)).toBe(`${PUBLISH_SUPERSEDE_CLAIM_MARK}${nonce}`);
    expect(supersedeClaimToken(nonce).startsWith(PUBLISH_SUPERSEDE_CLAIM_MARK)).toBe(true);
  });

  it("D5's reconstruction publishClaimCode(token) reproduces the stored marked code exactly", () => {
    const token = supersedeClaimToken(nonce);
    const stored = `${PUBLISH_SUPERSEDE_CLAIM_PREFIX}${nonce}`;          // what a marked claim row holds
    expect(publishClaimCode(token)).toBe(stored);
    expect(stored).toBe(`PUBLISH_CLAIMED:SUPERSEDE:${nonce}`);
  });

  it('an unmarked claim reconstructs the same way (the same CAS serves both)', () => {
    expect(publishClaimCode(nonce)).toBe(`${PUBLISH_CLAIMED_PREFIX}${nonce}`);
    expect(publishClaimCode(supersedeClaimToken(nonce)).startsWith(PUBLISH_CLAIMED_PREFIX)).toBe(true);
  });
});
