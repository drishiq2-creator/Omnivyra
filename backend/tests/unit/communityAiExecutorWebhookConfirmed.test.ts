/**
 * The executor's customer webhook (b3 ruling 2026-11-20): a confirmed send and an unconfirmed one are BOTH event
 * 'executed', and metadata.confirmed tells them apart - true for a platform-confirmed send, false for a manual
 * simulation (status 'sent_unverified'). Mocks follow communityAiActionExecutor.manualApi.test.ts.
 */
const sendCommunityAiWebhooks = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: jest.fn(() => ({
      insert: jest.fn(() => Promise.resolve({ error: null })),
      select: jest.fn(() => ({ eq: jest.fn(() => ({ eq: jest.fn(() => ({ eq: jest.fn(() => ({ eq: jest.fn(() => ({ gte: jest.fn(() => Promise.resolve({ data: [] })) })) })) })) })) })),
    })),
  },
}));
jest.mock('../../services/communityAiPlatformPolicyService', () => ({
  getCommunityAiPlatformPolicy: jest.fn(async () => ({ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false })),
}));
jest.mock('../../services/usageEnforcementService', () => ({ checkUsageBeforeExecution: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: (...a: unknown[]) => sendCommunityAiWebhooks(...a) }));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageMeterService', () => ({ incrementUsageMeter: jest.fn(async () => undefined) }));
jest.mock('../../services/platformTokenService', () => ({ getToken: jest.fn(async () => ({ access_token: 'test-token' })) }));
jest.mock('../../services/rpaWorker/rpaWorkerService', () => ({ executeRpaTask: jest.fn(async () => ({ success: true })) }));
jest.mock('../../services/platformConnectors/linkedinConnector', () => ({
  executeAction: jest.fn(async () => ({ success: true, platform_id: 'urn:li:comment:(1,2)', platform_response: { data: { id: 'urn:li:comment:(1,2)' } } })),
}));

import { executeAction } from '../../services/communityAiActionExecutor';

const action = (execution_mode: string) => ({
  id: 'action-1', tenant_id: 'tenant-1', organization_id: 'org-1', platform: 'linkedin', action_type: 'reply' as const,
  target_id: 'urn:li:share:post-1', suggested_text: 'thanks!', playbook_id: null, execution_mode,
});
beforeEach(() => sendCommunityAiWebhooks.mockClear());

it('a confirmed API send -> event executed, confirmed: true', async () => {
  const r = await executeAction(action('api') as any, true, { source: 'manual', notify: false, webhook: true });
  expect(r.status).toBe('executed');
  expect(sendCommunityAiWebhooks).toHaveBeenCalledTimes(1);
  expect(sendCommunityAiWebhooks.mock.calls[0][0]).toMatchObject({ event_type: 'executed', metadata: { confirmed: true } });
});

it('a manual simulation (sent_unverified) -> event executed, confirmed: false - never a confirmed claim', async () => {
  const r = await executeAction(action('manual') as any, true, { source: 'manual', notify: false, webhook: true });
  expect(r.status).toBe('sent_unverified');
  expect(sendCommunityAiWebhooks).toHaveBeenCalledTimes(1);
  expect(sendCommunityAiWebhooks.mock.calls[0][0]).toMatchObject({ event_type: 'executed', metadata: { confirmed: false } });
});
