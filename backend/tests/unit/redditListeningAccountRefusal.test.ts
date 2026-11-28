/**
 * redditListeningConnector on an ambiguous / unreadable account resolution:
 * every entry point returns a distinct, non-crashing result (never a thrown
 * error escaping validateEligibility into createOnDemandExecution, and never
 * `oauth_token_unavailable` for a read failure). No network call is made.
 * Controls: null token -> oauth_token_unavailable; a token -> eligible.
 */

const mockGetToken = jest.fn();
jest.mock('../../services/platformTokenService', () => ({ getToken: (...a: unknown[]) => mockGetToken(...a) }));

import { redditListeningConnector } from '../../services/connectors/redditListeningConnector';

const refusal = (code: string) => Object.assign(new Error(code), { name: 'PlatformAccountResolutionError', code });
const input = { organizationId: 'company-a', sourceIdentifier: 'typescript' };

let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  mockGetToken.mockReset();
  fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(async () => {
    throw new Error('network must not be called');
  });
});
afterEach(() => fetchSpy.mockRestore());

describe('redditListeningConnector account refusals', () => {
  it('control: a token makes the source eligible', async () => {
    mockGetToken.mockResolvedValue({ access_token: 'tok' });
    await expect(redditListeningConnector.validateEligibility(input)).resolves.toEqual({ eligible: true, reasons: [] });
  });

  it('control: not connected stays oauth_token_unavailable', async () => {
    mockGetToken.mockResolvedValue(null);
    const r = await redditListeningConnector.validateEligibility(input);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(['oauth_token_unavailable']);
  });

  const cases = [
    ['PLATFORM_ACCOUNT_AMBIGUOUS', 'oauth_account_ambiguous'],
    ['PLATFORM_ACCOUNT_LOOKUP_FAILED', 'oauth_account_lookup_failed'],
  ] as const;

  for (const [code, reason] of cases) {
    it(`${code}: validateEligibility resolves ineligible with ${reason}`, async () => {
      mockGetToken.mockRejectedValue(refusal(code));
      const r = await redditListeningConnector.validateEligibility(input);
      expect(r.eligible).toBe(false);
      expect(r.reasons).toEqual([reason]);
      expect(r.reasons).not.toContain('oauth_token_unavailable');
    });

    it(`${code}: scopes insufficient, rate limit unavailable with the reason, metadata falls back, fetchSignals throws the reason`, async () => {
      mockGetToken.mockRejectedValue(refusal(code));
      await expect(redditListeningConnector.validateScopes(input)).resolves.toMatchObject({ sufficient: false });
      await expect(redditListeningConnector.validateRateLimits(input)).resolves.toMatchObject({ available: false, detail: reason });
      await expect(redditListeningConnector.fetchMetadata(input)).resolves.toMatchObject({ source_identifier: 'typescript' });
      await expect(
        redditListeningConnector.fetchSignals({ ...input, keywords: [], maxPosts: 1, maxComments: 0, maxPages: 1, timeoutMs: 1000 } as any),
      ).rejects.toThrow(reason);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
});
