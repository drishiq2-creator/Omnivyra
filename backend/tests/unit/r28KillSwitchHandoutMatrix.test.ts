/**
 * Round 28 — kill switch at the extension hand-out (review P-4).
 *
 * GET /api/extension/commands is the last point before the browser sends.
 * Matrix: row kind × policy state → handed out (and claimed) / held, with the
 * REAL policy service and fail-closed evaluator. A missing policy row hands out
 * only a row with an approval of record (approved_at, stamped by a human send
 * or the approve route); unreadable / execution off hand out nothing outbound.
 * Harness copied from extensionLeaseHandoutPolicyGate.test.ts.
 */

type Row = Record<string, any>;

const ORG = 'org-1';
const db: { actions: Row[]; policy: Row[] | 'error' } = { actions: [], policy: [] };

function actionsQuery() {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  let limit = Infinity;
  const q: any = {
    select: () => q,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
    is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
    or: () => { filters.push((r) => r.dispatch_lease_expires_at == null); return q; },
    order: () => q,
    limit: (n: number) => { limit = n; return q; },
    update: (p: Row) => { patch = p; return q; },
    maybeSingle: async () => {
      const hit = db.actions.find((r) => filters.every((f) => f(r)));
      if (hit && patch) Object.assign(hit, patch);
      return { data: hit ? { id: hit.id } : null, error: null };
    },
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve({ data: db.actions.filter((r) => filters.every((f) => f(r))).slice(0, limit).map((r) => ({ ...r })), error: null }).then(ok, ko),
  };
  return q;
}

function policyQuery() {
  const q: any = {
    select: () => q,
    order: () => q,
    limit: async () => (db.policy === 'error' ? { data: null, error: { code: '42501' } } : { data: db.policy, error: null }),
  };
  return q;
}

const from = (t: string) => {
  if (t === 'community_ai_actions') return actionsQuery();
  if (t === 'community_ai_platform_policy') return policyQuery();
  // extension_sessions heartbeat (best-effort, fire-and-forget)
  const q: any = { update: () => q, eq: () => q, select: () => q, limit: async () => ({ data: [{ id: 's' }], error: null }), insert: async () => ({ error: null }) };
  return q;
};

// Round 24D / G-7: contact governance (suppression) is its own boundary, pinned in
// suppressionCommunity*.test.ts. This suite tests a different gate, so the
// governance check is held at "allowed" here.
jest.mock('../../services/communityAiContactGovernanceGate', () => ({
  checkCommunityActionContactGovernance: jest.fn(async () => ({ allowed: true, reason: 'not_suppressed', checked: 1 })),
  contactGateAuditPayload: jest.fn(() => ({})),
}));
jest.mock('@/backend/db/supabaseClient', () => ({ supabase: { from: (t: string) => from(t) } }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => from(t) } }));
jest.mock('@/backend/middleware/extensionAuthMiddleware', () => ({
  requireExtensionAuth: async () => ({ session: { userId: 'user-1', orgId: ORG, hmacNonce: 'nonce' } }),
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

const reply = (over: Row = {}): Row => ({
  id: 'reply-1', organization_id: ORG, status: 'pending', execution_mode: 'browser', platform: 'linkedin',
  action_type: 'reply', target_id: 'comment-1', suggested_text: 'Thanks!', created_at: '2026-11-03T10:00:00Z',
  dispatch_lease_id: null, dispatch_lease_expires_at: null, execution_correlation_id: 'corr-1',
  command_chain: null, command_chain_index: 0, approved_at: '2026-11-03T09:59:00Z', ...over,
});
const dmChain = (over: Row = {}): Row => reply({
  id: 'dm-1', action_type: 'dm', target_id: 'https://www.linkedin.com/messaging/thread/1/',
  command_chain: [{ action_type: 'open_thread', payload: { threadUrl: 'x' } }, { action_type: 'continue_thread', payload: { text: 'hi' } }],
  ...over,
});
const inboxSync = (over: Row = {}): Row => reply({
  id: 'sync-1', action_type: 'dm', target_id: 'sync-dm-inbox:linkedin', suggested_text: null,
  command_chain: [{ action_type: 'sync_dm_inbox', payload: { navigate: true } }], ...over,
});

const policyRow = (over: Row = {}): Row[] => [{
  execution_enabled: true, auto_rules_enabled: true, require_human_approval: false, updated_at: '2026-11-01T00:00:00Z', updated_by: null, ...over,
}];

async function poll(): Promise<{ status: number; ids: string[] }> {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  await (route as any)({ method: 'GET', headers: { 'x-omnivyra-capability-version': 'cap-test' }, query: {}, body: {} }, res);
  return { status: res.statusCode, ids: (res.body?.commands ?? []).map((c: Row) => c.id) };
}

const claimed = (id: string) => db.actions.find((r) => r.id === id)?.dispatch_lease_id != null;

beforeEach(() => {
  __resetCommunityAiPlatformPolicyCacheForTests();
  db.actions = [];
  db.policy = policyRow();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

type Mode = 'none' | 'unreadable' | 'exec_off' | 'auto_off' | 'enabled' | 'approval_required';
const setPolicy = (m: Mode) => {
  __resetCommunityAiPlatformPolicyCacheForTests();
  db.policy = m === 'none' ? []
    : m === 'unreadable' ? 'error'
    : m === 'exec_off' ? policyRow({ execution_enabled: false })
    : m === 'auto_off' ? policyRow({ auto_rules_enabled: false })
    : m === 'approval_required' ? policyRow({ require_human_approval: true })
    : policyRow();
};

const MATRIX: Array<[string, () => Row, Record<Mode, boolean>]> = [
  ['approved reply (human send)', () => reply(), { none: true, unreadable: false, exec_off: false, auto_off: true, enabled: true, approval_required: true }],
  ['un-approved reply (AI-prepared / auto-inserted)', () => reply({ approved_at: null }), { none: false, unreadable: false, exec_off: false, auto_off: true, enabled: true, approval_required: false }],
  ['approved DM chain, step 2 (continue_thread)', () => dmChain({ command_chain_index: 1 }), { none: true, unreadable: false, exec_off: false, auto_off: true, enabled: true, approval_required: true }],
  ['un-approved DM chain, step 1', () => dmChain({ approved_at: null }), { none: false, unreadable: false, exec_off: false, auto_off: true, enabled: true, approval_required: false }],
];

describe('extension hand-out: row × policy state', () => {
  for (const [name, make, expected] of MATRIX) {
    describe(name, () => {
      it.each((Object.keys(expected) as Mode[]).map((m) => [m, expected[m] ? 'handed out' : 'held'] as const))('policy %s → %s', async (mode) => {
        setPolicy(mode);
        const row = make();
        db.actions = [row];
        const out = await poll();
        expect(out.status).toBe(200);
        if (expected[mode]) {
          expect(out.ids).toEqual([row.id]);
          expect(claimed(String(row.id))).toBe(true);
        } else {
          expect(out.ids).toEqual([]);
          expect(claimed(String(row.id))).toBe(false);
        }
      });
    });
  }

  it.each(['OUTCOME_UNKNOWN', 'SENT_UNVERIFIED'])('a lost-response row (skipped + %s) is never re-offered, even under an enabled row', async (skip) => {
    setPolicy('enabled');
    db.actions = [reply({ status: 'skipped', skip_reason: skip }), reply({ id: 'reply-2' })];
    const out = await poll();
    expect(out.ids).toEqual(['reply-2']); // the scenario exists: the poll hands out the live row
    expect(claimed('reply-1')).toBe(false);
  });
});
