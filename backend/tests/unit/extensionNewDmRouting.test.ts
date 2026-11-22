/**
 * Owner 2026-11-22: approved NEW LinkedIn DMs to leads are sent only by the Omnivyra Sales Navigator extension.
 * GET /api/extension/commands therefore offers:
 *   - a salesnav session: ONLY LinkedIn start_new_dm rows, ONLY when approved_at is set (even if the platform policy
 *     does not require approval), ONLY in strict-claim mode (x-omnivyra-dispatch-renewal: 1 - never-claimed rows,
 *     so a claimed DM is never offered again);
 *   - every other session (engagement, or no product): never a LinkedIn start_new_dm; everything else as before.
 * Same doubles as extensionLeaseHandoutPolicyGate.test.ts; the session's product is the variable.
 */
type Row = Record<string, any>;

const ORG = 'org-1';
const db: { actions: Row[] } = { actions: [] };
let sessionProduct: 'salesnav' | 'linkedin_engagement' | undefined;

function actionsQuery() {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  const q: any = {
    select: () => q,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
    is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
    or: () => { filters.push((r) => r.dispatch_lease_expires_at == null || r.dispatch_lease_expires_at < new Date().toISOString()); return q; },
    order: () => q,
    limit: () => q,
    update: (p: Row) => { patch = p; return q; },
    maybeSingle: async () => {
      const hit = db.actions.find((r) => filters.every((f) => f(r)));
      if (hit && patch) Object.assign(hit, patch);
      return { data: hit ? { id: hit.id } : null, error: null };
    },
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve({ data: db.actions.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null }).then(ok, ko),
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
jest.mock('@/backend/middleware/extensionAuthMiddleware', () => ({
  requireExtensionAuth: async () => ({ session: { userId: 'user-1', orgId: ORG, hmacNonce: 'nonce', ...(sessionProduct ? { product: sessionProduct } : {}) } }),
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

const base = (over: Row = {}): Row => ({
  organization_id: ORG, status: 'pending', execution_mode: 'browser', platform: 'linkedin', target_id: 't',
  suggested_text: 'Hi', created_at: '2026-11-22T10:00:00Z', dispatch_lease_id: null, dispatch_lease_expires_at: null,
  execution_correlation_id: 'corr', command_chain: null, command_chain_index: 0, approved_at: '2026-11-22T09:59:00Z', ...over,
});
const newDm = (over: Row = {}) => base({
  id: 'newdm-1', action_type: 'dm',
  command_chain: [{ action_type: 'start_new_dm', payload: { recipientProfileUrl: 'https://www.linkedin.com/in/alice/', text: 'Hi Alice', autoSubmit: true } }],
  ...over,
});
const reply = (over: Row = {}) => base({ id: 'reply-1', action_type: 'reply', ...over });
const threadDm = (over: Row = {}) => base({
  id: 'thread-1', action_type: 'dm',
  command_chain: [{ action_type: 'open_thread', payload: { threadUrl: 'x' } }, { action_type: 'continue_thread', payload: { text: 'hi' } }],
  ...over,
});

async function poll({ strict = true } = {}): Promise<string[]> {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  const headers: Record<string, string> = { 'x-omnivyra-capability-version': 'cap-test' };
  if (strict) headers['x-omnivyra-dispatch-renewal'] = '1';
  await (route as any)({ method: 'GET', headers, query: {}, body: {} }, res);
  expect(res.statusCode).toBe(200);
  return (res.body?.commands ?? []).map((c: Row) => c.id);
}
const claimed = (id: string) => db.actions.find((r) => r.id === id)?.dispatch_lease_id != null;

beforeEach(() => {
  __resetCommunityAiPlatformPolicyCacheForTests();
  sessionProduct = undefined;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('approved new LinkedIn DMs go only to the Sales Navigator extension', () => {
  it('CONTROL: a salesnav session is offered and claims an approved new DM', async () => {
    sessionProduct = 'salesnav';
    db.actions = [newDm()];
    expect(await poll()).toEqual(['newdm-1']);
    expect(claimed('newdm-1')).toBe(true);
  });

  it('a salesnav session is offered NOTHING else (replies, thread DMs), and nothing else is claimed', async () => {
    sessionProduct = 'salesnav';
    db.actions = [reply(), threadDm(), newDm()];
    expect(await poll()).toEqual(['newdm-1']);
    expect(claimed('reply-1')).toBe(false);
    expect(claimed('thread-1')).toBe(false);
  });

  it('an UNAPPROVED new DM is never offered, even though the platform policy does not require approval', async () => {
    sessionProduct = 'salesnav';
    db.actions = [newDm({ approved_at: null })];
    expect(await poll()).toEqual([]);
    expect(claimed('newdm-1')).toBe(false);
  });

  it('without strict claims (a client that could be re-offered a lapsed claim) nothing is offered', async () => {
    sessionProduct = 'salesnav';
    db.actions = [newDm()];
    expect(await poll({ strict: false })).toEqual([]);
  });

  it('a DM already claimed once is never offered again (lapsed lease, strict mode) - at most once', async () => {
    sessionProduct = 'salesnav';
    db.actions = [newDm({ dispatch_lease_id: 'lease-old', dispatch_lease_expires_at: '2026-01-01T00:00:00Z' })];
    expect(await poll()).toEqual([]);
  });

  it.each([['linkedin_engagement'], [undefined]] as const)('a %p session is never offered a new LinkedIn DM, and still gets everything else', async (p) => {
    sessionProduct = p;
    db.actions = [newDm(), reply(), threadDm()];
    const ids = await poll();
    expect(ids).not.toContain('newdm-1');
    expect(claimed('newdm-1')).toBe(false);
    expect(ids).toEqual(expect.arrayContaining(['reply-1', 'thread-1']));
  });
});
