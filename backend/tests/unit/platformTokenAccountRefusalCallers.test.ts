/**
 * Callers of platformTokenService.getToken on an ambiguous or unreadable
 * account resolution: the action must NOT be sent (no API call, no
 * API->browser fallback dispatch), and the failure must carry the distinct
 * code — never PLATFORM_NOT_CONNECTED.
 *
 * Control: a genuinely not-connected org (getToken -> null) still takes the
 * pre-existing API->browser fallback, so the refusal tests cannot pass merely
 * because the fallback was removed.
 */

jest.mock('../../services/communityAiContactGovernanceGate', () => ({
  checkCommunityActionContactGovernance: jest.fn(async () => ({ allowed: true, reason: 'not_suppressed', checked: 1 })),
  contactGateAuditPayload: jest.fn(() => ({})),
}));
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: jest.fn(() => ({
      insert: jest.fn(() => Promise.resolve({ error: null })),
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                gte: jest.fn(() => Promise.resolve({ data: [] })),
              })),
            })),
          })),
        })),
      })),
    })),
  },
}));
jest.mock('../../services/communityAiPlatformPolicyService', () =>
  jest.requireActual('../helpers/communityAiPolicyMock').policyServiceMock(() => ({ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false })));
jest.mock('../../services/usageEnforcementService', () => ({ checkUsageBeforeExecution: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageMeterService', () => ({ incrementUsageMeter: jest.fn(async () => undefined) }));
jest.mock('../../services/rpaWorker/rpaWorkerService', () => ({ executeRpaTask: jest.fn(async () => ({ success: true })) }));

const mockGetToken = jest.fn();
jest.mock('../../services/platformTokenService', () => ({
  getToken: (...a: unknown[]) => mockGetToken(...a),
}));

const mockLinkedInExecuteAction = jest.fn(async (..._a: unknown[]) => ({ success: true, platform_id: 'urn:li:comment:1' }));
jest.mock('../../services/platformConnectors/linkedinConnector', () => ({
  executeAction: (...args: unknown[]) => mockLinkedInExecuteAction(...args),
}));

import { executeAction } from '../../services/communityAiActionExecutor';

const refusal = (code: string) => Object.assign(new Error(code), { name: 'PlatformAccountResolutionError', code });

const baseAction = (extra: Record<string, unknown> = {}) => ({
  id: 'action-1',
  tenant_id: 'company-a',
  organization_id: 'company-a',
  platform: 'linkedin',
  action_type: 'reply' as const,
  target_id: 'urn:li:share:post-1',
  suggested_text: 'thanks!',
  playbook_id: null,
  ...extra,
});

const OPTS = { source: 'manual' as const, notify: false, webhook: false };

describe('executor refuses to send on ambiguous / unreadable account resolution', () => {
  beforeEach(() => {
    mockGetToken.mockReset();
    mockLinkedInExecuteAction.mockClear();
  });

  it('control: a resolved token sends through the API', async () => {
    mockGetToken.mockResolvedValue({ access_token: 'tok-a' });
    const result = await executeAction(baseAction({ execution_mode: 'api' }), true, OPTS);
    expect(result.ok).toBe(true);
    expect(mockLinkedInExecuteAction).toHaveBeenCalledTimes(1);
  });

  it('control: not connected (null) still falls back API -> browser', async () => {
    mockGetToken.mockResolvedValue(null);
    const result = await executeAction(baseAction({ execution_mode: 'api' }), true, OPTS);
    expect(result.status).toBe('dispatched');
    expect((result.response as any)?.fallback_from).toBe('api');
    expect((result.response as any)?.api_error).toBe('PLATFORM_NOT_CONNECTED');
  });

  for (const code of ['PLATFORM_ACCOUNT_AMBIGUOUS', 'PLATFORM_ACCOUNT_LOOKUP_FAILED']) {
    it(`api mode, ${code}: failed with the distinct code, no API call, no browser fallback`, async () => {
      mockGetToken.mockRejectedValue(refusal(code));
      const result = await executeAction(baseAction({ execution_mode: 'api' }), true, OPTS);
      expect(mockGetToken).toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error).toBe(code);
      expect(result.status).not.toBe('dispatched');
      expect(mockLinkedInExecuteAction).not.toHaveBeenCalled();
    });

    it(`undeclared mode, ${code}: the mode probe does not route to browser`, async () => {
      mockGetToken.mockRejectedValue(refusal(code));
      const result = await executeAction(baseAction({ execution_mode: undefined }), true, OPTS);
      expect(mockGetToken).toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error).toBe(code);
      expect(mockLinkedInExecuteAction).not.toHaveBeenCalled();
    });
  }
});
