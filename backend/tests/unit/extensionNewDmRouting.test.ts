/**
 * "Message on LinkedIn" (owner-approved 2026-11-22): GET /api/extension/commands hands a new LinkedIn DM to a lead
 * (dm_lead_id set) ONLY to the requesting user's own Sales Navigator extension, signed in to the LinkedIn account
 * recorded on the approval; never to anyone else; at most once.
 * The database double applies every filter the route sends (eq / is / not / or / limit / order) at READ time and
 * again at CLAIM time, so filtering in the query vs after it, and the claim's conditions, are what is tested.
 */
type Row = Record<string, any>;

const ORG = 'org-1';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const ALICE_MEMBER = 'ACoAAALICEALICEALICEALICE0003';
const BOB_MEMBER = 'ACoAABOBBOBBOBBOBBOBBOBB00004';
const db: { actions: Row[]; reads: number; betweenReadAndClaim: null | (() => void) } = { actions: [], reads: 0, betweenReadAndClaim: null };
let session: { userId: string; product?: 'salesnav' | 'linkedin_engagement' } = { userId: ALICE };
let bindings: Record<string, string | 'unreadable'> = {};

const cmp = (v: unknown) => (v == null ? null : v);
function actionsQuery() {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  let limit = Infinity;
  const q: any = {
    select: () => q,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
    is: (k: string, v: unknown) => { filters.push((r) => cmp(r[k]) === v); return q; },
    not: (k: string, op: string, v: unknown) => {
      if (op !== 'is' || v !== null) throw new Error(`unexpected not(${k}, ${op})`);
      filters.push((r) => cmp(r[k]) !== null); return q;
    },
    or: () => { filters.push((r) => r.dispatch_lease_expires_at == null || r.dispatch_lease_expires_at < new Date().toISOString()); return q; },
    order: () => q,
    limit: (n: number) => { limit = n; return q; },
    update: (p: Row) => { patch = p; return q; },
    maybeSingle: async () => {
      const hit = db.actions.find((r) => filters.every((f) => f(r)));
      if (hit && patch) Object.assign(hit, patch);
      return { data: hit ? { id: hit.id } : null, error: null };
    },
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      db.reads += 1;
      const rows = db.actions.filter((r) => filters.every((f) => f(r)))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit).map((r) => ({ ...r }));
      const hook = db.betweenReadAndClaim; db.betweenReadAndClaim = null;
      if (hook) hook();
      return Promise.resolve({ data: rows, error: null }).then(ok, ko);
    },
  };
  return q;
}
const from = (t: string) => {
  if (t === 'community_ai_actions') return actionsQuery();
  if (t === 'community_ai_platform_policy') {
    const q: any = { select: () => q, order: () => q, limit: async () => ({ data: [{ execution_enabled: true, auto_rules_enabled: false, require_human_approval: false, updated_at: '2026-11-01T00:00:00Z', updated_by: null }], error: null }) };
    return q;
  }
  const q: any = { update: () => q, eq: () => q, select: () => q, limit: async () => ({ data: [{ id: 's' }], error: null }), insert: async () => ({ error: null }) };
  return q;
};

jest.mock('@/backend/db/supabaseClient', () => ({ supabase: { from: (t: string) => from(t) } }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => from(t) } }));
jest.mock('@/backend/services/salesNav/store', () => ({
  boundMember: async (_org: string, userId: string) => (userId in bindings ? bindings[userId] : null),
}));
jest.mock('@/backend/middleware/extensionAuthMiddleware', () => ({
  requireExtensionAuth: async () => ({ session: { orgId: ORG, hmacNonce: 'nonce', ...session } }),
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('@/backend/services/engagementCapabilityMap', () => ({
  CAPABILITY_MAP_VERSION: 'cap-test', resolveEngagementCapability: () => ({ status: 'api_verified' }),
}));
jest.mock('@/backend/services/extensionReliabilityService', () => ({ isCurrentlyDisabled: () => false }));
jest.mock('@/backend/services/extensionCommandSchema', () => ({
  COMMAND_SCHEMA_VERSION: 'schema-test', validateCommandPayload: (_p: string, _a: string, payload: Row) => ({ ok: true, payload }),
}));
jest.mock('@/backend/services/communityAiExecutionResultService', () => ({
  recordExecutionMetric: async () => undefined, persistExecutionResult: async () => ({ ok: true }),
}));
jest.mock('@/backend/services/rpaWorker/rpaAccountTier', () => ({ resolveAccountTier: async () => 'business' }));

import route from '../../../pages/api/extension/commands';
import { __resetCommunityAiPlatformPolicyCacheForTests } from '../../services/communityAiPlatformPolicyService';

let seq = 0;
const base = (over: Row = {}): Row => ({
  id: `row-${++seq}`, organization_id: ORG, status: 'pending', execution_mode: 'browser', platform: 'linkedin', target_id: 't',
  suggested_text: 'Hi', created_at: `2026-11-22T10:${String(seq).padStart(2, '0')}:00Z`, dispatch_lease_id: null, dispatch_lease_expires_at: null,
  execution_correlation_id: 'corr', command_chain: null, command_chain_index: 0, approved_at: '2026-11-22T09:59:00Z',
  acting_user_id: null, dm_lead_id: null, dm_sender_member_id: null, ...over,
});
const newDm = (over: Row = {}) => base({
  action_type: 'dm', target_id: 'https://www.linkedin.com/in/lead/', acting_user_id: ALICE, dm_lead_id: 'lead-1', dm_sender_member_id: ALICE_MEMBER,
  command_chain: [{ action_type: 'start_new_dm', payload: { recipientProfileUrl: 'https://www.linkedin.com/in/lead/', text: 'Hi', autoSubmit: true, senderMemberId: ALICE_MEMBER } }],
  ...over,
});
const reply = (over: Row = {}) => base({ action_type: 'reply', ...over });

async function poll({ strict = true } = {}): Promise<{ status: number; ids: string[] }> {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  const headers: Record<string, string> = { 'x-omnivyra-capability-version': 'cap-test' };
  if (strict) headers['x-omnivyra-dispatch-renewal'] = '1';
  await (route as any)({ method: 'GET', headers, query: {}, body: {} }, res);
  return { status: res.statusCode, ids: (res.body?.commands ?? []).map((c: Row) => c.id) };
}
const claimed = (id: string) => db.actions.find((r) => r.id === id)?.dispatch_lease_id != null;

beforeEach(() => {
  __resetCommunityAiPlatformPolicyCacheForTests();
  db.actions = []; db.reads = 0; db.betweenReadAndClaim = null;
  session = { userId: ALICE, product: 'salesnav' };
  bindings = { [ALICE]: ALICE_MEMBER, [BOB]: BOB_MEMBER };
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('sender isolation (review finding 1)', () => {
  it('CONTROL: the requesting user\'s Sales Navigator extension, bound to the recorded account, gets and claims it', async () => {
    const dm = newDm(); db.actions = [dm];
    expect(await poll()).toEqual({ status: 200, ids: [dm.id] });
    expect(claimed(dm.id)).toBe(true);
  });

  it('a colleague\'s Sales Navigator extension never receives it', async () => {
    const dm = newDm(); db.actions = [dm];
    session = { userId: BOB, product: 'salesnav' };
    expect((await poll()).ids).toEqual([]);
    expect(claimed(dm.id)).toBe(false);
  });

  it('a colleague linked to the SAME LinkedIn account still never receives it (the approval names the user)', async () => {
    const dm = newDm(); db.actions = [dm];
    bindings[BOB] = ALICE_MEMBER;
    session = { userId: BOB, product: 'salesnav' };
    expect((await poll()).ids).toEqual([]);
    expect(claimed(dm.id)).toBe(false);
  });

  it('the right user signed in to a DIFFERENT LinkedIn account never receives it', async () => {
    const dm = newDm(); db.actions = [dm];
    bindings[ALICE] = BOB_MEMBER;
    expect((await poll()).ids).toEqual([]);
  });

  it('no linked account -> nothing; an unreadable binding -> 503, never "nothing to do"', async () => {
    db.actions = [newDm()];
    delete bindings[ALICE];
    expect(await poll()).toEqual({ status: 200, ids: [] });
    bindings[ALICE] = 'unreadable';
    expect((await poll()).status).toBe(503);
  });

  it('unapproved -> never offered; non-strict client -> never offered; a claimed row is never re-offered', async () => {
    db.actions = [newDm({ approved_at: null })];
    expect((await poll()).ids).toEqual([]);
    db.actions = [newDm()];
    expect((await poll({ strict: false })).ids).toEqual([]);
    db.actions = [newDm({ dispatch_lease_id: 'lease-old', dispatch_lease_expires_at: '2026-01-01T00:00:00Z' })];
    expect((await poll()).ids).toEqual([]);
  });

  it('a Sales Navigator session gets nothing but new DMs to leads (replies, other DMs stay)', async () => {
    const r = reply(); const other = base({ action_type: 'dm', command_chain: [{ action_type: 'start_new_dm', payload: {} }] });
    db.actions = [r, other];
    expect((await poll()).ids).toEqual([]);
    expect(claimed(r.id) || claimed(other.id)).toBe(false);
  });
});

describe('no starvation: filtering happens in the query (review finding 2)', () => {
  it('Sales Navigator: 15 newer engagement rows do not hide the DM', async () => {
    const dm = newDm({ created_at: '2026-11-22T08:00:00Z' });
    db.actions = [dm, ...Array.from({ length: 15 }, (_, i) => reply({ created_at: `2026-11-22T11:${String(i).padStart(2, '0')}:00Z` }))];
    expect((await poll()).ids).toEqual([dm.id]);
  });

  it('engagement: 15 newer new-DM rows do not hide a reply; none of them is claimed', async () => {
    session = { userId: ALICE, product: 'linkedin_engagement' };
    const r = reply({ created_at: '2026-11-22T08:00:00Z' });
    const dms = Array.from({ length: 15 }, (_, i) => newDm({ created_at: `2026-11-22T11:${String(i).padStart(2, '0')}:00Z` }));
    db.actions = [r, ...dms];
    expect((await poll()).ids).toEqual([r.id]);
    expect(dms.some((d) => claimed(d.id))).toBe(false);
  });

  it.each([['linkedin_engagement'], [undefined]] as const)('a %p session never gets a new DM to a lead, strict or legacy', async (p) => {
    session = { userId: ALICE, ...(p ? { product: p } : {}) };
    db.actions = [newDm(), newDm({ dispatch_lease_id: 'old', dispatch_lease_expires_at: '2026-01-01T00:00:00Z' })];
    expect((await poll()).ids).toEqual([]);
    expect((await poll({ strict: false })).ids).toEqual([]);
  });

  it('CONTROL: a non-LinkedIn new DM (Instagram start_new_dm) still goes to the engagement path, not Sales Navigator', async () => {
    const ig = base({ platform: 'instagram', action_type: 'dm', command_chain: [{ action_type: 'start_new_dm', payload: { recipientHandle: 'x', text: 'hi' } }] });
    session = { userId: ALICE, product: 'linkedin_engagement' };
    db.actions = [ig];
    expect((await poll()).ids).toEqual([ig.id]);
    db.actions = [base({ ...ig, id: 'ig-2', dispatch_lease_id: null })];
    session = { userId: ALICE, product: 'salesnav' };
    expect((await poll()).ids).toEqual([]);
  });
});

describe('the claim is atomic against a release-and-requeue between read and claim (review finding 3)', () => {
  it('a row claimed and released (lease cleared) by someone else after the read is NOT claimed again', async () => {
    const dm = newDm(); db.actions = [dm];
    db.betweenReadAndClaim = () => {
      // another session claimed it, ran it, and a report re-pended it with the lease cleared
      Object.assign(dm, { dispatch_lease_id: 'lease-other', dispatch_lease_expires_at: null });
      Object.assign(dm, { dispatch_lease_id: null, dispatch_lease_expires_at: null, command_chain_index: 1 });
    };
    expect((await poll()).ids).toEqual([]);
    expect(dm.dispatch_lease_id).toBeNull();
  });

  it('a row claimed by someone else after the read (lease set, expiry cleared) is NOT claimed', async () => {
    const dm = newDm(); db.actions = [dm];
    db.betweenReadAndClaim = () => { dm.dispatch_lease_id = 'lease-other'; };
    expect((await poll()).ids).toEqual([]);
    expect(dm.dispatch_lease_id).toBe('lease-other');
  });

  it('CONTROL: an untouched row is claimed', async () => {
    const dm = newDm(); db.actions = [dm];
    db.betweenReadAndClaim = () => undefined;
    expect((await poll()).ids).toEqual([dm.id]);
  });
});

describe('review 3 T / N4: a new-DM row without its job never blocks the one-row page', () => {
  it('a newer approved new DM that has NO command_chain is not offered; the older valid one is', async () => {
    const valid = newDm({ dm_lead_id: 'lead-a' });
    const stepless = newDm({ dm_lead_id: 'lead-b', command_chain: null });   // created later -> sorts first
    db.actions = [valid, stepless];
    expect((await poll()).ids).toEqual([valid.id]);
    expect(claimed(stepless.id)).toBe(false);
  });

  it('CONTROL: with the job present, the newer row is the one offered (the page really is one row)', async () => {
    const older = newDm({ dm_lead_id: 'lead-a' });
    const newer = newDm({ dm_lead_id: 'lead-b' });
    db.actions = [older, newer];
    expect((await poll()).ids).toEqual([newer.id]);
  });
});
