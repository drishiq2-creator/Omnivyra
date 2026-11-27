/**
 * Phase E - the promise behind redeem's `product: 'salesnav'` echo.
 *
 * The Sales Navigator package polls GET /api/extension/commands ONLY when redeem echoed product 'salesnav'
 * (extension background/serviceWorker.js: "Against an older server (no product echoed at sign-in) the command route
 * is NEVER polled: it would claim the company's engagement jobs for this extension"). So once redeem echoes it, a
 * 'salesnav' session must be handed (and must claim) NO engagement work. Legacy and 'linkedin_engagement' sessions
 * are unchanged - each refusal below has that control.
 *
 * The session comes from the REAL token: the auth middleware is mocked to verify the bearer token with the real
 * extensionSessionService, so the product is the one bound (and signed) at redeem.
 */
process.env.EXTENSION_SESSION_SECRET = 'test-extension-session-secret-not-production';

type Row = Record<string, any>;
const ORG = 'org-pf-1';
const db: { actions: Row[]; actionReads: number } = { actions: [], actionReads: 0 };

function actionsQuery() {
  db.actionReads += 1;
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  const q: any = {
    select: () => q,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
    is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
    or: () => { filters.push((r) => r.dispatch_lease_expires_at == null); return q; },
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
const policyQuery = () => {
  const q: any = { select: () => q, order: () => q, limit: async () => ({ data: [{ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false, updated_at: '2026-11-01T00:00:00Z', updated_by: null }], error: null }) };
  return q;
};
const from = (t: string) => {
  if (t === 'community_ai_actions') return actionsQuery();
  if (t === 'community_ai_platform_policy') return policyQuery();
  const q: any = { update: () => q, eq: () => q, select: () => q, limit: async () => ({ data: [{ id: 's' }], error: null }), insert: async () => ({ error: null }) };
  return q;
};

jest.mock('../../services/communityAiContactGovernanceGate', () => ({
  checkCommunityActionContactGovernance: jest.fn(async () => ({ allowed: true, reason: 'not_suppressed', checked: 1 })),
  contactGateAuditPayload: jest.fn(() => ({})),
}));
jest.mock('@/backend/db/supabaseClient', () => ({ supabase: { from: (t: string) => from(t) } }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => from(t) } }));
jest.mock('@/backend/middleware/extensionAuthMiddleware', () => ({
  requireExtensionAuth: async (req: any, res: any) => {
    const svc = jest.requireActual('../../services/extensionSessionService');
    const session = svc.verifyExtensionSessionToken(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!session) { res.status(401).json({ success: false, error: 'INVALID_SESSION' }); return null; }
    return { session };
  },
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
import { issueExtensionSessionToken } from '../../services/extensionSessionService';
import { __resetCommunityAiPlatformPolicyCacheForTests } from '../../services/communityAiPlatformPolicyService';

const reply = (): Row => ({
  id: 'reply-1', organization_id: ORG, status: 'pending', execution_mode: 'browser', platform: 'linkedin',
  action_type: 'reply', target_id: 'comment-1', suggested_text: 'Thanks!', created_at: '2026-11-03T10:00:00Z',
  dispatch_lease_id: null, dispatch_lease_expires_at: null, execution_correlation_id: 'corr-1',
  command_chain: null, command_chain_index: 0, approved_at: '2026-11-03T09:59:00Z',
});

const tokenFor = (product?: string) => issueExtensionSessionToken({
  userId: 'user-pf-1', orgId: ORG, expiresAt: Date.now() + 3600_000, hmacNonce: 'hn-pf-1', ...(product ? { product: product as any } : {}),
});

async function poll(token: string) {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  await (route as any)({
    method: 'GET', url: '/api/extension/commands', query: {}, body: {},
    headers: { authorization: `Bearer ${token}`, 'x-omnivyra-capability-version': 'cap-test', 'x-omnivyra-dispatch-renewal': '1' },
  }, res);
  return { status: res.statusCode, ids: (res.body?.commands ?? []).map((c: Row) => c.id) };
}

beforeEach(() => {
  __resetCommunityAiPlatformPolicyCacheForTests();
  db.actions = [reply()];
  db.actionReads = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/extension/commands by session product', () => {
  it("a 'salesnav' session gets no command, reads no action and claims nothing", async () => {
    const r = await poll(tokenFor('salesnav'));
    expect(r).toEqual({ status: 200, ids: [] });
    expect(db.actionReads).toBe(0);
    expect(db.actions[0].dispatch_lease_id).toBeNull();
  });

  it('control: a LEGACY session (no product) is handed the same pending row and claims it', async () => {
    const r = await poll(tokenFor());
    expect(r).toEqual({ status: 200, ids: ['reply-1'] });
    expect(db.actions[0].dispatch_lease_id).not.toBeNull();
  });

  it("control: a 'linkedin_engagement' session is handed the row", async () => {
    const r = await poll(tokenFor('linkedin_engagement'));
    expect(r).toEqual({ status: 200, ids: ['reply-1'] });
  });
});
