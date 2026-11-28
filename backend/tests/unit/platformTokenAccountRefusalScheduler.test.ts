/**
 * communityAiScheduler, api-mode pre-check: an ambiguous or unreadable
 * account resolution is persisted as a failure with the DISTINCT code (never
 * "Platform not connected") and the action is never handed to the executor.
 * Control: getToken -> null keeps the pre-existing "Platform not connected".
 */

jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));

const mockActions: any[] = [];
jest.mock('../../db/writeOwner', () => {
  const chain = (result: unknown) => {
    const q: any = {};
    for (const m of ['select', 'eq', 'gte', 'lte', 'insert', 'update', 'in', 'order', 'limit']) q[m] = () => q;
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return q;
  };
  return {
    ownedDbTable: (table: string) =>
      table === 'community_ai_actions' ? chain({ data: mockActions, error: null }) : chain({ data: [], error: null }),
  };
});

const mockExecuteAction = jest.fn(async (..._a: unknown[]) => ({ ok: true, status: 'executed' }));
const mockPersist = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('../../services/communityAiActionExecutor', () => ({
  executeAction: (...a: unknown[]) => mockExecuteAction(...a),
  persistExecutionResult: (...a: unknown[]) => mockPersist(...a),
}));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
jest.mock('../../services/playbooks/playbookService', () => ({ getPlaybookById: jest.fn(async () => ({ id: 'pb-1' })) }));
jest.mock('../../services/playbooks/playbookValidator', () => ({ validateActionAgainstPlaybook: jest.fn(() => ({ allowed: true })) }));
jest.mock('../../services/communityAiPlatformPolicyService', () => ({
  resolveCommunityAiPlatformPolicy: jest.fn(async () => ({})),
  decideCommunityAiAutomatedTick: jest.fn(() => ({ allowed: true })),
}));
jest.mock('../../services/executionGuardrailService', () => ({ canExecuteAction: jest.fn(async () => ({ allowed: true })) }));

const mockGetToken = jest.fn();
jest.mock('../../services/platformTokenService', () => ({ getToken: (...a: unknown[]) => mockGetToken(...a) }));

import { runCommunityAiScheduler } from '../../services/communityAiScheduler';

const refusal = (code: string) => Object.assign(new Error(code), { name: 'PlatformAccountResolutionError', code });

beforeEach(() => {
  mockActions.length = 0;
  mockActions.push({
    id: 'act-1', tenant_id: 'company-a', organization_id: 'company-a', platform: 'linkedin',
    action_type: 'reply', target_id: 'post-1', playbook_id: 'pb-1', execution_mode: 'api', status: 'approved',
  });
  mockGetToken.mockReset();
  mockExecuteAction.mockClear();
  mockPersist.mockClear();
});

const persistedError = () => (mockPersist.mock.calls[0]?.[0] as any)?.result?.error;

describe('scheduler api pre-check on account resolution', () => {
  it('control: a resolved token reaches the executor', async () => {
    mockGetToken.mockResolvedValue({ access_token: 'tok-a' });
    const r = await runCommunityAiScheduler();
    expect(mockExecuteAction).toHaveBeenCalledTimes(1);
    expect(r.executed).toBe(1);
  });

  it('control: not connected keeps "Platform not connected"', async () => {
    mockGetToken.mockResolvedValue(null);
    const r = await runCommunityAiScheduler();
    expect(r.failed).toBe(1);
    expect(persistedError()).toBe('Platform not connected');
    expect(mockExecuteAction).not.toHaveBeenCalled();
  });

  for (const code of ['PLATFORM_ACCOUNT_AMBIGUOUS', 'PLATFORM_ACCOUNT_LOOKUP_FAILED']) {
    it(`${code}: persisted with the distinct code, executor never called`, async () => {
      mockGetToken.mockRejectedValue(refusal(code));
      const r = await runCommunityAiScheduler();
      expect(mockGetToken).toHaveBeenCalled();
      expect(r.failed).toBe(1);
      expect(persistedError()).toBe(code);
      expect(mockExecuteAction).not.toHaveBeenCalled();
    });
  }
});
