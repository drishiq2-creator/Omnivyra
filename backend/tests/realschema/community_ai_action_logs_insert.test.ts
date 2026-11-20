/**
 * community_ai_action_logs accepts EVERY event type the code can log (a9, 2026-11-20; b3 rule).
 *
 * Prod had ZERO rows in this table while 128 community actions were executed / failed. One cause is certain from the
 * schema: its CHECK refuses 'skipped_due_to_platform_policy', which the executor logged. The set under test is NOT a
 * hand-written list: it is COMMUNITY_AI_ACTION_EVENT_TYPES, the constant the logger's parameter is typed from - so adding
 * a type the CHECK does not accept fails here by construction. 20270217000071 widened the CHECK to the whole set (the
 * logger stores every type as itself; no mapping).
 * Runs after every migration on the replayed schema; every case in a rollback.
 */
jest.mock('../../db/supabaseClient', () =>
  require('./pgRestTranslator').makeSupabaseModule(() => require('./setup').db, 'aclog'));
jest.mock('../../db/writeOwner', () => ({
  __esModule: true,
  ownedDbTable: (table: string) => require('../../db/supabaseClient').supabase.from(table),
  ownedDbRpc: (fn: string, args: Record<string, unknown>) => require('../../db/supabaseClient').supabase.rpc(fn, args),
}));
jest.mock('../../observability', () => ({ recordRawCounter: jest.fn() }));

import { db, inRollback, attempt } from './setup';

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  COMMUNITY_AI_ACTION_EVENT_TYPES,
  logCommunityAiActionEvent,
} = require('../../services/communityAiActionLogService');
/* eslint-enable @typescript-eslint/no-var-requires */

const ORG = '0eda0896-0000-4000-8000-0000000000a1';
const ACTION = '0eda0896-0000-4000-8000-0000000000a2';
const INSERT = `INSERT INTO public.community_ai_action_logs (action_id, tenant_id, organization_id, event_type, event_payload)
                VALUES ($1, $2, $2, $3, '{}'::jsonb)`;

describe('community_ai_action_logs accepts every event type the code logs', () => {
  it('PREMISE: the code set is non-empty and includes the type the CHECK used to refuse', () => {
    expect(COMMUNITY_AI_ACTION_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(COMMUNITY_AI_ACTION_EVENT_TYPES).toContain('skipped_due_to_platform_policy');
  });

  it.each([...COMMUNITY_AI_ACTION_EVENT_TYPES])('%s inserts into the real table as itself', async (t: string) => {
    await inRollback(async () => {
      expect(await attempt(INSERT, [ACTION, ORG, t])).toBe('ok');
    });
  });

  it('CONTROL: a type outside the CHECK is refused (23514) - the cases above are not vacuous', async () => {
    await inRollback(async () => {
      expect(await attempt(INSERT, [ACTION, ORG, 'not_an_event_type'])).toBe('23514');
    });
  });

  it('the CHECK is EXACTLY the code set (071 postcondition, restated after every migration): no more, no fewer', async () => {
    const { rows } = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
        WHERE conrelid = 'public.community_ai_action_logs'::regclass AND conname = 'community_ai_action_logs_event_type_check'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].convalidated).toBe(true);
    const inCheck = [...String(rows[0].def).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(inCheck).toEqual([...COMMUNITY_AI_ACTION_EVENT_TYPES].sort());
  });

  it('END TO END: the real logger writes a row for a normal event and for the policy form', async () => {
    await inRollback(async () => {
      await expect(logCommunityAiActionEvent({ action_id: ACTION, tenant_id: ORG, organization_id: ORG, event_type: 'executed' })).resolves.toBe('recorded');
      await expect(logCommunityAiActionEvent({ action_id: ACTION, tenant_id: ORG, organization_id: ORG, event_type: 'skipped_due_to_platform_policy', event_payload: { policy_flag: 'execution_enabled' } })).resolves.toBe('recorded');
      const { rows } = await db.query(
        `SELECT event_type FROM public.community_ai_action_logs WHERE action_id = $1 ORDER BY event_type`, [ACTION]);
      expect(rows).toEqual([{ event_type: 'executed' }, { event_type: 'skipped_due_to_platform_policy' }]);
    });
  });
});
