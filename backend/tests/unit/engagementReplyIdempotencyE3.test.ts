/**
 * E3 (Social Engagement, register row T-2) — stable reply idempotency for
 * POST /api/engagement/reply.
 *
 * Defect on main d9d047ae8: the route minted `actionId = crypto.randomUUID()`
 * and `idempotency_key: engagement-reply:${actionId}` per REQUEST, so a
 * retried submit (double click, lost response, network retry) created a second
 * community_ai_actions row and sent the reply twice. The executor's own
 * idempotency gate only stamps the key in persistExecutionResult — AFTER the
 * provider call — so it can never stop a second send.
 *
 * Harness: the route is REAL; the executor is a faithful double of the real
 * executeAction contract (auto_insert a pending row by id if absent → provider
 * "send" → persist the CHECK-faithful status + the caller's idempotency key,
 * with a post-send unique-index collision surfacing as deduplicated, exactly
 * like communityAiActionExecutorRuntime.ts). The in-memory community_ai_actions
 * table enforces Production's UNIQUE (organization_id, idempotency_key) WHERE
 * idempotency_key IS NOT NULL and answers a violation with SQLSTATE 23505.
 *
 * Every dedup / refusal assertion is paired with a control that DOES reach the
 * provider through the same harness, so a refusal cannot pass because the
 * harness never reached the executor.
 */

import { toPersistedCommunityActionStatus } from '../../services/communityAiPersistedStatus';
import { classifyReplySendResponse } from '../../../lib/engagement/replySendOutcome';

type Row = Record<string, any>;

// ── In-memory database ───────────────────────────────────────────────────────
const db: Record<string, Row[]> = {};
/** When > 0, that many idempotency-key lookups on community_ai_actions answer "no row" (a read that raced the winner's insert). */
let staleKeyLookups = 0;
/** Fault injection for the claim insert on community_ai_actions (one-shot). */
let claimInsertFault: null | 'commit-then-error' | 'commit-then-throw' | 'no-commit-error' | 'no-commit-throw' = null;
/** Per idempotency-key read, in order: 'ok' or 'fail' (a DB error). Empty = all ok. */
let keyReadPlan: Array<'ok' | 'fail'> = [];

const UNIQUE_VIOLATION = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "idx_community_ai_actions_org_idempotency_key"',
};

function keyCollides(table: string, candidate: Row, selfId?: unknown): boolean {
  if (table !== 'community_ai_actions') return false;
  if (candidate.idempotency_key == null) return false;
  return (db[table] ?? []).some((r) =>
    r.id !== selfId
    && r.organization_id === candidate.organization_id
    && r.idempotency_key != null
    && r.idempotency_key === candidate.idempotency_key);
}

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const filterCols: string[] = [];
  let patch: Row | null = null;
  let insertRow: Row | null = null;
  let limitN = Infinity;
  const rows = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));

  const runInsert = (): { data: Row | null; error: unknown } => {
    const row = insertRow as Row;
    if (table === 'community_ai_actions' && claimInsertFault) {
      const fault = claimInsertFault;
      claimInsertFault = null;
      if (fault === 'commit-then-error' || fault === 'commit-then-throw') (db[table] ??= []).push({ ...row }); // the commit happened
      // no-commit-throw: a transport timeout while the INSERT is still in flight — not visible to the re-read yet
      if (fault === 'commit-then-throw' || fault === 'no-commit-throw') throw new TypeError('fetch failed: socket hang up');
      return { data: null, error: { code: '08006', message: 'connection failure during commit acknowledgement' } };
    }
    if ((db[table] ?? []).some((r) => r.id != null && r.id === row.id) || keyCollides(table, row)) {
      return { data: null, error: UNIQUE_VIOLATION };
    }
    (db[table] ??= []).push({ ...row });
    return { data: { ...row }, error: null };
  };
  const runUpdate = (): { data: Row[]; error: unknown } => {
    const hits = rows();
    for (const r of hits) {
      if (keyCollides(table, { ...r, ...patch }, r.id)) return { data: [], error: UNIQUE_VIOLATION };
    }
    for (const r of hits) Object.assign(r, patch);
    return { data: hits.map((r) => ({ ...r })), error: null };
  };
  const runSelect = (): { data: Row[]; error: unknown } => {
    if (table === 'community_ai_actions' && filterCols.includes('idempotency_key') && keyReadPlan.length > 0) {
      if (keyReadPlan.shift() === 'fail') return { data: [], error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    }
    if (table === 'community_ai_actions' && filterCols.includes('idempotency_key') && staleKeyLookups > 0) {
      staleKeyLookups -= 1;
      return { data: [], error: null };
    }
    return { data: rows().slice(0, limitN).map((r) => ({ ...r })), error: null };
  };
  const exec = () => (insertRow ? (() => { const r = runInsert(); return { data: r.data ? [r.data] : [], error: r.error }; })() : patch ? runUpdate() : runSelect());

  const api: any = {
    select() { return api; },
    eq(c: string, v: unknown) { filterCols.push(c); filters.push((r) => r[c] === v); return api; },
    is(c: string, v: unknown) { filterCols.push(c); filters.push((r) => (r[c] ?? null) === v); return api; },
    in(c: string, v: unknown[]) { filterCols.push(c); filters.push((r) => v.includes(r[c])); return api; },
    or() { return api; },
    gte() { return api; },
    order() { return api; },
    limit(n: number) { limitN = n; return api; },
    update(p: Row) { patch = p; return api; },
    insert(row: Row) { insertRow = row; return api; },
    upsert(row: Row) { (db[table] ??= []).push({ ...row }); return Promise.resolve({ error: null }); },
    maybeSingle() { const r = exec(); return Promise.resolve({ data: r.data[0] ?? null, error: r.error ?? null }); },
    single() { const r = exec(); return Promise.resolve({ data: r.data[0] ?? null, error: r.error ?? null }); },
    then(ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) {
      const r = exec();
      return Promise.resolve({ data: r.data, error: r.error ?? null }).then(ok, ko);
    },
  };
  return api;
}

jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => builder(t) } }));
jest.mock('@/backend/db/supabaseClient', () => ({ supabase: { from: (t: string) => builder(t) } }));

// ── Route scaffolding ────────────────────────────────────────────────────────
const ORG_A = 'org_e3_a';
const ORG_B = 'org_e3_b';
const USER = 'user_e3';
let currentOrg = ORG_A;

jest.mock('@/lib/api/withContract', () => ({ withContract: (h: unknown) => h }));
jest.mock('../../../lib/api/withContract', () => ({ withContract: (h: unknown) => h }), { virtual: true });
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: async () => ({ userId: USER, defaultCompanyId: currentOrg }),
  enforceCompanyAccess: async () => ({ userId: USER }),
}));
jest.mock('../../services/rbacService', () => ({ enforceRole: async () => ({ userId: USER }) }));
jest.mock('../../services/rbac/communityAiCapabilities', () => ({
  COMMUNITY_AI_CAPABILITIES: { EXECUTE_ACTIONS: ['SUPER_ADMIN'], VIEW_ACTIONS: ['SUPER_ADMIN'] },
}));
jest.mock('../../services/responsePerformanceService', () => ({ recordReplyPerformance: async () => undefined }));
jest.mock('../../services/engagementOpportunityResolutionService', () => ({ resolveOpportunityByReply: async () => undefined }));
jest.mock('../../services/auditLoggingService', () => ({ logAuditEvent: async () => undefined }));
jest.mock('../../services/aiSuggestionTrackingService', () => ({ recordSuggestionAccepted: async () => undefined }));
jest.mock('../../services/engagementThreadEventService', () => ({ recordThreadEvent: async () => undefined }));
jest.mock('../../services/engagementThreadService', () => ({ isThreadActionable: async () => true }));
jest.mock('../../services/campaignOwnershipService', () => ({
  resolveCampaignOwnership: async () => ({ status: 'OWNED', companyId: currentOrg }),
}));
jest.mock('../../services/communityAiContactGovernanceGate', () => ({
  resolveEngagementAuthorIdentity: async () => ({ ok: true, value: null }),
  personIdentityMetadata: () => ({}),
}));

// ── Faithful executor double ─────────────────────────────────────────────────
type Scripted = Record<string, any>;
const scripted: Scripted[] = [];
let providerSends = 0;
let gate: Promise<void> | null = null;
const SEND_CLASS = (r: Scripted) =>
  r.status === 'executed' || r.status === 'sent_unverified' || r.reason === 'OUTCOME_UNKNOWN' || r.status === 'dispatched';

const executeActionMock = jest.fn(async (action: Row, _approved: boolean, opts: Row) => {
  const table = (db.community_ai_actions ??= []);
  // auto_insert: a minimal pending row for the action id if none exists (no key — the real auto_insert stamps none).
  if (opts?.persist && opts?.auto_insert && !table.some((r) => r.id === action.id)) {
    table.push({
      id: action.id, organization_id: action.organization_id, platform: action.platform,
      action_type: action.action_type, target_id: action.target_id, status: 'pending',
      execution_mode: action.execution_mode ?? null, idempotency_key: null, skip_reason: null,
    });
  }
  if (gate) await gate;
  const result: Scripted = scripted.length ? scripted.shift()! : { ok: true, status: 'executed', platform_id: 'urn:li:comment:native-1', execution_mode: 'api' };
  if (SEND_CLASS(result)) providerSends += 1;
  // persist (post-send) — same order as persistExecutionResult.
  const persisted = toPersistedCommunityActionStatus(result);
  const row = table.find((r) => r.id === action.id)!;
  const key = opts?.idempotency_key ?? null;
  if (key && table.some((r) => r.id !== row.id && r.organization_id === row.organization_id && r.idempotency_key === key)) {
    const prior = table.find((r) => r.id !== row.id && r.organization_id === row.organization_id && r.idempotency_key === key)!;
    return { ok: prior.status === 'executed', status: prior.status, deduplicated: true, prior_action_id: prior.id, correlation_id: 'corr' };
  }
  Object.assign(row, {
    status: persisted.status,
    skip_reason: persisted.skip_reason,
    idempotency_key: key,
    execution_result: { ...result, execution_mode: result.execution_mode ?? null },
    updated_at: new Date().toISOString(),
  });
  return { ...result, correlation_id: 'corr' };
});
jest.mock('../../services/communityAiActionExecutor', () => ({
  executeAction: (...a: unknown[]) => (executeActionMock as any)(...a),
}));

import replyHandler from '../../../pages/api/engagement/reply';

function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => res;
  return res;
}

const SHARED_TARGET = 'urn:li:share:7000000000000000001';
function seed(org: string, messageId: string, threadId: string) {
  (db.engagement_messages ??= []).push({
    organization_id: org, id: messageId, thread_id: threadId, platform: 'linkedin',
    platform_message_id: 'urn:li:comment:(urn:li:activity:1,42)', post_comment_id: null,
    message_type: 'comment', author_id: null, raw_payload: {},
  });
  (db.engagement_threads ??= []).push({ id: threadId, organization_id: org, platform_thread_id: SHARED_TARGET, raw_payload: {} });
}

const KEY_1 = '0b6f1c2e-6a0d-4f7a-9d55-3c2f1e9a7b01';
const KEY_2 = '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

async function post(body: Row, org = ORG_A) {
  currentOrg = org;
  const res = mockRes();
  await (replyHandler as any)({ method: 'POST', headers: {}, body: { message_id: 'mA', platform: 'linkedin', reply_text: 'Thanks for the comment!', ...body } }, res);
  return res;
}

const actionRows = (org?: string) => (db.community_ai_actions ?? []).filter((r) => !org || r.organization_id === org);

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  scripted.length = 0;
  providerSends = 0;
  staleKeyLookups = 0;
  claimInsertFault = null;
  keyReadPlan = [];
  gate = null;
  currentOrg = ORG_A;
  executeActionMock.mockClear();
  seed(ORG_A, 'mA', 'tA');
  seed(ORG_B, 'mB', 'tB');
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
describe('E3 §1 duplicate sequential submission', () => {
  it('same client key twice → one action row, one executeAction, one provider send; the retry reports already sent', async () => {
    const first = await post({ client_reply_key: KEY_1 });
    expect(first.statusCode).toBe(200);
    expect(first.body.status).toBe('executed');
    const second = await post({ client_reply_key: KEY_1 });
    expect(second.statusCode).toBe(200);
    expect(second.body).toMatchObject({ success: true, status: 'executed', deduplicated: true, already_sent: true });
    expect(second.body.action_id).toBe(first.body.action_id);
    expect(executeActionMock).toHaveBeenCalledTimes(1);
    expect(providerSends).toBe(1);
    expect(actionRows()).toHaveLength(1);
  });

  it('CONTROL: a different client key for the same text is a new logical reply → executes again', async () => {
    await post({ client_reply_key: KEY_1 });
    const second = await post({ client_reply_key: KEY_2 });
    expect(second.statusCode).toBe(200);
    expect(second.body.deduplicated).toBeUndefined();
    expect(executeActionMock).toHaveBeenCalledTimes(2);
    expect(providerSends).toBe(2);
    expect(actionRows()).toHaveLength(2);
  });

  it('no client key (legacy caller): identical text twice still dedups to one send (server-derived key)', async () => {
    await post({});
    const second = await post({});
    expect(second.statusCode).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(executeActionMock).toHaveBeenCalledTimes(1);
    expect(providerSends).toBe(1);
  });

  it('an invalid client key is refused 400 before any side effect; CONTROL: a valid key reaches the executor', async () => {
    const bad = await post({ client_reply_key: 'short key!' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.code).toBe('INVALID_CLIENT_REPLY_KEY');
    expect(executeActionMock).not.toHaveBeenCalled();
    expect(actionRows()).toHaveLength(0);
    const good = await post({ client_reply_key: KEY_1 });
    expect(good.statusCode).toBe(200);
    expect(executeActionMock).toHaveBeenCalledTimes(1);
  });
});

describe('E3 §2 concurrent submissions (unique-violation race)', () => {
  it('two simultaneous requests with the same key → one execution; the loser hits 23505, reads the winner and reports in progress', async () => {
    staleKeyLookups = 2; // both pre-checks miss: each request believes it is first
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const pA = post({ client_reply_key: KEY_1 });
    const pB = post({ client_reply_key: KEY_1 });
    // Let both reach the claim; the winner is parked inside the provider call.
    for (let i = 0; i < 50 && executeActionMock.mock.calls.length < 1; i += 1) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const settledB = await Promise.race([pB.then((r) => r), new Promise((r) => setTimeout(() => r(null), 200))]);
    release();
    const [a, b] = await Promise.all([pA, pB]);
    expect(settledB).not.toBeNull(); // the loser answered while the winner was still in flight
    expect(executeActionMock).toHaveBeenCalledTimes(1);
    expect(providerSends).toBe(1);
    expect(actionRows()).toHaveLength(1);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(409);
    expect(b.body.code).toBe('REPLY_IN_PROGRESS');
    expect(b.body.action_id).toBe(a.body.action_id);
    expect(String(b.body.error)).not.toMatch(/try again/i);
  });

  it('CONTROL: two simultaneous requests with different keys → two executions', async () => {
    staleKeyLookups = 2;
    const [a, b] = await Promise.all([post({ client_reply_key: KEY_1 }), post({ client_reply_key: KEY_2 })]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(executeActionMock).toHaveBeenCalledTimes(2);
    expect(providerSends).toBe(2);
  });
});

describe('E3 §3 lost response then retry with the same key', () => {
  it('the first response is lost after the send; the retry does not execute again and returns the stored state', async () => {
    await post({ client_reply_key: KEY_1 }); // response never reaches the client
    const retry = await post({ client_reply_key: KEY_1 });
    expect(executeActionMock).toHaveBeenCalledTimes(1);
    expect(providerSends).toBe(1);
    expect(retry.statusCode).toBe(200);
    expect(retry.body).toMatchObject({ status: 'executed', already_sent: true, confirmed: true, platform_id: 'urn:li:comment:native-1' });
  });

  it('a pending api row (request crashed mid-send) is never re-executed: in progress / outcome unknown', async () => {
    gate = new Promise<void>(() => undefined); // the first request never returns from the provider call
    void post({ client_reply_key: KEY_1 });
    for (let i = 0; i < 50 && executeActionMock.mock.calls.length < 1; i += 1) await new Promise((r) => setImmediate(r));
    gate = null;
    const retry = await post({ client_reply_key: KEY_1 });
    expect(retry.statusCode).toBe(409);
    expect(retry.body.code).toBe('REPLY_IN_PROGRESS');
    expect(retry.body.outcome).toBe('unknown');
    expect(executeActionMock).toHaveBeenCalledTimes(1);
  });
});

describe('E3 §4 unknown outcome → never resend', () => {
  it.each([
    ['OUTCOME_UNKNOWN', { ok: false, status: 'skipped', reason: 'OUTCOME_UNKNOWN', error: { code: 'OUTCOME_UNKNOWN' }, execution_mode: 'rpa' }],
    ['sent_unverified', { ok: true, status: 'sent_unverified', platform_id: null, execution_mode: 'api' }],
  ])('%s: the fresh answer is "outcome unknown" (not "failed, try again") and a retry does not resend', async (_n, result) => {
    scripted.push(result);
    const first = await post({ client_reply_key: KEY_1 });
    expect(first.statusCode).toBe(409);
    expect(first.body.code).toBe('REPLY_OUTCOME_UNKNOWN');
    expect(first.body.outcome).toBe('unknown');
    expect(first.body.retryable).toBe(false);
    expect(String(first.body.error)).toMatch(/unknown/i);
    expect(String(first.body.error)).not.toMatch(/try again/i);
    const retry = await post({ client_reply_key: KEY_1 });
    expect(retry.statusCode).toBe(409);
    expect(retry.body.code).toBe('REPLY_OUTCOME_UNKNOWN');
    expect(executeActionMock).toHaveBeenCalledTimes(1);
    expect(providerSends).toBe(1);
  });

  it('an executor persist failure after the provider call is reported as outcome unknown, never as failed', async () => {
    executeActionMock.mockImplementationOnce(async () => {
      providerSends += 1;
      return { ok: false, status: 'failed', error: 'PERSIST_FAILED', execution_mode: 'api', response: { persist_error: 'PERSIST_FAILED' } } as any;
    });
    const first = await post({ client_reply_key: KEY_1 });
    expect(first.statusCode).toBe(409);
    expect(first.body.code).toBe('REPLY_OUTCOME_UNKNOWN');
    const retry = await post({ client_reply_key: KEY_1 });
    expect(retry.body.outcome).toBe('unknown');
    expect(providerSends).toBe(1);
  });
});

describe('E3 §5 confirmed-not-sent failure', () => {
  it('a pre-send refusal (governance store unavailable) may re-execute with the same key, on the SAME row', async () => {
    scripted.push({ ok: false, status: 'skipped', reason: 'CONTACT_GOVERNANCE_UNAVAILABLE', error: { code: 'CONTACT_GOVERNANCE_UNAVAILABLE' } });
    const first = await post({ client_reply_key: KEY_1 });
    expect(first.statusCode).toBe(503);
    expect(first.body.retryable).toBe(true);
    const retry = await post({ client_reply_key: KEY_1 });
    expect(retry.statusCode).toBe(200);
    expect(retry.body.status).toBe('executed');
    expect(executeActionMock).toHaveBeenCalledTimes(2);
    expect(providerSends).toBe(1);
    expect(actionRows()).toHaveLength(1);
    expect(actionRows()[0].status).toBe('executed');
  });

  it('a user-cancelled never-claimed queue row is confirmed not sent → the same key may re-execute', async () => {
    const first = await post({ client_reply_key: KEY_1 });
    const row = actionRows()[0];
    Object.assign(row, { status: 'failed', execution_result: { source: 'user', reason: 'user_cancelled' } });
    const retry = await post({ client_reply_key: KEY_1 });
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(executeActionMock).toHaveBeenCalledTimes(2);
    expect(actionRows()).toHaveLength(1);
  });

  it('PAIRED: a failure that may have reached the platform (extension-reported failure) is NOT re-executed', async () => {
    await post({ client_reply_key: KEY_1 });
    const row = actionRows()[0];
    Object.assign(row, { status: 'failed', execution_mode: 'browser', execution_result: { ok: false, status: 'failed', error: 'SEND_BUTTON_TIMEOUT', execution_mode: 'browser' } });
    const retry = await post({ client_reply_key: KEY_1 });
    expect(retry.statusCode).toBe(409);
    expect(retry.body.code).toBe('REPLY_PRIOR_ATTEMPT_FAILED');
    expect(retry.body.retryable).toBe(false);
    expect(String(retry.body.error)).not.toMatch(/try again/i);
    expect(executeActionMock).toHaveBeenCalledTimes(1);
  });

  it('only one of two concurrent retries of a pre-send failure re-executes (CAS on the reclaim)', async () => {
    scripted.push({ ok: false, status: 'skipped', reason: 'PLATFORM_POLICY' });
    await post({ client_reply_key: KEY_1 });
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const pA = post({ client_reply_key: KEY_1 });
    const pB = post({ client_reply_key: KEY_1 });
    for (let i = 0; i < 50 && executeActionMock.mock.calls.length < 2; i += 1) await new Promise((r) => setImmediate(r));
    release();
    const results = await Promise.all([pA, pB]);
    expect(executeActionMock).toHaveBeenCalledTimes(2); // first refusal + exactly one reclaim
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });
});

describe('E3 §6 company scoping', () => {
  it('two companies, same client key, same external target → two independent actions', async () => {
    const a = await post({ client_reply_key: KEY_1, message_id: 'mA' }, ORG_A);
    const b = await post({ client_reply_key: KEY_1, message_id: 'mB' }, ORG_B);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.body.deduplicated).toBeUndefined();
    expect(executeActionMock).toHaveBeenCalledTimes(2);
    expect(actionRows(ORG_A)).toHaveLength(1);
    expect(actionRows(ORG_B)).toHaveLength(1);
    expect(actionRows(ORG_A)[0].idempotency_key).not.toBe(actionRows(ORG_B)[0].idempotency_key);
    expect(b.body.action_id).not.toBe(a.body.action_id);
  });
});

describe('E3 §6b company B can never read company A action through the dedup path', () => {
  // The key formula, pinned independently of the implementation: sha256 over the JSON tuple.
  const { createHash } = require('crypto') as typeof import('crypto');
  const h = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
  const keyFor = (org: string, messageId: string, clientKey: string, text: string) =>
    'engagement-reply:v1:' + h(JSON.stringify([org, `message:${messageId}`, 'linkedin', 'reply', clientKey, h(text.replace(/\s+/g, ' ').trim())]));

  const seedExecuted = (owner: string, key: string) => {
    (db.community_ai_actions ??= []).push({
      id: `seeded-${owner}`, organization_id: owner, platform: 'linkedin', action_type: 'reply', status: 'executed',
      idempotency_key: key, skip_reason: null, execution_mode: 'api',
      execution_result: { status: 'executed', platform_id: `urn:li:comment:SECRET-${owner}`, execution_mode: 'api' },
    });
  };

  it('a company-A row carrying EXACTLY the key company B derives is invisible to B: B executes its own reply', async () => {
    seedExecuted(ORG_A, keyFor(ORG_B, 'mB', KEY_1, 'Thanks for the comment!'));
    const b = await post({ client_reply_key: KEY_1, message_id: 'mB' }, ORG_B);
    expect(b.statusCode).toBe(200);
    expect(b.body.action_id).not.toBe(`seeded-${ORG_A}`);
    expect(JSON.stringify(b.body)).not.toContain(`SECRET-${ORG_A}`);
    expect(executeActionMock).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: the same row owned by company B IS found → deduplicated, no execution (proves the key formula and the read)', async () => {
    seedExecuted(ORG_B, keyFor(ORG_B, 'mB', KEY_1, 'Thanks for the comment!'));
    const b = await post({ client_reply_key: KEY_1, message_id: 'mB' }, ORG_B);
    expect(b.statusCode).toBe(200);
    expect(b.body).toMatchObject({ deduplicated: true, already_sent: true, action_id: `seeded-${ORG_B}` });
    expect(executeActionMock).not.toHaveBeenCalled();
  });
});

describe('E3 §4b outcome-unknown copy by execution mode (row left pending)', () => {
  const seedDm = () => {
    db.engagement_messages.push({
      organization_id: ORG_A, id: 'mDm', thread_id: 'tDm', platform: 'linkedin',
      platform_message_id: 'dm-msg-1', post_comment_id: null, message_type: 'dm', author_id: null,
      raw_payload: { sender_name: 'Ana Lima' },
    });
    db.engagement_threads.push({ id: 'tDm', organization_id: ORG_A, platform_thread_id: '2-AbCdEfGhIjKlMnOp', raw_payload: { participant_name: 'Ana Lima' } });
  };
  const throwOnce = () => executeActionMock.mockImplementationOnce(async () => { throw new Error('socket hang up'); });

  it('browser (LinkedIn DM): says it may still be delivered by the extension and not to resend — on the first answer and on the retry', async () => {
    seedDm();
    throwOnce();
    const first = await post({ client_reply_key: KEY_1, message_id: 'mDm' });
    expect(first.statusCode).toBe(409);
    expect(first.body.code).toBe('REPLY_OUTCOME_UNKNOWN');
    expect(first.body.execution_mode).toBe('browser');
    const retry = await post({ client_reply_key: KEY_1, message_id: 'mDm' });
    expect(retry.statusCode).toBe(409);
    expect(retry.body.code).toBe('REPLY_IN_PROGRESS');
    for (const r of [first, retry]) {
      const text = String(r.body.error);
      expect(text).toMatch(/^Sending status unknown/);
      expect(text).toMatch(/may still be delivered/i);
      expect(text).toMatch(/do not resend/i);
      expect(text).not.toMatch(/not sent again|was not sent|will not be delivered|try again/i);
    }
    expect(executeActionMock).toHaveBeenCalledTimes(1);
  });

  it('CONTROL api (comment): the api copy, which does not mention the extension', async () => {
    throwOnce();
    const first = await post({ client_reply_key: KEY_1 });
    const retry = await post({ client_reply_key: KEY_1 });
    expect(first.body.code).toBe('REPLY_OUTCOME_UNKNOWN');
    expect(retry.body.code).toBe('REPLY_IN_PROGRESS');
    for (const r of [first, retry]) {
      const text = String(r.body.error);
      expect(text).toMatch(/^(Sending status unknown|This reply is already being sent)/);
      expect(text).not.toMatch(/extension|may still be delivered/i);
      expect(text).not.toMatch(/try again/i);
    }
    expect(executeActionMock).toHaveBeenCalledTimes(1);
  });
});

describe('E3 §7 edited text is a new logical reply', () => {
  it('same key, edited text → a new action and a new execution', async () => {
    await post({ client_reply_key: KEY_1, reply_text: 'Thanks for the comment!' });
    const edited = await post({ client_reply_key: KEY_1, reply_text: 'Thanks for the thoughtful comment!' });
    expect(edited.statusCode).toBe(200);
    expect(edited.body.deduplicated).toBeUndefined();
    expect(executeActionMock).toHaveBeenCalledTimes(2);
    expect(actionRows()).toHaveLength(2);
  });

  it('PAIRED: a whitespace-only difference is the SAME logical reply → deduplicated', async () => {
    await post({ client_reply_key: KEY_1, reply_text: 'Thanks for the comment!' });
    const same = await post({ client_reply_key: KEY_1, reply_text: '  Thanks   for the\ncomment!  ' });
    expect(same.statusCode).toBe(200);
    expect(same.body.deduplicated).toBe(true);
    expect(executeActionMock).toHaveBeenCalledTimes(1);
  });
});

describe('E3 claim write with a lost DB response', () => {
  const keepsKey = (r: any) => classifyReplySendResponse({ httpStatus: r.statusCode, json: r.body, platform: 'linkedin' }).kind === 'unknown';

  it.each([
    ['the insert returns an error after committing', 'commit-then-error'],
    ['the insert throws after committing', 'commit-then-throw'],
  ] as const)('%s: the row exists → answered in progress, never executed, the client keeps its key', async (_n, fault) => {
    claimInsertFault = fault;
    const first = await post({ client_reply_key: KEY_1 });
    expect(first.statusCode).toBe(409);
    expect(first.body.code).toBe('REPLY_IN_PROGRESS');
    expect(first.body.retryable).toBe(false);
    expect(keepsKey(first)).toBe(true);
    expect(executeActionMock).not.toHaveBeenCalled();
    expect(actionRows()).toHaveLength(1);
    const retry = await post({ client_reply_key: KEY_1 });
    expect(retry.statusCode).toBe(409);
    expect(retry.body.code).toBe('REPLY_IN_PROGRESS');
    expect(executeActionMock).not.toHaveBeenCalled();
    expect(actionRows()).toHaveLength(1);
  });

  it('the insert errors after committing AND the re-read fails → 409 REPLY_OUTCOME_UNKNOWN, not retryable, never executed', async () => {
    claimInsertFault = 'commit-then-error';
    keyReadPlan = ['ok', 'fail']; // the pre-check reads fine; the post-failure re-read fails
    const first = await post({ client_reply_key: KEY_1 });
    expect(first.statusCode).toBe(409);
    expect(first.body.code).toBe('REPLY_OUTCOME_UNKNOWN');
    expect(first.body.retryable).toBe(false);
    expect(String(first.body.error)).toMatch(/^Sending status unknown/);
    expect(keepsKey(first)).toBe(true);
    expect(executeActionMock).not.toHaveBeenCalled();
  });

  it('a THROWN insert whose row is not (yet) visible to the re-read → 409 REPLY_OUTCOME_UNKNOWN, not retryable, never executed', async () => {
    claimInsertFault = 'no-commit-throw';
    const first = await post({ client_reply_key: KEY_1 });
    expect(first.statusCode).toBe(409);
    expect(first.body.code).toBe('REPLY_OUTCOME_UNKNOWN');
    expect(first.body.retryable).toBe(false);
    expect(String(first.body.error)).toMatch(/^Sending status unknown/);
    expect(keepsKey(first)).toBe(true);
    expect(executeActionMock).not.toHaveBeenCalled();
  });

  it('CONTROL: the DB RETURNS a non-23505 error (no commit) and the re-read confirms no row → retryable 503; the retry then sends once', async () => {
    claimInsertFault = 'no-commit-error';
    const first = await post({ client_reply_key: KEY_1 });
    expect(first.statusCode).toBe(503);
    expect(first.body.code).toBe('REPLY_CLAIM_FAILED');
    expect(first.body.retryable).toBe(true);
    expect(actionRows()).toHaveLength(0);
    expect(executeActionMock).not.toHaveBeenCalled();
    const retry = await post({ client_reply_key: KEY_1 });
    expect(retry.statusCode).toBe(200);
    expect(executeActionMock).toHaveBeenCalledTimes(1);
    expect(actionRows()).toHaveLength(1);
  });
});
