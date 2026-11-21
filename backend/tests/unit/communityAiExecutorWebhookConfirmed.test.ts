/**
 * The executor's customer webhook (b3 ruling 2026-11-20): a confirmed send and an unconfirmed one are BOTH event
 * 'executed', and metadata.confirmed tells them apart - true for a platform-confirmed send, false for a manual
 * simulation (status 'sent_unverified').
 *
 * Stage-0 merge (a9, 2026-11-21): main's #79 test was written for main's executor. The stranded line's executor needs
 * a persisted human approval of record (D-01 / Prompt 3), a held claim for an external mode (SEC3-F3), the tenant
 * execution decision (getCommunityExecutionPolicy) and the L-3 recipient recheck. The harness below is the line's
 * own (communityAiActionExecutor.manualApi.test.ts); the two assertions are #79's, unchanged.
 */
jest.mock('../../services/communityRecipientRecheck', () => ({
  ...jest.requireActual('../../services/communityRecipientRecheck'),
  recheckCommunityRecipient: async () => ({ ok: true, basis: 'recipient_allowed', recipient: null }),
}));
import { createFakeDb, type FakeDb } from './helpers/communityExecutionFakeDb';
import { withApprovalEvidence } from '../helpers/communityApprovalEvidenceFixture';

let mockDb: FakeDb = createFakeDb();
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (t: string) => mockDb.from(t),
    rpc: (name: string, args: any) => require('./helpers/communityClaimRpcEmulation').communityRpcEmulation(() => mockDb).rpc(name, args),
  },
}));
jest.mock('../../services/communityAiPlatformPolicyService', () => ({
  ...jest.requireActual('../../services/communityAiPlatformPolicyService'),
  getCommunityExecutionPolicy: ((legacy: any) => jest.fn((..._a: any[]) =>
    require('../helpers/communityPolicyDecisionShim').asExecutionDecision(legacy())))(jest.fn(async () => ({
    execution_enabled: true, auto_rules_enabled: true, require_human_approval: false,
  }))),
}));
const sendCommunityAiWebhooks = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: (...a: unknown[]) => sendCommunityAiWebhooks(...a) }));
jest.mock('../../services/usageEnforcementService', () => ({ checkUsageBeforeExecution: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageMeterService', () => ({ incrementUsageMeter: jest.fn(async () => undefined) }));
jest.mock('../../services/platformTokenService', () => ({ getToken: jest.fn(async () => ({ access_token: 'test-token' })) }));
jest.mock('../../services/rpaWorker/rpaWorkerService', () => ({ executeRpaTask: jest.fn(async () => ({ success: true })) }));
jest.mock('../../services/platformConnectors/linkedinConnector', () => ({
  executeAction: jest.fn(async () => ({ success: true, platform_id: 'urn:li:comment:(1,2)', platform_response: { data: { id: 'urn:li:comment:(1,2)' } } })),
}));

import { executeAction as realExecuteAction } from '../../services/communityAiActionExecutor';

/** A person approved exactly this action: store it with its evidence, then execute it (the line's harness). */
const executeAction: typeof realExecuteAction = (action, ...rest) => {
  const stored = withApprovalEvidence({ ...(action as Record<string, any>), status: 'approved' } as never) as any;
  mockDb = createFakeDb({ community_ai_actions: [stored] });
  return realExecuteAction(stored, rest[0], { persist: true, ...(rest[1] || {}) });
};

const action = (execution_mode: string) => ({
  id: 'action-1', tenant_id: 'tenant-1', organization_id: 'tenant-1', platform: 'linkedin', action_type: 'reply' as const,
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
