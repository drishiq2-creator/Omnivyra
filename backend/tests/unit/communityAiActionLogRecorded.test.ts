/**
 * logCommunityAiActionEvent (a9, 2026-11-20; b3 finding: community_ai_action_logs had ZERO rows in prod while 128
 * actions were executed / failed). A refused insert used to be a console.warn and nothing else. Now:
 *   - a refused insert (error object) AND a thrown rejection are logged at ERROR level and COUNTED, and the call
 *     resolves 'failed' - it never throws into the action it describes;
 *   - 'skipped_due_to_platform_policy' (refused by the table's CHECK) is written as 'skipped' with logged_as kept;
 *   - CONTROL: a normal event is inserted unchanged and resolves 'recorded'.
 */
type R = { error: { message: string } | null } | 'throw';
let next: R = { error: null };
const inserts: Array<Record<string, unknown>> = [];
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: () => ({
    insert: (row: Record<string, unknown>) => {
      inserts.push(row);
      return next === 'throw' ? Promise.reject(new Error('socket hang up')) : Promise.resolve(next);
    },
  }),
}));
const counters: Array<[string, number, Record<string, string>]> = [];
jest.mock('../../observability', () => ({
  recordRawCounter: (n: string, v: number, l: Record<string, string>) => { counters.push([n, v, l]); },
}));

import { logCommunityAiActionEvent, COMMUNITY_AI_ACTION_EVENT_TYPES, storedEventType } from '../../services/communityAiActionLogService';

const base = { action_id: 'a-1', tenant_id: 't-1', organization_id: 't-1' };
let err: jest.SpyInstance;
beforeEach(() => { next = { error: null }; inserts.length = 0; counters.length = 0; err = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => err.mockRestore());

it('CONTROL: a normal event is inserted as given and resolves "recorded"; nothing is counted', async () => {
  await expect(logCommunityAiActionEvent({ ...base, event_type: 'executed', event_payload: { ok: true } })).resolves.toBe('recorded');
  expect(inserts).toEqual([expect.objectContaining({ event_type: 'executed', event_payload: { ok: true } })]);
  expect(counters).toEqual([]);
});

it.each([
  ['an error object', { error: { message: 'new row violates check constraint' } } as R],
  ['a thrown rejection', 'throw' as R],
])('a failed insert (%s) resolves "failed", is logged at ERROR and counted - never thrown', async (_n, outcome) => {
  next = outcome;
  await expect(logCommunityAiActionEvent({ ...base, event_type: 'failed' })).resolves.toBe('failed');
  expect(err).toHaveBeenCalledWith('COMMUNITY_AI_ACTION_LOG_FAILED', expect.stringContaining('"event_type":"failed"'));
  expect(counters).toEqual([['community_ai_action_log_failed', 1, { event_type: 'failed' }]]);
});

it("'skipped_due_to_platform_policy' is WRITTEN as 'skipped' (the CHECK refuses the long form) and keeps logged_as", async () => {
  await logCommunityAiActionEvent({ ...base, event_type: 'skipped_due_to_platform_policy', event_payload: { policy_flag: 'execution_enabled' } });
  expect(inserts[0]).toMatchObject({ event_type: 'skipped', event_payload: { policy_flag: 'execution_enabled', logged_as: 'skipped_due_to_platform_policy' } });
});

it('storedEventType maps only the policy form; every other type is written as itself', () => {
  for (const t of COMMUNITY_AI_ACTION_EVENT_TYPES) {
    expect(storedEventType(t)).toBe(t === 'skipped_due_to_platform_policy' ? 'skipped' : t);
  }
});
