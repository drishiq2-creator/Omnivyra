/**
 * Owner decision 2026-11-22: a plan-limit restriction ('blocked') is not an execution failure. When a scheduled action
 * comes back 'blocked', the scheduler counts it as blocked and does not log it as 'failed'.
 * CONTROL: a real failure is still counted and logged as failed.
 */
type Row = Record<string, any>;
let scheduled: Row[] = [];
let executorResult: Row;
const logged: Row[] = [];

function table(_name: string) {
  const q: any = {
    select: () => q, eq: () => q, gte: () => q, lte: () => q, limit: () => q, order: () => q, in: () => q,
    insert: () => q, update: () => q,
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: scheduled, error: null }).then(ok, bad),
  };
  return q;
}
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: jest.fn((t: string) => table(t)) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: jest.fn((t: string) => table(t)) } }));
jest.mock('../../services/communityAiPlatformPolicyService', () => ({
  getCommunityAiPlatformPolicy: jest.fn(async () => ({ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false })),
}));
jest.mock('../../services/communityAiActionExecutor', () => ({
  executeAction: jest.fn(async () => executorResult),
  persistExecutionResult: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async (e: Row) => { logged.push(e); }) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
jest.mock('../../services/playbooks/playbookService', () => ({ getPlaybookById: jest.fn(async () => ({ id: 'pb-1', status: 'active' })) }));
jest.mock('../../services/playbooks/playbookValidator', () => ({ validateActionAgainstPlaybook: jest.fn(() => ({ allowed: true })) }));
jest.mock('../../services/platformTokenService', () => ({ getToken: jest.fn(async () => ({ access_token: 't' })) }));
jest.mock('../../services/executionGuardrailService', () => ({ canExecuteAction: jest.fn(async () => ({ allowed: true })) }));

import { runCommunityAiScheduler } from '../../services/communityAiScheduler';

const due = (): Row => ({
  id: 'act-1', tenant_id: 'org-1', organization_id: 'org-1', platform: 'linkedin', action_type: 'reply', status: 'approved',
  target_id: 'urn:li:share:1', suggested_text: 'thanks', playbook_id: 'pb-1', execution_mode: 'manual', risk_level: 'low',
  scheduled_at: '2026-11-22T09:00:00Z', approved_at: '2026-11-22T08:00:00Z', requires_human_approval: true,
});

beforeEach(() => { logged.length = 0; scheduled = [due()]; jest.spyOn(console, 'warn').mockImplementation(() => undefined); jest.spyOn(console, 'debug').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());

it("a scheduled action that comes back 'blocked' is counted as blocked and never logged as failed", async () => {
  executorResult = { ok: false, status: 'blocked', error: { code: 'PLAN_LIMIT_EXCEEDED' } };
  const r = await runCommunityAiScheduler(new Date('2026-11-22T10:00:00Z'));
  expect(r).toMatchObject({ processed: 1, executed: 0, failed: 0, blocked: 1 });
  expect(logged.filter((e) => e.event_type === 'failed')).toHaveLength(0);
});

it('CONTROL: a real failure is counted and logged as failed', async () => {
  executorResult = { ok: false, status: 'failed', error: 'CONNECTOR_ERROR' };
  const r = await runCommunityAiScheduler(new Date('2026-11-22T10:00:00Z'));
  expect(r).toMatchObject({ processed: 1, executed: 0, failed: 1, blocked: 0 });
  expect(logged.filter((e) => e.event_type === 'failed')).toHaveLength(1);
});
