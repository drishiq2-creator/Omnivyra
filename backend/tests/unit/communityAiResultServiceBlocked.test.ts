/**
 * Owner decision 2026-11-22: 'blocked' is not an execution failure. The extension-side terminal writer
 * (communityAiExecutionResultService.persistExecutionResult) records no 'execution_failed' metric for it.
 * CONTROL: a failed outcome still records one.
 */
type Row = Record<string, any>;
const metricEvents: Row[] = [];
function table(name: string) {
  let inserted: Row | null = null;
  let patch: Row | null = null;
  const result = () => {
    if (name === 'community_ai_execution_metric_events' && inserted) { metricEvents.push(inserted); return { data: null, error: null }; }
    if (patch) return { data: { id: 'act-1', status: patch.status }, error: null };
    return { data: null, error: null };
  };
  const q: any = {
    select: () => q, eq: () => q, in: () => q, is: () => q,
    update: (p: Row) => { patch = p; return q; }, insert: (r: Row) => { inserted = r; return q; },
    maybeSingle: async () => result(), single: async () => result(),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
  };
  return q;
}
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: jest.fn((t: string) => table(t)) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: jest.fn((t: string) => table(t)) } }));

import { persistExecutionResult } from '../../services/communityAiExecutionResultService';

const write = (status: string) => persistExecutionResult({
  actionId: 'act-1', organizationId: 'org-1', correlationId: '11111111-1111-4111-8111-111111111111',
  result: { ok: false, status, error: status === 'blocked' ? { code: 'PLAN_LIMIT_EXCEEDED' } : 'X' } as any,
  rowHint: { platform: 'linkedin', action_type: 'reply', target_id: 't' },
} as any);

beforeEach(() => { metricEvents.length = 0; jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());

it("blocked -> no 'execution_failed' metric", async () => {
  await write('blocked');
  expect(metricEvents.map((m) => m.event_type)).not.toContain('execution_failed');
});

it("CONTROL: failed -> an 'execution_failed' metric", async () => {
  await write('failed');
  expect(metricEvents.map((m) => m.event_type)).toContain('execution_failed');
});
