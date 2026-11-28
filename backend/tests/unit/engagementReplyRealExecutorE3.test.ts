/**
 * E3 review condition 1 — POST /api/engagement/reply driven through the REAL
 * executeAction (auto_insert + runExecution + persistExecutionResult).
 *
 * Mocked only at the boundaries: the DB client (an in-memory community_ai_actions
 * table enforcing Production's UNIQUE (organization_id, idempotency_key) WHERE
 * idempotency_key IS NOT NULL with SQLSTATE 23505), the LinkedIn connector (the
 * provider call), and the executor's side-channel services (usage, notify,
 * webhook, ledger, token store, policy value). The route's own identity/RBAC
 * collaborators are stubbed as in every reply-route suite.
 *
 * Asserts: one row, carrying the E3 key unchanged after persist, terminal;
 * the key and NULL dispatch-lease fields are already on the row AT the provider
 * call (the claim happened before the send and took no lease); a retry with the
 * same key makes no second connector call; a pre-send refusal is reclaimed
 * without touching the lease fields. Control: a different key → two rows, two
 * connector calls.
 */
import { createHash } from 'crypto';

type Row = Record<string, any>;
const mockDb: Record<string, Row[]> = {};
const MOCK_UNIQUE = { code: '23505', message: 'duplicate key value violates unique constraint "idx_community_ai_actions_org_idempotency_key"' };

function mockCollides(table: string, cand: Row, selfId?: unknown) {
  if (table !== 'community_ai_actions' || cand.idempotency_key == null) return false;
  return (mockDb[table] ?? []).some((r) => r.id !== selfId && r.organization_id === cand.organization_id && r.idempotency_key === cand.idempotency_key);
}

function mockBuilder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  let insertRow: Row | null = null;
  let limitN = Infinity;
  const rows = () => (mockDb[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const exec = (): { data: Row[]; error: unknown } => {
    if (insertRow) {
      const row = insertRow;
      if ((mockDb[table] ?? []).some((r) => r.id != null && r.id === row.id) || mockCollides(table, row)) return { data: [], error: MOCK_UNIQUE };
      (mockDb[table] ??= []).push({ ...row });
      return { data: [{ ...row }], error: null };
    }
    if (patch) {
      const hits = rows();
      for (const r of hits) if (mockCollides(table, { ...r, ...patch }, r.id)) return { data: [], error: MOCK_UNIQUE };
      for (const r of hits) Object.assign(r, patch);
      return { data: hits.map((r) => ({ ...r })), error: null };
    }
    return { data: rows().slice(0, limitN).map((r) => ({ ...r })), error: null };
  };
  const api: any = {
    select() { return api; },
    eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return api; },
    is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return api; },
    in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return api; },
    or() { return api; }, gte() { return api; }, lte() { return api; }, order() { return api; },
    limit(n: number) { limitN = n; return api; },
    update(p: Row) { patch = p; return api; },
    insert(row: Row) { insertRow = row; return api; },
    upsert(row: Row) { (mockDb[table] ??= []).push({ ...row }); return Promise.resolve({ error: null }); },
    maybeSingle() { const r = exec(); return Promise.resolve({ data: r.data[0] ?? null, error: r.error }); },
    single() { const r = exec(); return Promise.resolve({ data: r.data[0] ?? null, error: r.error }); },
    then(ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) { const r = exec(); return Promise.resolve({ data: r.data, error: r.error }).then(ok, ko); },
  };
  return api;
}
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => mockBuilder(t), rpc: async () => ({ data: null, error: null }) } }));
jest.mock('@/backend/db/supabaseClient', () => ({ supabase: { from: (t: string) => mockBuilder(t), rpc: async () => ({ data: null, error: null }) } }));

// ── route collaborators ──────────────────────────────────────────────────────
const ORG = 'org_e3_real';
const USER = 'user_e3_real';
jest.mock('@/lib/api/withContract', () => ({ withContract: (h: unknown) => h }));
jest.mock('../../../lib/api/withContract', () => ({ withContract: (h: unknown) => h }), { virtual: true });
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: async () => ({ userId: 'user_e3_real', defaultCompanyId: 'org_e3_real' }),
  enforceCompanyAccess: async () => ({ userId: 'user_e3_real' }),
}));
jest.mock('../../services/rbacService', () => ({ enforceRole: async () => ({ userId: 'user_e3_real' }) }));
jest.mock('../../services/rbac/communityAiCapabilities', () => ({
  COMMUNITY_AI_CAPABILITIES: { EXECUTE_ACTIONS: ['SUPER_ADMIN'], VIEW_ACTIONS: ['SUPER_ADMIN'] },
}));
jest.mock('../../services/responsePerformanceService', () => ({ recordReplyPerformance: async () => undefined }));
jest.mock('../../services/engagementOpportunityResolutionService', () => ({ resolveOpportunityByReply: async () => undefined }));
jest.mock('../../services/auditLoggingService', () => ({ logAuditEvent: async () => undefined }));
jest.mock('../../services/aiSuggestionTrackingService', () => ({ recordSuggestionAccepted: async () => undefined }));
jest.mock('../../services/engagementThreadEventService', () => ({ recordThreadEvent: async () => undefined }));
jest.mock('../../services/engagementThreadService', () => ({ isThreadActionable: async () => true }));
jest.mock('../../services/communityAiContactGovernanceGate', () => ({
  resolveEngagementAuthorIdentity: async () => ({ ok: true, value: null }),
  personIdentityMetadata: () => ({}),
  checkCommunityActionContactGovernance: jest.fn(async () => ({ allowed: true, reason: 'not_suppressed', checked: 1 })),
  contactGateAuditPayload: jest.fn(() => ({})),
}));

// ── executor boundaries (the executor itself is REAL) ────────────────────────
let mockPolicy: Record<string, unknown> = { execution_enabled: true, auto_rules_enabled: true, require_human_approval: false };
jest.mock('../../services/communityAiPlatformPolicyService', () =>
  jest.requireActual('../helpers/communityAiPolicyMock').policyServiceMock(() => mockPolicy));
jest.mock('../../services/usageEnforcementService', () => ({ checkUsageBeforeExecution: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageMeterService', () => ({ incrementUsageMeter: jest.fn(async () => undefined) }));
jest.mock('../../services/platformTokenService', () => ({ getToken: jest.fn(async () => ({ access_token: 'test-token' })) }));
jest.mock('../../services/rpaWorker/rpaWorkerService', () => ({ executeRpaTask: jest.fn(async () => ({ success: true })) }));

/** Row snapshots taken AT the provider call. */
const mockAtSend: Row[] = [];
const mockConnector = jest.fn(async (action: Row) => {
  const row = (mockDb.community_ai_actions ?? []).find((r) => r.id === action.id);
  mockAtSend.push(row ? { ...row } : { missing: true });
  return { success: true, platform_id: `urn:li:comment:(native,${mockConnector.mock.calls.length})`, platform_response: { data: { id: 'x' } } };
});
jest.mock('../../services/platformConnectors/linkedinConnector', () => ({
  executeAction: (...a: unknown[]) => (mockConnector as any)(...a),
}));

import replyHandler from '../../../pages/api/engagement/reply';
import { __resetCommunityAiPlatformPolicyCacheForTests } from '../../services/communityAiPlatformPolicyService';

const h = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const e3Key = (clientKey: string, text: string) =>
  'engagement-reply:v1:' + h(JSON.stringify([ORG, 'message:m1', 'linkedin', 'reply', clientKey, h(text.replace(/\s+/g, ' ').trim())]));

const KEY_1 = 'aaaaaaaa-1111-4bbb-8ccc-000000000001';
const KEY_2 = 'aaaaaaaa-1111-4bbb-8ccc-000000000002';
const TEXT = 'Thanks — appreciate the comment!';
const LEASE = ['dispatch_lease_id', 'dispatch_lease_expires_at', 'dispatch_lease_holder_id'];

function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => res;
  return res;
}
async function post(clientKey: string) {
  const res = mockRes();
  await (replyHandler as any)({ method: 'POST', headers: {}, body: { organization_id: ORG, message_id: 'm1', platform: 'linkedin', reply_text: TEXT, client_reply_key: clientKey } }, res);
  return res;
}
const actions = () => mockDb.community_ai_actions ?? [];

beforeEach(() => {
  for (const k of Object.keys(mockDb)) delete mockDb[k];
  mockDb.engagement_messages = [{
    organization_id: ORG, id: 'm1', thread_id: 't1', platform: 'linkedin',
    platform_message_id: 'urn:li:comment:(urn:li:activity:1,7)', post_comment_id: null,
    message_type: 'comment', author_id: null, raw_payload: {},
  }];
  mockDb.engagement_threads = [{ id: 't1', organization_id: ORG, platform_thread_id: 'urn:li:share:1', raw_payload: {} }];
  mockAtSend.length = 0;
  mockConnector.mockClear();
  mockPolicy = { execution_enabled: true, auto_rules_enabled: true, require_human_approval: false };
  __resetCommunityAiPlatformPolicyCacheForTests();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('E3 through the real executeAction', () => {
  it('one row, E3 key unchanged after persist, terminal; key + NULL lease fields already on the row at the provider call', async () => {
    const res = await post(KEY_1);
    expect(res.statusCode).toBe(200);
    expect(mockConnector).toHaveBeenCalledTimes(1);
    expect(actions()).toHaveLength(1);
    const row = actions()[0];
    expect(row.idempotency_key).toBe(e3Key(KEY_1, TEXT));
    expect(row.status).toBe('executed');
    // At the send: the claim already carried the key (claimed BEFORE the provider call) and took no lease.
    expect(mockAtSend[0].idempotency_key).toBe(e3Key(KEY_1, TEXT));
    expect(mockAtSend[0].status).toBe('pending');
    for (const f of LEASE) {
      expect(Object.prototype.hasOwnProperty.call(mockAtSend[0], f)).toBe(true);
      expect(mockAtSend[0][f]).toBeNull();
    }
  });

  it('a retry with the same key performs no second connector call and answers already sent', async () => {
    await post(KEY_1);
    const retry = await post(KEY_1);
    expect(retry.statusCode).toBe(200);
    expect(retry.body).toMatchObject({ already_sent: true, deduplicated: true });
    expect(mockConnector).toHaveBeenCalledTimes(1);
    expect(actions()).toHaveLength(1);
  });

  it('CONTROL: a different key produces two rows and two connector calls', async () => {
    await post(KEY_1);
    const second = await post(KEY_2);
    expect(second.statusCode).toBe(200);
    expect(mockConnector).toHaveBeenCalledTimes(2);
    expect(actions()).toHaveLength(2);
    expect(actions().map((r) => r.idempotency_key).sort()).toEqual([e3Key(KEY_1, TEXT), e3Key(KEY_2, TEXT)].sort());
  });

  it('a pre-send refusal (kill switch) is reclaimed under the same key without setting any lease field; still one row', async () => {
    mockPolicy = { execution_enabled: false, auto_rules_enabled: true, require_human_approval: false };
    __resetCommunityAiPlatformPolicyCacheForTests();
    const refused = await post(KEY_1);
    expect(refused.statusCode).toBe(502);
    expect(refused.body.outcome).toBe('not_sent');
    expect(mockConnector).not.toHaveBeenCalled();
    expect(actions()[0]).toMatchObject({ status: 'skipped', skip_reason: 'PLATFORM_POLICY' });

    mockPolicy = { execution_enabled: true, auto_rules_enabled: true, require_human_approval: false };
    __resetCommunityAiPlatformPolicyCacheForTests();
    const retry = await post(KEY_1);
    expect(retry.statusCode).toBe(200);
    expect(mockConnector).toHaveBeenCalledTimes(1);
    expect(actions()).toHaveLength(1);
    expect(actions()[0].idempotency_key).toBe(e3Key(KEY_1, TEXT));
    expect(actions()[0].status).toBe('executed');
    // At the reclaimed send: pending again, lease fields untouched (NULL).
    expect(mockAtSend[0].status).toBe('pending');
    for (const f of LEASE) expect(mockAtSend[0][f] ?? null).toBeNull();
  });
});
