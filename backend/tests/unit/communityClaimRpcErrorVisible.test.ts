/**
 * b3 (stage 3 deploy window): between the code deploy and the community CONTRACT migrations, the claim
 * functions do not exist yet. Every claim then fails CLOSED (CLAIM_RPC_ERROR: nothing is claimed, nothing
 * executed) - and it must be VISIBLE, under a reason distinct from a policy or guardrail refusal. Before this
 * change the scheduler skipped such actions silently.
 * Driven through the REAL claimCommunityActionForExecution with the RPC layer faked.
 */
export {};

const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let rpcAnswer: { data: unknown; error: unknown } = { data: null, error: null };

jest.mock('../../db/writeOwner', () => ({
  ownedDbRpc: async (name: string, args: Record<string, unknown>) => { rpcCalls.push({ name, args }); return rpcAnswer; },
  ownedDbTable: () => { throw new Error('no table access expected in a claim that fails or is refused'); },
}));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => { throw new Error('unexpected'); }, rpc: async () => ({ data: null, error: null }) } }));

import { claimCommunityActionForExecution } from '../../services/communityAiActionExecutorRuntime';

const INPUT = { actionId: 'act-1', tenantId: 'org-1', organizationId: 'org-1', claimPoint: 'scheduler' as const };
let warn: jest.SpyInstance;
beforeEach(() => {
  rpcCalls.length = 0;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

const events = () => warn.mock.calls.filter((c) => c[0] === 'COMMUNITY_AI_CLAIM_RPC_ERROR_FAIL_CLOSED');

describe('a claim whose function is unavailable fails CLOSED and is logged distinctly', () => {
  it.each([
    ['scheduler (guardrailed)', { guardrailSource: 'scheduler' as const }, 'community_ai_claim_within_limits'],
    ['manual execute (plain claim)', {}, 'claim_community_ai_action_for_execution'],
  ])('%s: CLAIM_RPC_ERROR, one COMMUNITY_AI_CLAIM_RPC_ERROR_FAIL_CLOSED event with the driver code', async (_l, extra, rpc) => {
    rpcAnswer = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.x in the schema cache' } };
    const r = await claimCommunityActionForExecution({ ...INPUT, ...extra });
    expect(r).toMatchObject({ claimed: false, code: 'CLAIM_RPC_ERROR' });
    expect(rpcCalls.map((c) => c.name)).toEqual([rpc]);
    expect(events()).toHaveLength(1);
    expect(events()[0][1]).toEqual({ claim_point: 'scheduler', rpc, code: 'PGRST202', action_id: 'act-1' });
    // No message or payload in the log (the driver message could carry schema detail).
    expect(JSON.stringify(events()[0][1])).not.toContain('schema cache');
  });

  it('CONTROL: an ordinary refusal (the function answered claimed:false) is NOT logged as an RPC error', async () => {
    rpcAnswer = { data: [{ claimed: false, code: 'GUARDRAIL_DAILY_PLATFORM_LIMIT', current_status: 'approved' }], error: null };
    const r = await claimCommunityActionForExecution({ ...INPUT, guardrailSource: 'scheduler' });
    expect(r).toMatchObject({ claimed: false, code: 'GUARDRAIL_DAILY_PLATFORM_LIMIT' });
    expect(events()).toHaveLength(0);
  });
});
