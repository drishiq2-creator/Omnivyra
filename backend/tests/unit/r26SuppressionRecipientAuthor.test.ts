/**
 * Round 26 — suppression corrections on the community path (review CT-ROUND26-SUPPRESSION-REVIEW S-1..S-4).
 *
 * S-1  an inbox DM is checked against the RECIPIENT's profile identity, not only its thread URL;
 * S-2  a reply is checked against the AUTHOR of the comment/post replied to, not only the comment/post id;
 *      an unidentifiable recipient/author fails CLOSED (terminal for automated sends, a reason code for manual);
 * S-3  the RPA retry flush re-checks contact governance on the row of record and retires a suppressed retry;
 * S-4  pages/api/social/comments.ts direct reply asks the same gate before any platform call.
 *
 * The ONE suppression engine (`isSuppressed` → canonical `contact_governance_records`, then legacy) is REAL; only
 * the table layer is an in-memory double that honours eq / in / is filters, so tenant scoping is exercised as shipped.
 *
 * Failing controls at 32c2b0b63 (the reviewed branch): every "suppressed recipient/author" and "unresolvable" case
 * is ALLOWED there (the gate only saw the thread URL / comment URN), the RPA retry is authorised, a terminal refusal
 * is retried, and the direct reply sends.
 */
type Row = Record<string, any>;
type Filter = [kind: string, column: string, value: unknown];

const db = {
  tables: {} as Record<string, Row[]>,
  failures: {} as Record<string, { code: string; message: string }>,
  queries: [] as Array<{ table: string; op: string; filters: Filter[]; payload: Row | null }>,
};

/**
 * SCHEMA-FAITHFUL community_ai_actions (integration review H-2): the PRODUCTION column list (no `metadata`) and
 * community_ai_actions_status_check (pending | approved | executed | failed | skipped — NO 'blocked'), from the
 * prod schema dump closure-r6/e2e-refresh/prod-public-schema.sql, CT-verified 2026-11-27. A write naming another
 * column (42703) or another status (23514) is rejected and changes nothing, exactly as Postgres would.
 */
const PROD_ACTION_COLUMNS = new Set(('id tenant_id organization_id platform action_type target_id suggested_text tone risk_level ' +
  'requires_human_approval status execution_result created_at updated_at scheduled_at tone_used requires_approval final_text ' +
  'execution_mode playbook_id playbook_name intent_classification discovered_user_id executed_at skip_reason ' +
  'execution_correlation_id approved_at dispatch_lease_id dispatch_lease_expires_at dispatch_lease_holder_id ' +
  'dispatch_acknowledged_at idempotency_key command_chain command_chain_index cancel_requested_at acting_user_id').split(' '));
const PROD_ACTION_STATUSES = new Set(['pending', 'approved', 'executed', 'failed', 'skipped']);
function actionSchemaViolation(payload: Row | null): { code: string; message: string } | null {
  if (!payload) return null;
  const unknown = Object.keys(payload).filter((c) => !PROD_ACTION_COLUMNS.has(c));
  if (unknown.length) return { code: '42703', message: `column "${unknown[0]}" of relation "community_ai_actions" does not exist` };
  if ('status' in payload && !PROD_ACTION_STATUSES.has(String(payload.status))) {
    return { code: '23514', message: 'new row violates check constraint "community_ai_actions_status_check"' };
  }
  return null;
}

function fakeTable(table: string) {
  const st = { op: 'select', filters: [] as Filter[], payload: null as Row | null };
  const match = (r: Row): boolean =>
    st.filters.every(([kind, col, val]) => {
      if (kind === 'eq') return r[col] === val;
      if (kind === 'is') return (r[col] ?? null) === val;
      if (kind === 'in') return Array.isArray(val) && (val as unknown[]).includes(r[col] ?? null);
      return true;
    });
  const exec = async (mode: 'many' | 'maybe') => {
    await Promise.resolve();
    db.queries.push({ table, op: st.op, filters: st.filters, payload: st.payload });
    const failure = db.failures[table];
    if (failure) return { data: null, error: failure };
    if (table === 'community_ai_actions' && (st.op === 'insert' || st.op === 'update')) {
      const violation = actionSchemaViolation(st.payload);
      if (violation) return { data: null, error: violation };
    }
    if (st.op === 'insert') return { data: null, error: null };
    if (st.op === 'update') {
      const hit = (db.tables[table] ?? []).filter(match);
      hit.forEach((r) => Object.assign(r, st.payload));
      return mode === 'many' ? { data: hit, error: null } : { data: hit[0] ?? null, error: null };
    }
    const found = (db.tables[table] ?? []).filter(match);
    return mode === 'many' ? { data: found, error: null } : { data: found[0] ?? null, error: null };
  };
  const b: any = {
    select: () => b,
    insert: (p: Row) => { st.op = 'insert'; st.payload = p; return b; },
    update: (p: Row) => { st.op = 'update'; st.payload = p; return b; },
    delete: () => { st.op = 'delete'; return b; },
    eq: (c: string, v: unknown) => { st.filters.push(['eq', c, v]); return b; },
    is: (c: string, v: unknown) => { st.filters.push(['is', c, v]); return b; },
    in: (c: string, v: unknown) => { st.filters.push(['in', c, v]); return b; },
    lte: () => b, lt: () => b, gte: () => b, not: () => b, or: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: () => exec('maybe'),
    single: () => exec('maybe'),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec('many').then(res, rej),
  };
  return b;
}

jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => fakeTable(t) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => fakeTable(t) } }));

jest.mock('../../services/communityAiPlatformPolicyService', () => ({
  getCommunityAiPlatformPolicy: jest.fn(async () => ({ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false })),
}));
jest.mock('../../services/communityAiActionExecutorContracts', () => {
  const actual = jest.requireActual('../../services/communityAiActionExecutorContracts');
  return {
    ...actual,
    recordExecutionMetric: jest.fn(async () => undefined),
    resolveExecutionMode: jest.fn(async (a: any) => a.execution_mode || 'api'),
    loadHistoryMetrics: jest.fn(async () => null),
    runApiExecution: jest.fn(async () => ({ ok: true, status: 'executed' })),
    runRpaExecution: jest.fn(async () => ({ ok: true, status: 'executed' })),
    prepareBrowserDispatch: jest.fn(() => ({ ok: true, status: 'dispatched' })),
  };
});
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
jest.mock('../../services/playbooks/playbookService', () => ({ getPlaybookById: jest.fn(async () => ({ id: 'pb-1', name: 'Engage', status: 'active' })) }));
jest.mock('../../services/playbooks/playbookValidator', () => ({ validateActionAgainstPlaybook: jest.fn(() => ({ allowed: true })) }));
jest.mock('../../services/usageEnforcementService', () => ({ checkUsageBeforeExecution: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageMeterService', () => ({ incrementUsageMeter: jest.fn(async () => undefined) }));
jest.mock('../../services/platformTokenService', () => ({ getToken: jest.fn(async () => null) }));
jest.mock('../../services/telemetry/telemetryDispatcher', () => ({ trackEvent: jest.fn() }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/supabaseAuthService', () => ({ getSupabaseUserFromRequest: async () => ({ user: { id: 'user-1' }, error: null }) }));
jest.mock('../../services/userContextService', () => ({ enforceCompanyAccess: async () => ({ userId: 'user-1' }) }));
jest.mock('../../services/engagementIngestionService', () => ({ ingestComments: async () => ({ ingested: 0 }), getCommentsForScheduledPost: async () => [] }));
// The RPA worker's own heavy deps (its gate is what is under test, not Playwright).
jest.mock('../../services/rpaWorker/rpaPlaywrightRunner', () => ({ runRpaScript: jest.fn(async () => ({ success: true })) }));
jest.mock('../../services/rpaWorker/rpaEnv', () => ({ rpaEnvReady: jest.fn(async () => ({ ok: true })), assertRpaEnvReady: jest.fn(), isProbeFailure: () => false }));
jest.mock('../../queue/bullmqClient', () => ({ withHeavyJobSlot: (fn: () => unknown) => fn() }));

import type { NextApiRequest, NextApiResponse } from 'next';
import { executeAction } from '../../services/communityAiActionExecutorRuntime';
import { runApiExecution, runRpaExecution, prepareBrowserDispatch } from '../../services/communityAiActionExecutorContracts';
import { checkCommunityActionContactGovernance } from '../../services/communityAiContactGovernanceGate';
import { checkRpaRetryAuthorised } from '../../services/rpaWorker/rpaWorkerService';
import { flushRpaRetryQueueForOrg } from '../../services/rpaWorker/rpaRetryQueue';
import { persistExecutionResult as persistResultForHandout } from '../../services/communityAiExecutionResultService';
import { linkedInCommentIdCandidates } from '../../services/communityAiContactGovernanceGate';
import commentsRoute from '../../../pages/api/social/comments';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const PERSON = 'https://www.linkedin.com/in/jane-doe';
const CLEAN_PERSON = 'https://www.linkedin.com/in/clean-person';
const THREAD_URL = 'https://www.linkedin.com/messaging/thread/2-abc/';
const COMMENT = 'urn:li:comment:(urn:li:activity:1,123)';

const govRow = (over: Row = {}): Row => ({
  id: `g-${Math.random()}`, organization_id: ORG_A, person_id: null, target_normalized: PERSON,
  channel: 'linkedin', governance_type: 'dnc_channel',
  effective_from: '2026-01-01T00:00:00.000Z', effective_until: null, revoked_at: null, purpose_scope: null,
  ...over,
});
const suppress = (over: Row = {}) => { db.tables.contact_governance_records.push(govRow(over)); };

/** An engagement comment (or DM thread message) authored by `profile` in `org`. */
function seedAuthor(org: string, profile: string, opts: { platformMessageId?: string; platformThreadId?: string } = {}) {
  const authorId = `author-${db.tables.engagement_authors.length + 1}`;
  db.tables.engagement_authors.push({ id: authorId, profile_url: profile, platform_user_id: null });
  let threadId: string | null = null;
  if (opts.platformThreadId) {
    threadId = `thread-${db.tables.engagement_threads.length + 1}`;
    db.tables.engagement_threads.push({ id: threadId, organization_id: org, platform_thread_id: opts.platformThreadId });
  }
  db.tables.engagement_messages.push({
    id: `msg-${db.tables.engagement_messages.length + 1}`, organization_id: org, thread_id: threadId,
    platform_message_id: opts.platformMessageId ?? null, author_id: authorId, raw_payload: {}, created_at: '2026-11-20T00:00:00Z',
  });
}

const action = (over: Row = {}): any => ({
  id: 'act-1', tenant_id: ORG_A, organization_id: ORG_A, platform: 'linkedin', action_type: 'reply',
  target_id: COMMENT, suggested_text: 'Thanks', playbook_id: 'pb-1', execution_mode: 'api',
  requires_human_approval: false, risk_level: 'low', ...over,
});
const sideEffects = () =>
  (runApiExecution as jest.Mock).mock.calls.length +
  (runRpaExecution as jest.Mock).mock.calls.length +
  (prepareBrowserDispatch as jest.Mock).mock.calls.length;

const fetchSpy = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 'li-reply' }) }));
const ORIGINAL_FETCH = global.fetch;
beforeAll(() => { (global as any).fetch = fetchSpy; });
afterAll(() => { (global as any).fetch = ORIGINAL_FETCH; });

beforeEach(() => {
  jest.clearAllMocks();
  db.tables = {
    contact_governance_records: [], suppression_entries: [], identity_claims: [],
    engagement_messages: [], engagement_threads: [], engagement_authors: [],
    community_ai_actions: [], rpa_retry_queue: [], social_accounts: [],
  };
  db.failures = {};
  db.queries = [];
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ════════════════════════════════════════════════════════════════════════════
describe('S-1: inbox DM is checked against the RECIPIENT, not the thread URL', () => {
  it('a suppressed recipient profile stamped on the DM blocks it although the thread URL is clean', async () => {
    suppress();
    const g = await checkCommunityActionContactGovernance({
      organization_id: ORG_A, platform: 'linkedin', action_type: 'dm', target_id: THREAD_URL,
      metadata: { dm_thread_url: THREAD_URL, recipient_profile_url: PERSON },
    });
    expect(g).toMatchObject({ allowed: false, code: 'CONTACT_SUPPRESSED', identifierKind: 'recipient_profile_url' });
  });

  it('HAND-OUT shape (no metadata column): the recipient is resolved from the DM thread author and is blocked', async () => {
    suppress();
    seedAuthor(ORG_A, PERSON, { platformThreadId: '2-abc' });
    const g = await checkCommunityActionContactGovernance({
      id: 'act-dm', organization_id: ORG_A, platform: 'linkedin', action_type: 'dm', target_id: THREAD_URL, metadata: null,
    });
    expect(g).toMatchObject({ allowed: false, code: 'CONTACT_SUPPRESSED', identifierKind: 'recipient_profile_url' });
  });

  it('CONTROL: the same DM to a recipient with no restriction is allowed', async () => {
    suppress();
    seedAuthor(ORG_A, CLEAN_PERSON, { platformThreadId: '2-abc' });
    const g = await checkCommunityActionContactGovernance({
      organization_id: ORG_A, platform: 'linkedin', action_type: 'dm', target_id: THREAD_URL, metadata: null,
    });
    expect(g).toMatchObject({ allowed: true });
  });
});

describe('S-2: a reply is checked against the AUTHOR of the comment replied to', () => {
  it('executor (automated scheduler path): suppressed author → terminal blocked, no side effect', async () => {
    suppress();
    seedAuthor(ORG_A, PERSON, { platformMessageId: COMMENT });
    const r = await executeAction(action({ approved_at: '2026-11-01T00:00:00Z' }), true, { source: 'scheduler' });
    expect(r).toMatchObject({ ok: false, status: 'skipped', reason: 'CONTACT_SUPPRESSED' });
    expect(sideEffects()).toBe(0);
  });

  it('a stamped author_profile_url is checked even when the comment is not in the engagement store', async () => {
    suppress();
    const g = await checkCommunityActionContactGovernance({
      organization_id: ORG_A, platform: 'linkedin', action_type: 'reply', target_id: COMMENT, metadata: { author_profile_url: PERSON },
    });
    expect(g).toMatchObject({ allowed: false, code: 'CONTACT_SUPPRESSED', identifierKind: 'author_profile_url' });
  });

  it('CONTROL: a reply to a comment by an unrestricted author proceeds', async () => {
    suppress();
    seedAuthor(ORG_A, CLEAN_PERSON, { platformMessageId: COMMENT });
    const r = await executeAction(action(), true, { source: 'manual' });
    expect(r.ok).toBe(true);
    expect(sideEffects()).toBe(1);
  });
});

describe('unresolvable identity fails CLOSED', () => {
  it.each(['scheduler', 'auto', 'manual'])('%s: a reply whose author cannot be resolved is blocked (CONTACT_IDENTITY_UNRESOLVED), no side effect', async (source) => {
    const r = await executeAction(action({ approved_at: '2026-11-01T00:00:00Z' }), true, { source: source as any });
    expect(r).toMatchObject({ ok: false, status: 'skipped', reason: 'CONTACT_IDENTITY_UNRESOLVED' });
    expect((r as any).error).toMatchObject({ code: 'CONTACT_IDENTITY_UNRESOLVED', reason: 'reply_author_unresolved' });
    expect(sideEffects()).toBe(0);
  });

  it('a DM whose recipient cannot be resolved is refused with dm_recipient_unresolved', async () => {
    const g = await checkCommunityActionContactGovernance({ organization_id: ORG_A, platform: 'linkedin', action_type: 'dm', target_id: THREAD_URL });
    expect(g).toMatchObject({ allowed: false, code: 'CONTACT_IDENTITY_UNRESOLVED', reason: 'dm_recipient_unresolved' });
  });

  it('an unreadable engagement store is UNAVAILABLE (transient, fail-closed), never an allow', async () => {
    db.failures.engagement_messages = { code: '42501', message: 'permission denied' };
    const r = await executeAction(action(), true, { source: 'manual' });
    expect(r).toMatchObject({ ok: false, status: 'skipped', reason: 'CONTACT_GOVERNANCE_UNAVAILABLE' });
    expect(sideEffects()).toBe(0);
  });

  it('CONTROL: a follow targets a profile, which IS the identity (no lookup needed)', async () => {
    const r = await executeAction(action({ action_type: 'follow', target_id: CLEAN_PERSON }), true, { source: 'manual' });
    expect(r.ok).toBe(true);
  });
});

describe('tenant isolation', () => {
  it("tenant B's suppression and tenant B's comment author are invisible to tenant A", async () => {
    suppress({ organization_id: ORG_B });
    seedAuthor(ORG_B, PERSON, { platformMessageId: COMMENT });
    const g = await checkCommunityActionContactGovernance({ organization_id: ORG_A, platform: 'linkedin', action_type: 'reply', target_id: COMMENT });
    // tenant A cannot see B's engagement row, so A's reply author is UNRESOLVED (refused) — never resolved through B
    expect(g).toMatchObject({ allowed: false, code: 'CONTACT_IDENTITY_UNRESOLVED' });
    const engagementReads = db.queries.filter((q) => q.table === 'engagement_messages');
    expect(engagementReads.length).toBeGreaterThan(0);
    for (const q of engagementReads) expect(q.filters).toContainEqual(['eq', 'organization_id', ORG_A]);
  });

  it("tenant A's own author with only a tenant-B suppression is allowed (B's rule does not leak into A)", async () => {
    suppress({ organization_id: ORG_B });
    seedAuthor(ORG_A, PERSON, { platformMessageId: COMMENT });
    const g = await checkCommunityActionContactGovernance({ organization_id: ORG_A, platform: 'linkedin', action_type: 'reply', target_id: COMMENT });
    expect(g).toMatchObject({ allowed: true });
  });

  it('CONTROL: the same suppression in tenant A blocks the reply via its author', async () => {
    suppress({ organization_id: ORG_A });
    seedAuthor(ORG_A, PERSON, { platformMessageId: COMMENT });
    const g = await checkCommunityActionContactGovernance({ organization_id: ORG_A, platform: 'linkedin', action_type: 'reply', target_id: COMMENT });
    expect(g).toMatchObject({ allowed: false, code: 'CONTACT_SUPPRESSED' });
  });
});

describe('S-3: RPA retry flush re-checks contact governance', () => {
  const retryTask = { tenant_id: ORG_A, organization_id: ORG_A, platform: 'linkedin', action_type: 'reply' as const, target_url: 'https://www.linkedin.com/feed/update/x', text: 'hi', action_id: 'act-r' };
  const rowOfRecord = () => ({ id: 'act-r', organization_id: ORG_A, status: 'failed', approved_at: '2026-11-01T00:00:00Z', platform: 'linkedin', action_type: 'reply', target_id: COMMENT });

  it('suppressed author → refused, TERMINAL (RPA_RETRY_CONTACT_SUPPRESSED)', async () => {
    suppress();
    seedAuthor(ORG_A, PERSON, { platformMessageId: COMMENT });
    db.tables.community_ai_actions.push(rowOfRecord());
    await expect(checkRpaRetryAuthorised(retryTask)).resolves.toEqual({ ok: false, reason: 'RPA_RETRY_CONTACT_SUPPRESSED', terminal: true });
  });

  it('unresolvable author → refused, TERMINAL (RPA_RETRY_CONTACT_IDENTITY_UNRESOLVED)', async () => {
    db.tables.community_ai_actions.push(rowOfRecord());
    await expect(checkRpaRetryAuthorised(retryTask)).resolves.toEqual({ ok: false, reason: 'RPA_RETRY_CONTACT_IDENTITY_UNRESOLVED', terminal: true });
  });

  it('CONTROL: an unrestricted author is authorised', async () => {
    seedAuthor(ORG_A, CLEAN_PERSON, { platformMessageId: COMMENT });
    db.tables.community_ai_actions.push(rowOfRecord());
    await expect(checkRpaRetryAuthorised(retryTask)).resolves.toEqual({ ok: true });
  });

  it('a terminal refusal retires the retry row at once (attempts = max, no next_retry_at); CONTROL: a non-terminal one backs off', async () => {
    db.tables.rpa_retry_queue = [{ id: 'q1', action_id: 'act-r', organization_id: ORG_A, platform: 'linkedin', action_type: 'reply', target_url: 'u', text: 't', attempts: 1, max_attempts: 5 }];
    await flushRpaRetryQueueForOrg({ organization_id: ORG_A, handler: async () => ({ success: false, error: 'RPA_RETRY_CONTACT_SUPPRESSED', terminal: true }) });
    const terminalUpdate = db.queries.filter((q) => q.table === 'rpa_retry_queue' && q.op === 'update').pop();
    expect(terminalUpdate?.payload).toMatchObject({ attempts: 5 });
    expect(terminalUpdate?.payload).not.toHaveProperty('next_retry_at');

    db.queries = [];
    db.tables.rpa_retry_queue = [{ id: 'q2', action_id: 'act-r', organization_id: ORG_A, platform: 'linkedin', action_type: 'reply', target_url: 'u', text: 't', attempts: 1, max_attempts: 5 }];
    await flushRpaRetryQueueForOrg({ organization_id: ORG_A, handler: async () => ({ success: false, error: 'RPA_TIMEOUT' }) });
    const backoff = db.queries.filter((q) => q.table === 'rpa_retry_queue' && q.op === 'update').pop();
    expect(backoff?.payload).toMatchObject({ attempts: 2 });
    expect(backoff?.payload).toHaveProperty('next_retry_at');
  });
});

describe('S-4: pages/api/social/comments.ts direct reply (manual)', () => {
  function mockRes() {
    const res: any = { statusCode: 0, body: undefined };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (p: unknown) => { res.body = p; return res; };
    return res as NextApiResponse & { statusCode: number; body: any };
  }
  async function reply(commentId = '123') {
    db.tables.social_accounts = [{ id: 'acct-1', user_id: 'user-1', company_id: ORG_A }];
    const res = mockRes();
    await (commentsRoute as any)({
      method: 'POST', headers: {}, query: {},
      body: { action: 'reply', platform: 'linkedin', postId: 'post-1', accountId: 'acct-1', commentId, replyText: 'Thanks!' },
    } as unknown as NextApiRequest, res);
    return res;
  }
  const linkedInSends = () => fetchSpy.mock.calls.filter((c: any[]) => String(c[0]).includes('api.linkedin.com')).length;

  it('suppressed comment author → 403 CONTACT_SUPPRESSED, nothing sent', async () => {
    suppress();
    seedAuthor(ORG_A, PERSON, { platformMessageId: 'urn:li:comment:123' });
    const res = await reply();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'CONTACT_SUPPRESSED' });
    expect(linkedInSends()).toBe(0);
  });

  it('unresolvable author → 403 CONTACT_IDENTITY_UNRESOLVED (clear reason code), nothing sent', async () => {
    const res = await reply('999');
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'CONTACT_IDENTITY_UNRESOLVED', reason: 'reply_author_unresolved' });
    expect(linkedInSends()).toBe(0);
  });

  it('CONTROL: an unrestricted author is replied to', async () => {
    seedAuthor(ORG_A, CLEAN_PERSON, { platformMessageId: 'urn:li:comment:123' });
    const res = await reply();
    expect(res.statusCode).toBe(200);
    expect(linkedInSends()).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('H-2a: a refusal is stored as skipped + skip_reason (Production has no "blocked")', () => {
  it('executor (scheduler, persist:true): a suppressed author leaves the row SKIPPED with skip_reason CONTACT_SUPPRESSED', async () => {
    suppress();
    seedAuthor(ORG_A, PERSON, { platformMessageId: COMMENT });
    db.tables.community_ai_actions = [{ id: 'act-1', organization_id: ORG_A, status: 'approved', platform: 'linkedin', action_type: 'reply', target_id: COMMENT }];
    await executeAction(action({ approved_at: '2026-11-01T00:00:00Z' }), true, { source: 'scheduler', persist: true });
    const row = db.tables.community_ai_actions[0];
    expect(row.status).toBe('skipped');
    expect(row.skip_reason).toBe('CONTACT_SUPPRESSED');
    expect(sideEffects()).toBe(0);
    // no write was rejected by the schema
    expect(db.queries.filter((q) => q.table === 'community_ai_actions' && q.op === 'update').every((q) => !actionSchemaViolation(q.payload))).toBe(true);
  });

  it('hand-out persistence: a "blocked" result is stored as skipped (never re-offered: the hand-out reads status=pending only)', async () => {
    db.tables.community_ai_actions = [{ id: 'act-h', organization_id: ORG_A, status: 'pending' }];
    const out = await persistResultForHandout({
      actionId: 'act-h', organizationId: ORG_A, correlationId: '00000000-0000-4000-8000-000000000001', expectedFromStatuses: ['pending'],
      result: { ok: false, status: 'blocked', reason: 'CONTACT_IDENTITY_UNRESOLVED' } as any,
    });
    expect(out.ok).toBe(true);
    expect(db.tables.community_ai_actions[0]).toMatchObject({ status: 'skipped', skip_reason: 'CONTACT_IDENTITY_UNRESOLVED' });
  });
});

describe('H-2b: a LinkedIn reply targeting the POST URN checks the commenters, never ourselves', () => {
  const POST = 'urn:li:activity:7001';
  function seedPostThread(commenterProfile: string | null) {
    const threadId = 'thread-post';
    db.tables.engagement_threads.push({ id: threadId, organization_id: ORG_A, platform_thread_id: POST });
    db.tables.engagement_authors.push({ id: 'author-self', profile_url: 'https://www.linkedin.com/in/our-company-page', platform_user_id: null });
    // the post itself: ours
    db.tables.engagement_messages.push({ id: 'm-post', organization_id: ORG_A, thread_id: threadId, platform_message_id: POST, author_id: 'author-self', raw_payload: { author_self: true }, direction: 'outgoing', created_at: '2026-11-19T00:00:00Z' });
    if (commenterProfile) {
      db.tables.engagement_authors.push({ id: 'author-c', profile_url: commenterProfile, platform_user_id: null });
      db.tables.engagement_messages.push({ id: 'm-c', organization_id: ORG_A, thread_id: threadId, platform_message_id: `urn:li:comment:(${POST},555)`, author_id: 'author-c', raw_payload: {}, direction: 'inbound', created_at: '2026-11-20T00:00:00Z' });
    }
  }

  it('the post is ours (author_self): it is skipped, the suppressed COMMENTER is found and the reply refused', async () => {
    suppress();
    seedPostThread(PERSON);
    const g = await checkCommunityActionContactGovernance({ id: 'act-1', organization_id: ORG_A, platform: 'linkedin', action_type: 'reply', target_id: POST });
    expect(g).toMatchObject({ allowed: false, code: 'CONTACT_SUPPRESSED', identifierKind: 'author_profile_url' });
  });

  it('a post with ONLY our own messages resolves no person → CONTACT_IDENTITY_UNRESOLVED (never "ourselves → allowed")', async () => {
    seedPostThread(null);
    const g = await checkCommunityActionContactGovernance({ organization_id: ORG_A, platform: 'linkedin', action_type: 'reply', target_id: POST });
    expect(g).toMatchObject({ allowed: false, code: 'CONTACT_IDENTITY_UNRESOLVED' });
  });

  it('CONTROL: an unrestricted commenter on the same post is allowed', async () => {
    suppress();
    seedPostThread(CLEAN_PERSON);
    const g = await checkCommunityActionContactGovernance({ organization_id: ORG_A, platform: 'linkedin', action_type: 'reply', target_id: POST });
    expect(g).toMatchObject({ allowed: true });
  });
});

describe('M-5: LinkedIn comment ids are matched in every stored form', () => {
  it('candidates cover the bare id, the stripped compound and the full URN', () => {
    expect(linkedInCommentIdCandidates('123', 'urn:li:activity:1')).toEqual(expect.arrayContaining([
      '123', 'urn:li:comment:123', '(urn:li:activity:1,123)', 'urn:li:comment:(urn:li:activity:1,123)',
    ]));
    expect(linkedInCommentIdCandidates('urn:li:comment:(urn:li:activity:1,123)')).toEqual(expect.arrayContaining(['(urn:li:activity:1,123)', '123']));
  });

  function mockRes() {
    const res: any = { statusCode: 0, body: undefined };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (p: unknown) => { res.body = p; return res; };
    return res as NextApiResponse & { statusCode: number; body: any };
  }
  async function reply(accountCompany: string | null) {
    db.tables.social_accounts = [{ id: 'acct-1', user_id: 'user-1', company_id: accountCompany }];
    const res = mockRes();
    await (commentsRoute as any)({
      method: 'POST', headers: {}, query: {},
      body: { action: 'reply', platform: 'linkedin', postId: 'urn:li:activity:1', accountId: 'acct-1', commentId: '123', replyText: 'Thanks!' },
    } as unknown as NextApiRequest, res);
    return res;
  }

  it.each(['(urn:li:activity:1,123)', '123', 'urn:li:comment:(urn:li:activity:1,123)'])('stored as %s: the suppressed author is found → 403 CONTACT_SUPPRESSED', async (stored) => {
    suppress();
    seedAuthor(ORG_A, PERSON, { platformMessageId: stored });
    const res = await reply(ORG_A);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'CONTACT_SUPPRESSED' });
  });

  it('a user-owned account with no company → 503 CONTACT_GOVERNANCE_UNAVAILABLE (as documented), nothing sent', async () => {
    const res = await reply(null);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ code: 'CONTACT_GOVERNANCE_UNAVAILABLE' });
  });
});
