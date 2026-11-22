/**
 * Final review #4 (2026-11-22): a confirmed outbound DM marks other PENDING LinkedIn DMs to the same person as failed
 * ("superseded"). A "Message on LinkedIn" new DM (dm_lead_id set) belongs to one requester and may be on its way out
 * of that requester's browser; it must never be failed this way. CONTROL: an ordinary pending DM to the same person
 * is still superseded, as before.
 */
type Row = Record<string, any>;
const actions: Row[] = [];
const PROFILE = 'https://www.linkedin.com/in/alice-example/';
const THREAD = { id: 'thread-1', platform_thread_id: 'urn:li:thread:1', raw_payload: { participant_profile_url: PROFILE }, updated_at: '2026-11-22T10:00:00Z' };

function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  const result = () => {
    if (name === 'engagement_threads' && !patch) return { data: [THREAD], error: null };
    if (name === 'community_ai_actions' && patch) {
      for (const r of actions.filter((x) => filters.every((f) => f(x)))) Object.assign(r, patch);
    }
    return { data: [], error: null };
  };
  const q: any = {
    select: () => q, limit: () => q, order: () => q,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
    is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
    in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
    upsert: () => q,
    update: (p: Row) => { patch = p; return q; },
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
  };
  return q;
}
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: jest.fn((t: string) => table(t)) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: jest.fn((t: string) => table(t)) } }));

import { mirrorOutboundDmAction } from '../../services/engagementOutboundMirrorService';

const pendingDm = (over: Row) => ({
  organization_id: 'org-1', platform: 'linkedin', action_type: 'dm', status: 'pending', target_id: PROFILE,
  dm_lead_id: null, dispatch_lease_id: null, ...over,
});

beforeEach(() => { actions.length = 0; jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());

const confirmOutbound = () => mirrorOutboundDmAction({
  organizationId: 'org-1', actionId: 'sent-1', platform: 'linkedin', targetId: PROFILE, text: 'Hello Alice', confirmed: true,
});

it('a colleague\'s new DM to the same lead, already claimed by their extension, is NOT failed', async () => {
  actions.push(pendingDm({ id: 'newdm-b', dm_lead_id: 'lead-1', dispatch_lease_id: 'lease-b' }));
  await confirmOutbound();
  expect(actions[0].status).toBe('pending');
  expect(actions[0].dispatch_lease_id).toBe('lease-b');
});

it('CONTROL: an ordinary pending DM to the same person is superseded (failed), as before', async () => {
  actions.push(pendingDm({ id: 'plain-1' }));
  await confirmOutbound();
  expect(actions[0].status).toBe('failed');
  expect(actions[0].execution_result.reason).toBe('superseded_by_confirmed_outbound_dm');
});
