/**
 * FIX-3 (owner 2026-11-27) — four advertised engagement actions can never work
 * and are now UNSUPPORTED in the capability matrix:
 *
 *   instagram.like  — the Instagram Graph API has no like endpoint (IG Media
 *                     exposes only like_count).
 *   facebook.dm     ┐ were api_verified/mode:'browser' → routed to the Chrome
 *   instagram.dm    │ extension, which (1.5.1) refuses every non-LinkedIn
 *   twitter.dm (x)  ┘ platform; no official-API DM path is implemented.
 *
 * What this suite proves, all against the REAL capability map:
 *   1. the four pairs resolve unsupported (with a reason, and no mode — so no
 *      caller can read a 'browser' route out of them), incl. the 'x' alias;
 *   2. POST /api/engagement/reply (the DM send path: a reply to a message whose
 *      message_type is 'dm') and POST /api/engagement/like refuse them with
 *      400 ACTION_NOT_SUPPORTED BEFORE executeAction is called and before any
 *      community_ai_actions row (the browser-dispatch queue) is written;
 *   3. GET /api/extension/commands does not hand such a row to the extension;
 *   4. every other supported pair is unchanged.
 *
 * Each refusal is paired with a supported control that DOES reach the executor
 * through the same harness, so a refusal cannot pass because the harness never
 * reached the gate.
 */

import {
  ENGAGEMENT_CAPABILITY_MATRIX,
  resolveEngagementCapability,
} from '../../services/engagementCapabilityMap';

type Row = Record<string, any>;

// ── In-memory database (reply / like routes + extension hand-out) ────────────
const db: Record<string, Row[]> = {};
const inserts: Array<{ table: string; row: Row }> = [];

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  let limitN = Infinity;
  const rows = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const api: any = {
    select() { return api; },
    eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return api; },
    is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return api; },
    or() { filters.push((r) => r.dispatch_lease_expires_at == null); return api; },
    in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return api; },
    gte() { return api; },
    order() { return api; },
    limit(n: number) { limitN = n; return api; },
    update(p: Row) { patch = p; return api; },
    maybeSingle() {
      const hit = rows()[0] ?? null;
      if (hit && patch) Object.assign(hit, patch);
      return Promise.resolve({ data: hit ? { ...hit } : null, error: null });
    },
    single() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
    upsert(row: Row) { inserts.push({ table, row }); (db[table] ??= []).push(row); return Promise.resolve({ error: null }); },
    insert(row: Row) {
      inserts.push({ table, row });
      (db[table] ??= []).push(row);
      const ins: any = {
        select() { return ins; },
        single() { return Promise.resolve({ data: row, error: null }); },
        then(ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) { return Promise.resolve({ error: null }).then(ok, ko); },
      };
      return ins;
    },
    then(ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) {
      const hits = rows();
      if (patch) for (const r of hits) Object.assign(r, patch);
      return Promise.resolve({ data: hits.slice(0, limitN).map((r) => ({ ...r })), error: null }).then(ok, ko);
    },
  };
  return api;
}

function from(t: string) {
  if (t === 'community_ai_platform_policy') {
    const q: any = {
      select: () => q,
      order: () => q,
      limit: async () => ({
        data: [{ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false, updated_at: '2026-11-01T00:00:00Z', updated_by: null }],
        error: null,
      }),
    };
    return q;
  }
  return builder(t);
}

jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => from(t) } }));
jest.mock('@/backend/db/supabaseClient', () => ({ supabase: { from: (t: string) => from(t) } }));

// ── Route scaffolding (mirrors engagementAiSendBoundaryF5.test.ts) ──────────
const ORG = 'org_f3';
const USER = 'user_f3';

jest.mock('@/lib/api/withContract', () => ({ withContract: (h: unknown) => h }));
jest.mock('../../../lib/api/withContract', () => ({ withContract: (h: unknown) => h }), { virtual: true });
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: async () => ({ userId: USER, defaultCompanyId: ORG }),
  enforceCompanyAccess: async () => ({ userId: USER }),
}));
jest.mock('../../services/rbacService', () => ({ enforceRole: async () => ({ userId: USER }) }));
jest.mock('../../services/rbac/communityAiCapabilities', () => ({
  COMMUNITY_AI_CAPABILITIES: { EXECUTE_ACTIONS: ['SUPER_ADMIN'], VIEW_ACTIONS: ['SUPER_ADMIN'] },
}));

const executeActionMock = jest.fn(async (..._a: unknown[]) => ({
  ok: true, status: 'executed', platform_id: 'native-id-1', correlation_id: 'corr-1', response: {},
}));
jest.mock('../../services/communityAiActionExecutor', () => ({
  executeAction: (...a: unknown[]) => executeActionMock(...a),
}));
// NOTE: the capability map is deliberately NOT mocked — this suite is about the real matrix.
jest.mock('../../services/responsePerformanceService', () => ({
  recordReplyPerformance: async () => undefined,
  incrementReplyLike: async () => undefined,
}));
jest.mock('../../services/engagementOpportunityResolutionService', () => ({ resolveOpportunityByReply: async () => undefined }));
jest.mock('../../services/auditLoggingService', () => ({ logAuditEvent: async () => undefined }));
jest.mock('../../services/aiSuggestionTrackingService', () => ({ recordSuggestionAccepted: async () => undefined }));
jest.mock('../../services/engagementThreadEventService', () => ({ recordThreadEvent: async () => undefined }));
jest.mock('../../services/engagementThreadService', () => ({
  isThreadActionable: async () => true,
  getThreadActionability: async (_o: string, ids: string[]) => new Map(ids.map((i) => [i, true])),
}));
jest.mock('../../services/campaignOwnershipService', () => ({
  resolveCampaignOwnership: async () => ({ status: 'OWNED', companyId: ORG }),
}));
jest.mock('../../services/communityAiContactGovernanceGate', () => ({
  resolveEngagementAuthorIdentity: async () => ({ ok: true, value: null }),
  personIdentityMetadata: () => ({}),
  checkCommunityActionContactGovernance: jest.fn(async () => ({ allowed: true, reason: 'not_suppressed', checked: 1 })),
  contactGateAuditPayload: jest.fn(() => ({})),
}));

// Extension hand-out scaffolding (mirrors r28KillSwitchHandoutMatrix.test.ts,
// minus its capability-map mock).
jest.mock('@/backend/middleware/extensionAuthMiddleware', () => ({
  requireExtensionAuth: async () => ({ session: { userId: USER, orgId: ORG, hmacNonce: 'nonce' } }),
}));
jest.mock('@/backend/services/extensionReliabilityService', () => ({ isCurrentlyDisabled: () => false }));
jest.mock('@/backend/services/extensionCommandSchema', () => ({
  COMMAND_SCHEMA_VERSION: 'schema-test',
  validateCommandPayload: (_p: string, _a: string, payload: Row) => ({ ok: true, payload }),
}));
jest.mock('@/backend/services/communityAiExecutionResultService', () => ({
  recordExecutionMetric: async () => undefined,
  persistExecutionResult: async () => ({ ok: true }),
}));
jest.mock('@/backend/services/rpaWorker/rpaAccountTier', () => ({ resolveAccountTier: async () => 'business' }));

import replyHandler from '../../../pages/api/engagement/reply';
import likeHandler from '../../../pages/api/engagement/like';
import commandsRoute from '../../../pages/api/extension/commands';
import { CAPABILITY_MAP_VERSION } from '../../services/engagementCapabilityMap';
import { __resetCommunityAiPlatformPolicyCacheForTests } from '../../services/communityAiPlatformPolicyService';

function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => res;
  return res;
}

function seedMessage(platform: string, messageType: 'dm' | 'comment') {
  db.engagement_messages = [{
    organization_id: ORG, id: 'm1', thread_id: 't1', platform,
    platform_message_id: `native:${platform}:1`, post_comment_id: null,
    message_type: messageType, author_id: null, raw_payload: {},
  }];
  db.engagement_threads = [{
    id: 't1', organization_id: ORG, platform_thread_id: `thread:${platform}:1`, raw_payload: {},
  }];
}

async function postReply(platform: string, messageType: 'dm' | 'comment') {
  seedMessage(platform, messageType);
  const res = mockRes();
  await (replyHandler as any)(
    { method: 'POST', headers: {}, body: { organization_id: ORG, message_id: 'm1', reply_text: 'Hello there', platform } },
    res,
  );
  return res;
}

async function postLike(platform: string) {
  seedMessage(platform, 'comment');
  const res = mockRes();
  await (likeHandler as any)(
    { method: 'POST', headers: {}, body: { organization_id: ORG, message_id: 'm1', platform } },
    res,
  );
  return res;
}

const browserQueueWrites = () => inserts.filter((i) => i.table === 'community_ai_actions');

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  inserts.length = 0;
  executeActionMock.mockClear();
  __resetCommunityAiPlatformPolicyCacheForTests();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
describe('FIX-3 §1 the four pairs resolve unsupported', () => {
  const UNSUPPORTED: Array<[string, 'like' | 'dm']> = [
    ['instagram', 'like'],
    ['facebook', 'dm'],
    ['instagram', 'dm'],
    ['twitter', 'dm'],
    ['x', 'dm'], // alias → twitter
    ['ig', 'like'], // alias → instagram
    ['fb', 'dm'], // alias → facebook
  ];

  it.each(UNSUPPORTED)('%s.%s is unsupported with a reason', (platform, action) => {
    const cap = resolveEngagementCapability(platform, action);
    expect(cap.status).toBe('unsupported');
    expect(typeof cap.reason).toBe('string');
    expect((cap.reason ?? '').length).toBeGreaterThan(0);
  });

  it.each(UNSUPPORTED)('%s.%s carries no execution mode (no silent browser redirect)', (platform, action) => {
    const cap = resolveEngagementCapability(platform, action);
    expect(cap.mode).toBeUndefined();
    expect(cap.mode).not.toBe('browser');
  });

  it('no non-LinkedIn row of the matrix routes anything to the browser', () => {
    // The only browser-mode pair left is LinkedIn DM (verified extension handler).
    const browserPairs: string[] = [];
    for (const [platform, row] of Object.entries(ENGAGEMENT_CAPABILITY_MATRIX)) {
      for (const [action, cap] of Object.entries(row)) {
        if (cap.mode === 'browser') browserPairs.push(`${platform}.${action}`);
      }
    }
    expect(browserPairs).toEqual(['linkedin.dm']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('FIX-3 §2 supported actions are unchanged', () => {
  const SUPPORTED: Array<[string, 'reply' | 'like' | 'dm', 'api' | 'browser', string]> = [
    ['linkedin', 'reply', 'api', 'any'],
    ['linkedin', 'like', 'api', 'any'],
    ['linkedin', 'dm', 'browser', 'any'],
    ['facebook', 'reply', 'api', 'business'],
    ['instagram', 'reply', 'api', 'business'],
    ['twitter', 'reply', 'api', 'any'],
    ['x', 'reply', 'api', 'any'],
    ['facebook', 'like', 'api', 'business'],
    ['twitter', 'like', 'api', 'any'],
    ['youtube', 'reply', 'api', 'any'],
    ['reddit', 'reply', 'api', 'any'],
  ];
  it.each(SUPPORTED)('%s.%s stays api_verified mode=%s account_type=%s', (platform, action, mode, account) => {
    const cap = resolveEngagementCapability(platform, action);
    expect(cap.status).toBe('api_verified');
    expect(cap.mode).toBe(mode);
    expect(cap.account_type).toBe(account);
  });

  it('post_create rows are untouched for the affected platforms', () => {
    for (const p of ['facebook', 'instagram', 'twitter'] as const) {
      expect(ENGAGEMENT_CAPABILITY_MATRIX[p].post_create).toMatchObject({ status: 'api_verified', mode: 'api' });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('FIX-3 §3 POST /api/engagement/reply refuses DMs on facebook / instagram / x before dispatch', () => {
  it.each(['facebook', 'instagram', 'twitter', 'x'])('DM on %s → 400 ACTION_NOT_SUPPORTED, executor never called', async (platform) => {
    const res = await postReply(platform, 'dm');
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('ACTION_NOT_SUPPORTED');
    expect(res.body.action).toBe('dm');
    expect(executeActionMock).not.toHaveBeenCalled();
    expect(browserQueueWrites()).toEqual([]);
  });

  it('control: LinkedIn DM through the same harness reaches the executor in browser mode', async () => {
    const res = await postReply('linkedin', 'dm');
    expect(executeActionMock).toHaveBeenCalledTimes(1);
    const action = executeActionMock.mock.calls[0][0] as Row;
    expect(action.action_type).toBe('dm');
    expect(action.execution_mode).toBe('browser');
    expect(res.body?.code).not.toBe('ACTION_NOT_SUPPORTED');
  });

  it.each(['facebook', 'instagram', 'twitter'])('control: comment reply on %s still dispatches in api mode', async (platform) => {
    const res = await postReply(platform, 'comment');
    expect(res.body?.code).not.toBe('ACTION_NOT_SUPPORTED');
    expect(executeActionMock).toHaveBeenCalledTimes(1);
    const action = executeActionMock.mock.calls[0][0] as Row;
    expect(action.action_type).toBe('reply');
    expect(action.execution_mode).toBe('api');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('FIX-3 §4 POST /api/engagement/like refuses Instagram before dispatch', () => {
  it.each(['instagram', 'ig'])('like on %s → 400 ACTION_NOT_SUPPORTED, executor never called', async (platform) => {
    const res = await postLike(platform);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('ACTION_NOT_SUPPORTED');
    expect(res.body.action).toBe('like');
    expect(executeActionMock).not.toHaveBeenCalled();
    expect(browserQueueWrites()).toEqual([]);
  });

  it.each(['facebook', 'twitter', 'linkedin'])('control: like on %s still dispatches in api mode', async (platform) => {
    const res = await postLike(platform);
    expect(res.body?.code).not.toBe('ACTION_NOT_SUPPORTED');
    expect(executeActionMock).toHaveBeenCalledTimes(1);
    const action = executeActionMock.mock.calls[0][0] as Row;
    expect(action.action_type).toBe('like');
    expect(action.execution_mode).toBe('api');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('FIX-3 §5 GET /api/extension/commands never hands out an unsupported row', () => {
  const pending = (over: Row): Row => ({
    organization_id: ORG, status: 'pending', execution_mode: 'browser', target_id: 'target-1',
    suggested_text: 'hi', created_at: '2026-11-27T10:00:00Z', dispatch_lease_id: null,
    dispatch_lease_expires_at: null, execution_correlation_id: 'corr', command_chain: null,
    command_chain_index: 0, approved_at: '2026-11-27T09:59:00Z', ...over,
  });

  async function poll(): Promise<string[]> {
    const res = mockRes();
    await (commandsRoute as any)(
      { method: 'GET', headers: { 'x-omnivyra-capability-version': CAPABILITY_MAP_VERSION }, query: {}, body: {} },
      res,
    );
    expect(res.statusCode).toBe(200);
    return (res.body?.commands ?? []).map((c: Row) => c.id);
  }

  it('pre-existing browser rows for the four pairs are not offered or claimed; LinkedIn DM control is', async () => {
    db.community_ai_actions = [
      pending({ id: 'fb-dm', platform: 'facebook', action_type: 'dm' }),
      pending({ id: 'ig-dm', platform: 'instagram', action_type: 'dm' }),
      pending({ id: 'tw-dm', platform: 'twitter', action_type: 'dm' }),
      pending({ id: 'x-dm', platform: 'x', action_type: 'dm' }),
      pending({ id: 'ig-like', platform: 'instagram', action_type: 'like' }),
      pending({ id: 'li-dm', platform: 'linkedin', action_type: 'dm' }),
    ];
    const ids = await poll();
    expect(ids).toEqual(['li-dm']);
    for (const id of ['fb-dm', 'ig-dm', 'tw-dm', 'x-dm', 'ig-like']) {
      const row = db.community_ai_actions.find((r) => r.id === id)!;
      expect(row.dispatch_lease_id ?? null).toBeNull();
    }
  });
});
