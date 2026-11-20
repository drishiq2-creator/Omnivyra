/**
 * Round 3 (2026-11-03) — community AI policy default, on real PostgreSQL.
 * (The scheduled-dispatch block was removed with the community AI scheduler, retired by owner ruling 2026-11-20:
 *  nothing executes a scheduled action any more, and POST status:'scheduled' answers 422 SCHEDULING_NOT_SUPPORTED.
 *  The executor guards kept here - the policy default and the automated-invocation refusal - are unaffected.)
 *
 * Real: community_ai_platform_policy, community_ai_playbooks,
 * community_ai_actions and the executor's row write, through the supabase
 * client translated to SQL. Stubbed: platform dispatch (spies), guardrails,
 * usage enforcement, notifications, webhooks and action-log events.
 * Throwaway DB only; every case runs inside a rollback.
 */

jest.mock('../../db/supabaseClient', () =>
  require('./pgRestTranslator').makeSupabaseModule(() => require('./setup').db, 'r3comm'));
jest.mock('../../db/writeOwner', () => ({
  __esModule: true,
  ownedDbTable: (table: string) => require('../../db/supabaseClient').supabase.from(table),
  ownedDbRpc: (fn: string, args: Record<string, unknown>) => require('../../db/supabaseClient').supabase.rpc(fn, args),
}));
jest.mock('../../services/communityAiActionExecutorContracts', () => {
  const actual = jest.requireActual('../../services/communityAiActionExecutorContracts');
  return {
    ...actual,
    recordExecutionMetric: jest.fn(async () => undefined),
    loadHistoryMetrics: jest.fn(async () => null),
    resolveExecutionMode: jest.fn(async () => 'api'),
    runApiExecution: jest.fn(async () => ({ ok: true, status: 'executed' })),
    runRpaExecution: jest.fn(async () => ({ ok: true, status: 'executed' })),
    prepareBrowserDispatch: jest.fn(() => ({ ok: true, status: 'dispatched' })),
  };
});
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
jest.mock('../../services/executionGuardrailService', () => ({ canExecuteAction: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../../services/usageEnforcementService', () => ({ checkUsageBeforeExecution: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageMeterService', () => ({ incrementUsageMeter: jest.fn(async () => undefined) }));
jest.mock('../../services/playbooks/playbookValidator', () => ({ validateActionAgainstPlaybook: jest.fn(() => ({ allowed: true })) }));
// Not under test, and its import graph reaches '@/config', which
// jest.realschema.config.js does not map.
jest.mock('../../services/platformTokenService', () => ({ getToken: jest.fn(async () => ({ access_token: 'test-token' })) }));
jest.mock('../../services/rpaWorker/rpaWorkerService', () => ({ executeRpaTask: jest.fn(async () => ({ success: true })) }));
jest.mock('../../services/telemetry/telemetryDispatcher', () => ({ trackEvent: jest.fn() }));
jest.mock('../../../lib/security/safeFetch', () => ({
  safeFetch: jest.fn(async (url: string) => { throw new Error(`unexpected egress: ${url}`); }),
}));

import { db, inRollback } from './setup';

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  getCommunityAiPlatformPolicy,
  __resetCommunityAiPlatformPolicyCacheForTests,
} = require('../../services/communityAiPlatformPolicyService');
const { executeAction } = require('../../services/communityAiActionExecutorRuntime');
const contracts = require('../../services/communityAiActionExecutorContracts');
/* eslint-enable @typescript-eslint/no-var-requires */

const DB_URL = process.env.W6_DB_URL ?? '';
if (!/@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(DB_URL)) {
  throw new Error('r3comm_community_policy_scheduler refuses a non-loopback W6_DB_URL');
}

/** Synthetic tenant for a disposable DB. Never a production identifier. */
const ORG = '0eda0896-0000-4000-8000-0000000000c3';
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

const dispatches = () =>
  (contracts.runApiExecution as jest.Mock).mock.calls.length +
  (contracts.runRpaExecution as jest.Mock).mock.calls.length +
  (contracts.prepareBrowserDispatch as jest.Mock).mock.calls.length;

async function seedPlaybook(): Promise<string> {
  await q(`INSERT INTO public.companies (id, name) VALUES ($1, 'R3 community tenant') ON CONFLICT (id) DO NOTHING`, [ORG]);
  const r = await q(
    `INSERT INTO public.community_ai_playbooks (tenant_id, organization_id, name, status, execution_modes)
     VALUES ($1, $1, 'R3 playbook', 'active', '{"api_allowed": true}'::jsonb) RETURNING id`,
    [ORG],
  );
  return r.rows[0].id;
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetCommunityAiPlatformPolicyCacheForTests();
});

describe('community_ai_platform_policy default (real table)', () => {
  it('no row: auto rules off, manual execution defaults unchanged', async () => {
    await inRollback(async () => {
      await q(`DELETE FROM public.community_ai_platform_policy`);
      const policy = await getCommunityAiPlatformPolicy();
      expect(policy).toMatchObject({ execution_enabled: true, auto_rules_enabled: false, require_human_approval: false });
    });
  });

  it('a row inserted with column defaults re-enables auto rules (the operator remedy, D-B3)', async () => {
    await inRollback(async () => {
      await q(`DELETE FROM public.community_ai_platform_policy`);
      await q(`INSERT INTO public.community_ai_platform_policy DEFAULT VALUES`);
      const policy = await getCommunityAiPlatformPolicy();
      expect(policy).toMatchObject({ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false });
    });
  });

  it('an automated invocation with no policy row is refused before any dispatch', async () => {
    await inRollback(async () => {
      await q(`DELETE FROM public.community_ai_platform_policy`);
      const playbookId = await seedPlaybook();
      const result = await executeAction(
        { id: '0eda0896-0000-4000-8000-00000000c301', tenant_id: ORG, organization_id: ORG, platform: 'linkedin',
          action_type: 'reply', target_id: 'comment-r3', suggested_text: 'Thanks!', playbook_id: playbookId,
          execution_mode: 'api', requires_human_approval: false, risk_level: 'low' },
        true,
        { source: 'auto' },
      );
      expect(result).toMatchObject({ ok: false, status: 'skipped', reason: 'PLATFORM_POLICY' });
      expect(dispatches()).toBe(0);
    });
  });
});
