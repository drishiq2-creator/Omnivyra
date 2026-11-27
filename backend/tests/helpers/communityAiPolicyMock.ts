/**
 * Round 28 — mock factory for `communityAiPlatformPolicyService`.
 *
 * Every execution caller now decides through the fail-closed evaluator
 * (`resolveCommunityAiPlatformPolicy` + `decideCommunityAi*`), not the legacy
 * getter. Suites that only pin a policy VALUE (a gate other than the kill
 * switch) use this so the evaluator stays REAL and reads the same value as a
 * configured row (or, when the suite says so, a missing / unreadable one).
 *
 * Use inside a jest.mock factory:
 *   jest.mock('../../services/communityAiPlatformPolicyService', () =>
 *     jest.requireActual('../helpers/communityAiPolicyMock').policyServiceMock(() => mockPolicy));
 */
type PolicyState = 'configured' | 'missing_row' | 'unreadable';

export function policyServiceMock(
  getPolicy: () => unknown,
  getState: () => PolicyState = () => 'configured',
): Record<string, unknown> {
  const actual = jest.requireActual('../../services/communityAiPlatformPolicyService');
  const read = async () => ({
    updated_at: null,
    updated_by: null,
    ...((await getPolicy()) as Record<string, unknown>),
  });
  return {
    ...actual,
    getCommunityAiPlatformPolicy: jest.fn(read),
    resolveCommunityAiPlatformPolicy: jest.fn(async () => ({ policy: await read(), state: getState() })),
  };
}
