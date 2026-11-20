/**
 * Publish-now SUPERSEDES the post's queued publish job (coordinator ruling
 * 2026-11-18, option A).
 *
 * THE DEFECT: "Post Now" (components/content/PromotionWorkspace.tsx) stages a
 * scheduled_posts row through POST /api/scheduler/schedule with
 * scheduledFor = now + 2 min — which ENQUEUES a delayed publish job — and then
 * publishes the row at once through POST /api/social/publish. Nothing retired
 * that job. A DEFINITE failure leaves the row 'failed', the user is told it
 * failed, and at +2 min the worker claims the row (publishNowService
 * CLAIMABLE_FROM_STATUSES deliberately includes 'failed') and PUBLISHES it.
 * Click Post Now again and a second row publishes too: a duplicate post.
 *
 * Drives the REAL route (pages/api/social/publish), the REAL publishNow, the
 * REAL cancel helper (cancelScheduledPostQueueEntry), the REAL enqueue and the
 * REAL queue worker (processPublishJob) over one in-memory, Postgres-shaped
 * store (same model as publishRetryStateReliability.test.ts). The platform
 * adapter is the boundary that counts: every publish attempt is recorded.
 */

type Row = Record<string, unknown>;
type DbError = { code: string; message: string };
type Result = { data: unknown; error: DbError | null };

const store: Record<string, Row[]> = {};
/** Returns an error to fail a write/read with, or null to proceed. */
let dbFault: ((table: string, op: 'select' | 'update', payload: Row | null, f: Filters) => DbError | null) | null = null;

type Filters = {
  eq: Record<string, unknown>;
  in: Record<string, unknown[]>;
  is: Record<string, unknown>;
  lte: Record<string, unknown>;
  contains: Record<string, Row>;
};

let writeLock: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => T): Promise<T> {
  const next = writeLock.then(fn, fn);
  writeLock = next.catch(() => undefined);
  return next;
}

function rowMatches(row: Row, f: Filters): boolean {
  for (const [k, v] of Object.entries(f.eq)) if (row[k] !== v) return false;
  for (const [k, vals] of Object.entries(f.in)) if (!vals.includes(row[k])) return false;
  for (const [k, v] of Object.entries(f.is)) {
    // `metadata->platform_call` style JSON path filters.
    if (k.includes('->')) {
      const [col, key] = k.split('->');
      const obj = row[col] as Row | null | undefined;
      if (((obj && typeof obj === 'object' ? obj[key] : null) ?? null) !== v) return false;
      continue;
    }
    if ((row[k] ?? null) !== v) return false;
  }
  for (const [k, v] of Object.entries(f.lte)) {
    if (row[k] == null || String(row[k]) > String(v)) return false;
  }
  for (const [k, criteria] of Object.entries(f.contains)) {
    const col = row[k];
    if (col == null || typeof col !== 'object') return false;
    if (!Object.entries(criteria).every(([ck, cv]) => (col as Row)[ck] === cv)) return false;
  }
  return true;
}

const LIVE = ['pending', 'processing'];

function buildChain(table: string) {
  if (!store[table]) store[table] = [];
  const f: Filters = { eq: {}, in: {}, is: {}, lte: {}, contains: {} };
  let updatePayload: Row | null = null;
  let insertRows: Row[] | null = null;

  const settle = (): Promise<Result> => serialised((): Result => {
    const rows = store[table];
    if (insertRows) {
      const created: Row[] = [];
      for (const incoming of insertRows) {
        if (
          table === 'queue_jobs' &&
          LIVE.includes(String(incoming.status)) &&
          rows.some((r) => r.scheduled_post_id === incoming.scheduled_post_id && LIVE.includes(String(r.status)))
        ) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint "uidx_queue_jobs_live_job_per_post"' },
          };
        }
        created.push({
          id: incoming.id ?? `${table}-${rows.length + created.length + 1}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...(table === 'queue_jobs' ? { retry_state: null } : {}),
          ...incoming,
        });
      }
      rows.push(...created);
      return { data: created, error: null };
    }
    const fault = dbFault?.(table, updatePayload ? 'update' : 'select', updatePayload, f) ?? null;
    if (fault) return { data: null, error: fault };
    const hit = rows.filter((r) => rowMatches(r, f));
    if (updatePayload) {
      const payload = updatePayload;
      hit.forEach((r) => Object.assign(r, payload));
    }
    return { data: hit.map((r) => ({ ...r })), error: null };
  });

  const chain: any = {
    select: () => chain,
    insert: (r: Row | Row[]) => { insertRows = Array.isArray(r) ? r : [r]; return chain; },
    update: (p: Row) => { updatePayload = p; return chain; },
    eq: (k: string, v: unknown) => { f.eq[k] = v; return chain; },
    neq: () => chain,
    in: (k: string, v: unknown[]) => { f.in[k] = v; return chain; },
    is: (k: string, v: unknown) => { f.is[k] = v; return chain; },
    lte: (k: string, v: unknown) => { f.lte[k] = v; return chain; },
    lt: () => chain,
    gte: () => chain,
    contains: (k: string, v: Row) => { f.contains[k] = v; return chain; },
    order: () => chain,
    limit: () => chain,
    single: async () => {
      const r = await settle();
      if (r.error) return r;
      const list = r.data as Row[];
      return list[0] ? { data: list[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    },
    maybeSingle: async () => {
      const r = await settle();
      if (r.error) return r;
      const list = r.data as Row[];
      return { data: list[0] ?? null, error: null };
    },
    then: (ok: (r: Result) => unknown, err?: (e: unknown) => unknown) => settle().then(ok, err),
  };
  return chain;
}

jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (table: string) => buildChain(table),
    rpc: async () => ({ data: null, error: { message: 'rpc missing' } }),
  },
}));

// ─── BullMQ: a registry of job ids ─────────────────────────────────────────
const bullJobs = new Set<string>();
const bullRemoved: string[] = [];
jest.mock('../../queue/bullmqClient', () => ({
  getQueue: () => ({
    name: 'publish',
    getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, prioritized: 0 }),
    add: async (_name: string, _data: Row, opts: Row) => { bullJobs.add(String(opts.jobId)); return { id: opts.jobId }; },
    addBulk: async (jobs: Array<{ opts: Row }>) => jobs.map((j) => { bullJobs.add(String(j.opts.jobId)); return { id: j.opts.jobId }; }),
    getJob: async (id: string) => {
      if (!bullJobs.has(id)) return null;
      return { id, remove: async () => { bullJobs.delete(id); bullRemoved.push(id); } };
    },
  }),
  getEngagementPollingQueue: () => ({ add: async () => undefined }),
}));

// ─── The platform boundary — every publish attempt is counted here ──────────
const platformCalls: string[] = [];
const platformPublished: string[] = [];
let platformOutcome: 'success' | 'failure' = 'success';
jest.mock('../../adapters/platformAdapter', () => ({
  publishToPlatform: jest.fn(async (scheduledPostId: string) => {
    platformCalls.push(scheduledPostId);
    if (platformOutcome === 'failure') {
      // A CONFIRMED rejection (nothing created): an ordinary 'failed' row.
      return { success: false, error: { code: 'LINKEDIN_RATE_LIMIT', message: 'slow down', retryable: true } };
    }
    platformPublished.push(scheduledPostId);
    return {
      success: true,
      platform_post_id: `plat_${scheduledPostId}_${platformCalls.length}`,
      post_url: `https://example.test/${scheduledPostId}`,
      published_at: new Date(),
    };
  }),
}));

// ─── Peripheral collaborators ──────────────────────────────────────────────
jest.mock('../../middleware/withIdempotency', () => ({ withIdempotency: (h: unknown) => h }));
jest.mock('../../services/rbacService', () => ({ isSuperAdmin: jest.fn(async () => false) }));
jest.mock('../../services/engagementCapabilityMap', () => ({
  resolveEngagementCapability: jest.fn(() => ({ status: 'api_verified' })),
}));
jest.mock('../../services/auditLoggingService', () => ({ logAuditEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/postSocialAccountResolver', () => ({ resolvePostSocialAccount: jest.fn() }));
jest.mock('../../services/threadRuntime/threadPublishOrchestrator', () => ({
  publishThread: jest.fn(async () => ({ status: 'PUBLISHED', root_id: 'x', total_nodes: 1, published_count: 1 })),
}));
jest.mock('../../services/publishReadinessValidator', () => ({
  validatePublishReadiness: jest.fn(() => ({ ok: true, warnings: [] })),
  assertMediaAccessible: jest.fn(async () => null),
}));
jest.mock('../../services/creatorPublishValidation', () => ({
  validateCreatorPublishSemanticsLive: jest.fn(async () => ({ ok: true, errors: [], warnings: [] })),
}));
jest.mock('../../services/creatorOperationalTelemetryService', () => ({
  emitCreatorEvent: jest.fn(),
  CREATOR_EVENTS: new Proxy({}, { get: (_t, k) => String(k) }),
}));
jest.mock('../../services/creatorAuditTrailService', () => ({ recordAuditEntry: jest.fn() }));
jest.mock('../../services/mediaReferenceResolver', () => ({
  refreshDurableMediaBeforePublish: jest.fn(async () => undefined),
}));
jest.mock('../../services/creator/publishingOrganizationResolver', () => ({
  resolvePublishingOrganization: jest.fn(async () => null),
}));
jest.mock('../../services/creator/creatorPublishResolution', () => ({
  resolvePublishMedia: jest.fn(async () => ({ mediaUrls: [], resolvedCount: 0 })),
}));
jest.mock('../../services/creatorQueueReliabilityService', () => ({ recordPublishFailure: jest.fn(async () => undefined) }));
jest.mock('../../services/errorRecoveryService', () => ({
  categorizeError: jest.fn((_p: string, err: { code?: string; message?: string } | undefined) => ({
    code: err?.code ?? 'PROCESSING_ERROR',
    message: err?.message ?? String(err),
    user_message: err?.message ?? String(err),
  })),
}));
jest.mock('../../services/analyticsService', () => ({ recordPostAnalytics: jest.fn(async () => undefined) }));
jest.mock('../../services/analyticsNormalizationService', () => ({ schedulePostPolls: jest.fn(async () => undefined) }));
jest.mock('../../services/activityLogger', () => ({ logActivity: jest.fn(async () => undefined) }));
jest.mock('../../services/userNotificationService', () => ({ createUserNotification: jest.fn(async () => undefined) }));
jest.mock('../../services/CampaignCompletionService', () => ({ checkAndCompleteCampaignIfEligible: jest.fn(async () => undefined) }));
jest.mock('../../security/audit/SecurityAuditService', () => ({ logSecurityEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/creator/strategyAttributionResolver', () => ({
  resolveStrategyAttributionForScheduledPost: jest.fn(async () => null),
}));
jest.mock('../../services/creator/variantExperimentLifecycle', () => ({ notifyExperimentAssetPublished: jest.fn() }));
jest.mock('../../services/executionGovernor', () => ({ acquire: jest.fn(() => ({ ok: true, release: () => undefined })) }));

const USER = '00000000-0000-4000-8000-0000000000a1';
const ACCOUNT = '00000000-0000-4000-8000-0000000000b1';

jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: jest.fn(async () => ({ user: { id: '00000000-0000-4000-8000-0000000000a1' }, error: null })),
}));

import type { Job } from 'bullmq';
import * as queueControl from '../../scheduler/schedulerPostQueueControl';
import { enqueueScheduledPostAt } from '../../scheduler/schedulerService';
import { processPublishJob } from '../../queue/jobProcessors/publishProcessor';
import { publishNow } from '../../services/publishNowService';
import publishRoute from '../../../pages/api/social/publish';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const IN_TWO_MIN = (): string => new Date(Date.now() + 2 * 60 * 1000).toISOString();

/**
 * What "Post Now" does first: POST /api/scheduler/schedule inserts the row and
 * calls the REAL enqueueScheduledPostAt for now + 2 min (a delayed job).
 */
async function stage(id: string, overrides: Row = {}): Promise<string> {
  const scheduledFor = IN_TWO_MIN();
  store.scheduled_posts.push({
    id,
    user_id: USER,
    social_account_id: ACCOUNT,
    campaign_id: null,
    platform: 'linkedin',
    content_type: 'post',
    content: 'Read our new blog post',
    media_urls: [],
    scheduled_for: scheduledFor,
    status: 'scheduled',
    error_code: null,
    platform_post_id: null,
    is_thread_start: false,
    parent_post_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });
  const enq = await enqueueScheduledPostAt(id, USER, ACCOUNT, scheduledFor);
  expect(enq).toBe('enqueued');
  const job = store.queue_jobs.find((r) => r.scheduled_post_id === id);
  expect(job).toBeDefined();
  expect(bullJobs.has(String(job!.id))).toBe(true);
  return String(job!.id);
}

type RouteRes = { statusCode: number; body: Row | null; status: (c: number) => RouteRes; json: (b: Row) => RouteRes; setHeader: () => void };
async function postNow(postId: string): Promise<RouteRes> {
  const res: RouteRes = {
    statusCode: 200,
    body: null,
    status: (c: number) => { res.statusCode = c; return res; },
    json: (b: Row) => { res.body = b; return res; },
    setHeader: () => undefined,
  };
  const req = { method: 'POST', headers: { authorization: 'Bearer t' }, query: {}, body: { post_id: postId } };
  await (publishRoute as unknown as (rq: typeof req, rs: RouteRes) => Promise<void>)(req, res);
  return res;
}

/** The +2 min delivery of a job — as BullMQ would deliver it if it survived. */
async function fire(jobId: string, postId: string): Promise<void> {
  const job = {
    id: jobId,
    data: { scheduled_post_id: postId, social_account_id: ACCOUNT, user_id: USER },
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as unknown as Job<{ scheduled_post_id: string; social_account_id: string; user_id: string }>;
  try {
    await processPublishJob(job);
  } catch {
    /* a refused delivery may throw for BullMQ's bookkeeping; the platform count is what matters */
  }
}

const post = (id: string): Row => store.scheduled_posts.find((r) => r.id === id) as Row;
const qjob = (id: string): Row => store.queue_jobs.find((r) => r.id === id) as Row;
const callsFor = (id: string): number => platformCalls.filter((p) => p === id).length;

let cancelSpy: jest.SpyInstance;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  for (const t of ['scheduled_posts', 'queue_jobs', 'queue_job_logs', 'campaigns', 'worker_dead_letter_queue']) store[t] = [];
  dbFault = null;
  writeLock = Promise.resolve();
  bullJobs.clear();
  bullRemoved.length = 0;
  platformCalls.length = 0;
  platformPublished.length = 0;
  platformOutcome = 'success';
  cancelSpy = jest.spyOn(queueControl, 'cancelScheduledPostQueueEntry');
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Positive control: the counter is live ─────────────────────────────────

describe('control — a scheduled job that nothing superseded DOES publish', () => {
  test('the staged job fires and the platform is called exactly once', async () => {
    const jobId = await stage('sp-ctl');
    await fire(jobId, 'sp-ctl');
    expect(callsFor('sp-ctl')).toBe(1);
    expect(post('sp-ctl').status).toBe('published');
  });

  test('a FAILED row whose job was never cancelled is claimable by the worker (why the cancel is required)', async () => {
    const jobId = await stage('sp-ctl2', { status: 'failed', error_code: 'LINKEDIN_RATE_LIMIT' });
    await fire(jobId, 'sp-ctl2');
    expect(callsFor('sp-ctl2')).toBe(1);
  });
});

// ─── (1) success ──────────────────────────────────────────────────────────

describe('(1) Post Now succeeds', () => {
  test('the queued job is cancelled; firing it anyway makes no second platform call', async () => {
    const jobId = await stage('sp-1');
    const res = await postNow('sp-1');
    expect(res.statusCode).toBe(200);
    expect(res.body?.status).toBe('PUBLISHED');
    expect(callsFor('sp-1')).toBe(1);
    expect(post('sp-1').status).toBe('published');

    expect(qjob(jobId).status).toBe('cancelled');
    expect(bullJobs.has(jobId)).toBe(false);

    await fire(jobId, 'sp-1');
    expect(callsFor('sp-1')).toBe(1);
  });
});

// ─── (2) definite failure ─────────────────────────────────────────────────

describe('(2) Post Now fails definitely', () => {
  test('the failure is reported, the job is cancelled, and the +2 min delivery makes ZERO platform calls', async () => {
    const jobId = await stage('sp-2');
    platformOutcome = 'failure';
    const res = await postNow('sp-2');
    expect(res.body?.status).toBe('FAILED');
    expect(callsFor('sp-2')).toBe(1);
    expect(post('sp-2').status).toBe('failed');

    platformOutcome = 'success'; // the platform would accept it now
    await fire(jobId, 'sp-2');
    expect(platformPublished).toEqual([]); // the user was told "failed": nothing may publish
    expect(callsFor('sp-2')).toBe(1); // the failed attempt only — nothing at +2 min
    expect(post('sp-2').status).toBe('failed');

    expect(qjob(jobId).status).toBe('cancelled');
    expect(bullJobs.has(jobId)).toBe(false);
  });
});

// ─── (3) the duplicate scenario ───────────────────────────────────────────

describe('(3) Post Now fails, Post Now again succeeds, both jobs fire', () => {
  test('exactly ONE platform publish for the content', async () => {
    const jobA = await stage('sp-3a');
    platformOutcome = 'failure';
    const first = await postNow('sp-3a');
    expect(first.body?.status).toBe('FAILED');

    platformOutcome = 'success';
    const jobB = await stage('sp-3b');
    const second = await postNow('sp-3b');
    expect(second.body?.status).toBe('PUBLISHED');

    await fire(jobA, 'sp-3a');
    await fire(jobB, 'sp-3b');

    expect(platformPublished).toEqual(['sp-3b']);
    expect(platformCalls).toEqual(['sp-3a', 'sp-3b']); // the failed first attempt, then the one publish
  });
});

// ─── (4) the cancel fails ─────────────────────────────────────────────────

describe('(4) the job cancel fails — fail safe', () => {
  test('a queue_jobs DATABASE error: no platform call, an explicit error, the row fenced; the old job makes zero calls', async () => {
    const jobId = await stage('sp-4');
    dbFault = (table) => (table === 'queue_jobs' ? { code: '08006', message: 'connection lost' } : null);

    const res = await postNow('sp-4');
    expect(callsFor('sp-4')).toBe(0);
    expect(res.statusCode).toBe(503);
    expect(res.body?.code).toBe('PRIOR_JOB_CANCEL_FAILED');
    expect(res.body?.status).toBe('FAILED');
    // The job survived (its row is still pending) — so the ROW must not be publishable.
    expect(qjob(jobId).status).toBe('pending');
    expect(post('sp-4').status).toBe('cancelled');
    expect(post('sp-4').platform_post_id).toBeNull();

    dbFault = null; // the database is back when the job fires
    await fire(jobId, 'sp-4');
    expect(callsFor('sp-4')).toBe(0);
  });

  test('the cancel helper THROWS: same fail-safe', async () => {
    const jobId = await stage('sp-4b');
    cancelSpy.mockRejectedValueOnce(new Error('redis exploded'));

    const res = await postNow('sp-4b');
    expect(callsFor('sp-4b')).toBe(0);
    expect(res.statusCode).toBe(503);
    expect(res.body?.code).toBe('PRIOR_JOB_CANCEL_FAILED');
    expect(post('sp-4b').status).toBe('cancelled');

    await fire(jobId, 'sp-4b');
    expect(callsFor('sp-4b')).toBe(0);
  });

  test('the cancel fails AND the fence write fails: still no platform call, and the +2 min delivery is refused by the held claim', async () => {
    const jobId = await stage('sp-4c');
    dbFault = (table, op, payload) => {
      if (table === 'queue_jobs') return { code: '08006', message: 'connection lost' };
      if (table === 'scheduled_posts' && op === 'update' && payload?.status === 'cancelled') {
        return { code: '08006', message: 'connection lost' };
      }
      return null;
    };
    const res = await postNow('sp-4c');
    expect(callsFor('sp-4c')).toBe(0);
    expect(res.statusCode).toBe(503);
    expect(res.body?.code).toBe('PRIOR_JOB_CANCEL_FAILED');
    expect(post('sp-4c').status).toBe('publishing'); // our pre-call claim, never released

    dbFault = null;
    await fire(jobId, 'sp-4c');
    expect(callsFor('sp-4c')).toBe(0);
  });

  test('a BullMQ-only removal error does NOT block: the database row is cancelled, which the worker obeys', async () => {
    const jobId = await stage('sp-4d');
    cancelSpy.mockImplementationOnce(async (id: string, opts?: { reason?: string }) => {
      const real = jest.requireActual('../../scheduler/schedulerPostQueueControl');
      const r = await real.cancelScheduledPostQueueEntry(id, opts);
      // The job is "still held by BullMQ": put it back and report the removal failure.
      bullJobs.add(jobId);
      return { ...r, queue_removed: 0, errors: [`bullmq remove(${jobId}) threw: locked`] };
    });
    const res = await postNow('sp-4d');
    expect(res.body?.status).toBe('PUBLISHED');
    expect(callsFor('sp-4d')).toBe(1);
    expect(qjob(jobId).status).toBe('cancelled');

    await fire(jobId, 'sp-4d');
    expect(callsFor('sp-4d')).toBe(1);
  });
});

// ─── (5) not the worker, not the cron ─────────────────────────────────────

describe('(5) the queue worker and the cron do not cancel their own jobs', () => {
  test('a worker delivery publishes without calling the cancel helper', async () => {
    const jobId = await stage('sp-5');
    await fire(jobId, 'sp-5');
    expect(callsFor('sp-5')).toBe(1);
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  test('publishNow as the cron calls it (no supersede flag) leaves the queued job alone', async () => {
    const jobId = await stage('sp-5b');
    const r = await publishNow({ scheduled_post_id: 'sp-5b', social_account_id: ACCOUNT, user_id: USER });
    expect(r.status).toBe('PUBLISHED');
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(qjob(jobId).status).toBe('pending');
    expect(bullJobs.has(jobId)).toBe(true);
  });

  test('the manual route DOES call the cancel helper, once, for its own post, with a supersede reason', async () => {
    await stage('sp-5c');
    await postNow('sp-5c');
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledWith('sp-5c', { reason: 'superseded_by_publish_now' });
  });
});

// ─── ordering: the cancel happens AFTER the claim and BEFORE the platform call ─

describe('ordering', () => {
  test('the post is claimed when the cancel runs, and no platform call has happened yet', async () => {
    await stage('sp-6');
    const seen: Array<{ status: unknown; calls: number }> = [];
    cancelSpy.mockImplementationOnce(async (id: string, opts?: { reason?: string }) => {
      seen.push({ status: post(id).status, calls: callsFor(id) });
      return jest.requireActual('../../scheduler/schedulerPostQueueControl').cancelScheduledPostQueueEntry(id, opts);
    });
    await postNow('sp-6');
    expect(seen).toEqual([{ status: 'publishing', calls: 0 }]);
  });

  test('a refused claim (another execution holds the post) cancels nothing', async () => {
    const jobId = await stage('sp-7', { status: 'publishing', error_code: 'PUBLISH_CLAIMED:other', updated_at: new Date().toISOString() });
    const res = await postNow('sp-7');
    expect(callsFor('sp-7')).toBe(0);
    expect(res.body?.refusal).toBe('held_by_another_execution');
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(qjob(jobId).status).toBe('pending');
  });
});

// ─── (8) the supersede marker travels with the claim (reviewer 7c) ─────────
//
// THE HOLE: the cancel fails AND the fence write fails, so the row keeps the
// pre-call claim. Before the marker, the stuck-publishing sweeper relabelled
// any pre-call claim 'failed' / PUBLISH_NOT_ATTEMPTED (claimable), and a stale
// claim could be taken over: a worker delayed past either published the post
// through the job whose cancel had failed, after the user was told "not
// posted". The claim itself now carries PUBLISH_CLAIMED:SUPERSEDE:<uuid>.

import sweepStuckPublishing from '../../../pages/api/cron/sweep-stuck-publishing';
import {
  isPreCallClaim,
  isSupersedePreCallClaim,
  PUBLISH_SUPERSEDE_CLAIM_PREFIX,
  reschedulingFenceState,
  retryClaimState,
} from '../../queue/publishOutcome';
import * as platformAdapter from '../../adapters/platformAdapter';
import * as creatorPublishValidation from '../../services/creatorPublishValidation';

const ELEVEN_MIN_AGO = (): string => new Date(Date.now() - 11 * 60 * 1000).toISOString();
const SIX_MIN_AGO = (): string => new Date(Date.now() - 6 * 60 * 1000).toISOString();
const MARKED = /^PUBLISH_CLAIMED:SUPERSEDE:[0-9a-f-]{36}$/;

async function sweep(): Promise<Row> {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'sweep-secret';
  try {
    const res: RouteRes = {
      statusCode: 200,
      body: null,
      status: (c: number) => { res.statusCode = c; return res; },
      json: (b: Row) => { res.body = b; return res; },
      setHeader: () => undefined,
    };
    const req = { method: 'POST', headers: { authorization: 'Bearer sweep-secret' }, query: {}, body: {} };
    await (sweepStuckPublishing as unknown as (rq: typeof req, rs: RouteRes) => Promise<void>)(req, res);
    expect(res.statusCode).toBe(200);
    return res.body as Row;
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
  }
}

/** Cancel fails (queue_jobs down) AND the fence write fails: the row keeps our claim. */
async function strandMarkedClaim(id: string): Promise<string> {
  const jobId = await stage(id);
  dbFault = (table, op, payload) => {
    if (table === 'queue_jobs') return { code: '08006', message: 'connection lost' };
    if (table === 'scheduled_posts' && op === 'update' && payload?.status === 'cancelled') {
      return { code: '08006', message: 'connection lost' };
    }
    return null;
  };
  const res = await postNow(id);
  dbFault = null;
  expect(res.statusCode).toBe(503);
  expect(res.body?.post_fenced).toBe(false);
  expect(post(id).status).toBe('publishing'); // our pre-call claim, unfenced
  expect(qjob(jobId).status).toBe('pending'); // the job survived
  expect(callsFor(id)).toBe(0);
  return jobId;
}

describe('(8a) cancel fails + fence fails, then the sweeper runs, then the old job fires', () => {
  test('the sweeper fences the marked claim; the surviving job, publishNow and Post Now all make ZERO platform calls', async () => {
    const jobId = await strandMarkedClaim('sp-8a');
    post('sp-8a').updated_at = ELEVEN_MIN_AGO(); // the worker is delayed past the sweep

    const claimCode = String(post('sp-8a').error_code);
    const swept = await sweep();
    expect(swept.swept).toBe(1);

    // Drive every publisher at the swept row: none may reach the platform.
    await fire(jobId, 'sp-8a');
    expect(callsFor('sp-8a')).toBe(0);
    const cron = await publishNow({ scheduled_post_id: 'sp-8a', social_account_id: ACCOUNT, user_id: USER });
    expect(cron.status).toBe('FAILED');
    expect(cron.suppressed).toBe(true);
    const again = await postNow('sp-8a');
    expect(again.body?.status).not.toBe('PUBLISHED');
    expect(callsFor('sp-8a')).toBe(0);
    expect(platformPublished).toEqual([]);
    // Why: the claim's FIRST write carried the marker, and the sweep wrote the fence.
    expect(claimCode).toMatch(MARKED);
    expect(post('sp-8a')).toMatchObject({ status: 'cancelled', error_code: 'PRIOR_JOB_CANCEL_FAILED' });
  });

  test('a stale marked claim is never TAKEN OVER: the job delayed past the stale window (before any sweep) makes zero calls', async () => {
    const jobId = await strandMarkedClaim('sp-8a2');
    post('sp-8a2').updated_at = SIX_MIN_AGO(); // > PUBLISH_CLAIM_STALE_WINDOW_MS, < sweep threshold

    await fire(jobId, 'sp-8a2');
    expect(callsFor('sp-8a2')).toBe(0);
    const cron = await publishNow({ scheduled_post_id: 'sp-8a2', social_account_id: ACCOUNT, user_id: USER });
    expect(callsFor('sp-8a2')).toBe(0);
    expect(cron.refusal).toBe('held_by_another_execution');
    expect(post('sp-8a2').status).toBe('publishing');
    expect(String(post('sp-8a2').error_code)).toMatch(MARKED);
  });
});

describe('(8b) control: an UNMARKED stuck pre-call claim keeps the existing sweep', () => {
  test('swept to failed / PUBLISH_NOT_ATTEMPTED and still claimable: its job publishes', async () => {
    const jobId = await stage('sp-8b', { status: 'publishing', error_code: 'PUBLISH_CLAIMED:dead-holder', updated_at: ELEVEN_MIN_AGO() });
    const swept = await sweep();
    expect(swept.swept).toBe(1);
    expect(post('sp-8b')).toMatchObject({ status: 'failed', error_code: 'PUBLISH_NOT_ATTEMPTED' });

    await fire(jobId, 'sp-8b');
    expect(callsFor('sp-8b')).toBe(1);
    expect(post('sp-8b').status).toBe('published');
  });

  test('an unmarked stale pre-call claim is still taken over by a delivery', async () => {
    const jobId = await stage('sp-8b2', { status: 'publishing', error_code: 'PUBLISH_CLAIMED:dead-holder', updated_at: SIX_MIN_AGO() });
    await fire(jobId, 'sp-8b2');
    expect(callsFor('sp-8b2')).toBe(1);
    expect(post('sp-8b2').status).toBe('published');
  });

  test('a call-started row is still swept to PUBLISH_OUTCOME_UNCERTAIN', async () => {
    await stage('sp-8b3', { status: 'publishing', error_code: 'PUBLISH_CALL_STARTED', updated_at: ELEVEN_MIN_AGO() });
    await sweep();
    expect(post('sp-8b3')).toMatchObject({ status: 'failed', error_code: 'PUBLISH_OUTCOME_UNCERTAIN' });
  });
});

describe('(8c) a marked claim that proceeds normally flows exactly as before', () => {
  test('cancel ok -> marked claim -> PUBLISH_CALL_STARTED -> published, same codes as an unmarked publish', async () => {
    const jobId = await stage('sp-8c');
    const atCancel: unknown[] = [];
    cancelSpy.mockImplementationOnce(async (id: string, opts?: { reason?: string }) => {
      atCancel.push(post(id).error_code);
      return jest.requireActual('../../scheduler/schedulerPostQueueControl').cancelScheduledPostQueueEntry(id, opts);
    });
    const atCall: unknown[] = [];
    const adapter = platformAdapter.publishToPlatform as unknown as jest.Mock;
    const real = adapter.getMockImplementation() as (...a: unknown[]) => Promise<unknown>;
    adapter.mockImplementationOnce(async (id: string, ...rest: unknown[]) => {
      atCall.push(post(id).error_code);
      return real(id, ...rest);
    });

    const res = await postNow('sp-8c');
    expect(res.body?.status).toBe('PUBLISHED');
    expect(String(atCancel[0])).toMatch(MARKED);
    expect(atCall).toEqual(['PUBLISH_CALL_STARTED']); // the CAS from the marked token landed
    expect(callsFor('sp-8c')).toBe(1);
    expect(qjob(jobId).status).toBe('cancelled');

    // Same terminal state as an unmarked (cron) publish of an identical row.
    await stage('sp-8c-ref');
    const ref = await publishNow({ scheduled_post_id: 'sp-8c-ref', social_account_id: ACCOUNT, user_id: USER });
    expect(ref.status).toBe('PUBLISHED');
    const pick = (r: Row) => ({ status: r.status, error_code: r.error_code ?? null, has_id: !!r.platform_post_id });
    expect(pick(post('sp-8c'))).toEqual(pick(post('sp-8c-ref')));
    expect(pick(post('sp-8c'))).toMatchObject({ status: 'published', has_id: true });
  });

  test('cancel ok -> platform rejects -> failed with the platform code (not a supersede fence)', async () => {
    await stage('sp-8c2');
    platformOutcome = 'failure';
    const res = await postNow('sp-8c2');
    expect(res.body?.status).toBe('FAILED');
    expect(post('sp-8c2')).toMatchObject({ status: 'failed', error_code: 'LINKEDIN_RATE_LIMIT' });
  });

  test('cancel ok -> unexpected throw before the call -> the marked claim is RELEASED to its prior state', async () => {
    await stage('sp-8c3');
    jest.spyOn(creatorPublishValidation, 'validateCreatorPublishSemanticsLive').mockRejectedValueOnce(new Error('boom'));
    let threw = false;
    await publishNow({ scheduled_post_id: 'sp-8c3', social_account_id: ACCOUNT, user_id: USER, supersede_queued_jobs: true })
      .catch(() => { threw = true; });
    expect(threw).toBe(true);
    expect(callsFor('sp-8c3')).toBe(0);
    expect(post('sp-8c3')).toMatchObject({ status: 'scheduled', error_code: null });
  });
});

describe('(8d) the marker in the pure predicates', () => {
  const code = `${PUBLISH_SUPERSEDE_CLAIM_PREFIX}00000000-0000-4000-8000-000000000001`;
  test('a marked claim is a pre-call claim AND a supersede claim; an unmarked one is not a supersede claim', () => {
    expect(isPreCallClaim({ status: 'publishing', error_code: code })).toBe(true);
    expect(isSupersedePreCallClaim({ status: 'publishing', error_code: code })).toBe(true);
    expect(isSupersedePreCallClaim({ status: 'publishing', error_code: 'PUBLISH_CLAIMED:00000000-0000-4000-8000-000000000001' })).toBe(false);
    expect(isSupersedePreCallClaim({ status: 'failed', error_code: code })).toBe(false);
    expect(isSupersedePreCallClaim({ status: 'publishing', error_code: 'PUBLISH_CALL_STARTED' })).toBe(false);
    // Fails closed: the bare marker still counts as marked.
    expect(isSupersedePreCallClaim({ status: 'publishing', error_code: PUBLISH_SUPERSEDE_CLAIM_PREFIX })).toBe(true);
  });
  test('the timed-fence extractor never sees a marked claim (prefix mismatch gives null, never NaN/live)', () => {
    expect(retryClaimState(code, Date.now())).toBeNull();
    expect(reschedulingFenceState(code, Date.now())).toBeNull();
  });
});
