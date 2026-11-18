/**
 * An UNREADABLE publishing organization never publishes (correct-sending, BLOCKING).
 *
 * THE DEFECT: processPublishJob resolved the owning organization with
 * resolvePublishingOrganization, which answered null on a FAILED read (PostgREST
 * returns the error, the resolver ignored it; a thrown failure was swallowed).
 * runJob treats a null tenantId as a platform-wide job and SKIPS the tenant
 * check (the deleted / inactive / suspended-organization guard), so a failed
 * organization read published the post with no tenant check at all.
 *
 * Drives the REAL worker entrypoint (processPublishJob) through the REAL
 * resolver, the REAL runJob and the REAL TenantGuard, over an in-memory
 * Postgres-shaped fake that can fail one table's reads. Platform calls are
 * counted at the adapter.
 */
export {};

type Row = Record<string, any>;

const store: Record<string, Row[]> = {};
/** Per-table read failure: a PostgREST error RETURNED, or a thrown (network) failure. */
const failReads: Record<string, 'error' | 'throw'> = {};
/** Every table read, in order — shows whether the tenant check ran. */
const reads: string[] = [];

let writeLock: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => T): Promise<T> {
  const next = writeLock.then(fn, fn);
  writeLock = next.catch(() => undefined);
  return next;
}

function matches(row: Row, state: any): boolean {
  for (const [k, v] of Object.entries(state.eq)) if (row[k] !== v) return false;
  for (const [k, vals] of Object.entries(state.in)) if (!(vals as any[]).includes(row[k])) return false;
  for (const [k, v] of Object.entries(state.lt)) if (row[k] == null || !(row[k] < (v as any))) return false;
  for (const [k, v] of Object.entries(state.is)) if ((row[k] ?? null) !== v) return false;
  for (const [k, criteria] of Object.entries(state.contains)) {
    const col = row[k];
    if (col == null || typeof col !== 'object') return false;
    if (!Object.entries(criteria as Row).every(([ck, cv]) => (col as Row)[ck] === cv)) return false;
  }
  return true;
}

function buildChain(table: string) {
  const state: any = { eq: {}, in: {}, lt: {}, is: {}, contains: {}, update: null, insert: null, del: false };
  if (!store[table]) store[table] = [];

  const settle = (): Promise<{ data: any; error: any }> => serialised(() => {
    const isRead = !state.insert && !state.update && !state.del;
    if (isRead) {
      reads.push(table);
      if (failReads[table] === 'throw') throw new Error('fetch failed');
      if (failReads[table] === 'error') return { data: null, error: { message: 'connection reset', code: '08006' } };
    }
    const rows = store[table];
    if (state.insert) {
      const incoming = Array.isArray(state.insert) ? state.insert : [state.insert];
      const created = incoming.map((r: Row) => ({
        id: r.id ?? `gen-${Math.random().toString(36).slice(2, 10)}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...r,
      }));
      rows.push(...created);
      return { data: created, error: null };
    }
    const hit = rows.filter((r) => matches(r, state));
    if (state.del) {
      store[table] = rows.filter((r) => !hit.includes(r));
      return { data: hit, error: null };
    }
    if (state.update) hit.forEach((r) => Object.assign(r, state.update));
    return { data: hit, error: null };
  });

  const self: any = {
    select: (..._a: any[]) => self,
    insert: (rows: any) => { state.insert = rows; return self; },
    update: (data: any) => { state.update = data; return self; },
    delete: () => { state.del = true; return self; },
    eq: (f: string, v: any) => { state.eq[f] = v; return self; },
    in: (f: string, v: any[]) => { state.in[f] = v; return self; },
    lt: (f: string, v: any) => { state.lt[f] = v; return self; },
    lte: (f: string, v: any) => { state.lt[f] = v; return self; },
    is: (f: string, v: any) => { state.is[f] = v; return self; },
    contains: (f: string, v: any) => { state.contains[f] = v; return self; },
    order: () => self,
    limit: () => self,
    single: async () => {
      const { data, error } = await settle();
      if (error) return { data: null, error };
      const first = Array.isArray(data) ? data[0] : data;
      return first ? { data: first, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    },
    maybeSingle: async () => {
      const { data, error } = await settle();
      if (error) return { data: null, error };
      const first = Array.isArray(data) ? data[0] : data;
      return { data: first ?? null, error: null };
    },
    then: (onOk: any, onErr?: any) => settle().then(onOk, onErr),
  };
  return self;
}

jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (table: string) => buildChain(table),
    rpc: async () => ({ data: null, error: { message: 'rpc missing' } }),
  },
}));

// ─── Platform boundary + peripheral collaborators ───────────────────────────

const platformCalls: string[] = [];
jest.mock('../../adapters/platformAdapter', () => ({
  publishToPlatform: jest.fn(async (scheduledPostId: string) => {
    platformCalls.push(scheduledPostId);
    return {
      success: true,
      platform_post_id: `plat_${scheduledPostId}_${platformCalls.length}`,
      post_url: `https://example.test/${scheduledPostId}`,
      published_at: new Date(),
    };
  }),
}));

// Not a platform super-admin: the membership + organization-state chain runs.
jest.mock('../../services/rbacService', () => ({
  ...jest.requireActual('../../services/rbacService'),
  isPlatformSuperAdmin: jest.fn(async () => false),
}));
jest.mock('../../services/threadRuntime/threadPublishOrchestrator', () => ({ publishThread: jest.fn() }));
jest.mock('../../services/publishReadinessValidator', () => ({
  validatePublishReadiness: jest.fn(() => ({ ok: true, warnings: [] })),
}));
jest.mock('../../services/mediaReferenceResolver', () => ({
  refreshDurableMediaBeforePublish: jest.fn(async () => undefined),
}));
jest.mock('../../services/publishNowService', () => ({
  ...jest.requireActual('../../services/publishNowService'),
  refreshScheduledPostMediaFromRefs: jest.fn(async () => undefined),
}));
jest.mock('../../services/creator/creatorPublishResolution', () => ({
  resolvePublishMedia: jest.fn(async () => ({ mediaUrls: [], resolvedCount: 0 })),
}));
jest.mock('../../services/creatorQueueReliabilityService', () => ({ recordPublishFailure: jest.fn(async () => undefined) }));
jest.mock('../../services/errorRecoveryService', () => ({
  categorizeError: jest.fn((_p: string, err: any) => ({ code: err?.code ?? 'PROCESSING_ERROR', user_message: err?.message ?? String(err) })),
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
jest.mock('../../services/creator/variantExperimentLifecycle', () => ({ notifyExperimentAssetPublished: jest.fn(() => undefined) }));
jest.mock('../../services/executionGovernor', () => ({ acquire: jest.fn(() => ({ ok: true, release: () => undefined })) }));

import type { Job } from 'bullmq';
import { processPublishJob } from '../../queue/jobProcessors/publishProcessor';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const USER = '00000000-0000-0000-0000-0000000000u1';
const ACCOUNT = '00000000-0000-0000-0000-0000000000a1';
const ORG = '00000000-0000-0000-0000-0000000000c1';

function seed(table: string, row: Row): Row {
  (store[table] ??= []).push(row);
  return row;
}

function seedPostAndJob(): void {
  seed('scheduled_posts', {
    id: 'sp-1', user_id: USER, social_account_id: ACCOUNT, campaign_id: null, platform: 'linkedin',
    content_type: 'post', content: 'body', media_urls: [], scheduled_for: new Date(Date.now() - 60_000).toISOString(),
    status: 'scheduled', platform_post_id: null, is_thread_start: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  seed('queue_jobs', {
    id: 'qj-1', scheduled_post_id: 'sp-1', job_type: 'publish', status: 'pending', attempts: 0, max_attempts: 3,
    scheduled_for: new Date(Date.now() - 60_000).toISOString(),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
}

function seedOrg(status: string): void {
  seed('social_accounts', { id: ACCOUNT, company_id: ORG });
  seed('user_company_roles', { user_id: USER, company_id: ORG, role: 'COMPANY_ADMIN', status: 'active' });
  seed('companies', { id: ORG, status });
}

function job(attemptsMade = 0): Job<any> {
  return {
    id: 'qj-1',
    data: { scheduled_post_id: 'sp-1', social_account_id: ACCOUNT, user_id: USER },
    attemptsMade,
    opts: { attempts: 3 },
  } as unknown as Job<any>;
}

const post = () => store.scheduled_posts.find((r) => r.id === 'sp-1')!;
const qjob = () => store.queue_jobs.find((r) => r.id === 'qj-1')!;
const tenantCheckRan = () => reads.includes('companies');

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  for (const k of Object.keys(failReads)) delete failReads[k];
  reads.length = 0;
  platformCalls.length = 0;
  writeLock = Promise.resolve();
});

describe('publishProcessor: an unreadable publishing organization never publishes', () => {
  test('org lookup DB error (returned): NO platform call, the attempt fails retryable, the post is untouched', async () => {
    seedPostAndJob();
    seedOrg('active');
    failReads.social_accounts = 'error';

    const outcome = await processPublishJob(job(0)).then(() => 'resolved', (e) => e);

    // Counted at the adapter FIRST: under the defect the post went out.
    expect(platformCalls).toEqual([]);
    expect(outcome).toMatchObject({ code: 'PUBLISHING_ORG_READ_FAILED' });
    expect(post()).toMatchObject({ status: 'scheduled', platform_post_id: null });
    // Retryable, not permanently failed: BullMQ will deliver it again.
    expect(qjob().status).not.toBe('completed');
    expect(qjob().retry_state).toBe('awaiting_retry');
  });

  test('org lookup THROWN failure (network): the same — NO platform call, retryable', async () => {
    seedPostAndJob();
    seedOrg('active');
    failReads.social_accounts = 'throw';

    const outcome = await processPublishJob(job(0)).then(() => 'resolved', (e) => e);

    expect(platformCalls).toEqual([]);
    expect(outcome).toMatchObject({ code: 'PUBLISHING_ORG_READ_FAILED' });
    expect(post().status).toBe('scheduled');
    expect(qjob().retry_state).toBe('awaiting_retry');
  });

  test('the FINAL attempt still publishes nothing and ends VISIBLY failed (bounded: retries exhausted)', async () => {
    seedPostAndJob();
    seedOrg('active');
    failReads.social_accounts = 'error';

    await expect(processPublishJob(job(2))).rejects.toMatchObject({ code: 'PUBLISHING_ORG_READ_FAILED' });

    expect(platformCalls).toEqual([]);
    expect(post()).toMatchObject({ status: 'failed', error_code: 'PUBLISHING_ORG_READ_FAILED' });
    expect(qjob()).toMatchObject({ status: 'failed', error_code: 'PUBLISHING_ORG_READ_FAILED', retry_state: 'exhausted' });
  });

  test('a cancelled queue job is never turned back into failed by an org-read failure', async () => {
    seedPostAndJob();
    qjob().status = 'cancelled';
    failReads.social_accounts = 'error';

    await expect(processPublishJob(job(2))).rejects.toMatchObject({ code: 'PUBLISHING_ORG_READ_FAILED' });

    expect(platformCalls).toEqual([]);
    expect(qjob().status).toBe('cancelled');
  });

  test('a post no longer scheduled (published elsewhere) is not overwritten as failed on the final attempt', async () => {
    seedPostAndJob();
    Object.assign(post(), { status: 'published', platform_post_id: 'plat-elsewhere' });
    failReads.social_accounts = 'error';

    await expect(processPublishJob(job(2))).rejects.toMatchObject({ code: 'PUBLISHING_ORG_READ_FAILED' });

    expect(platformCalls).toEqual([]);
    expect(post()).toMatchObject({ status: 'published', platform_post_id: 'plat-elsewhere' });
  });

  test('org truly ABSENT (no social_accounts row): today\'s behaviour — publishes with no tenant check', async () => {
    seedPostAndJob();

    await processPublishJob(job(0));

    expect(platformCalls).toEqual(['sp-1']);
    expect(tenantCheckRan()).toBe(false);
    expect(post().status).toBe('published');
  });

  test('org truly ABSENT (account row with company_id NULL): today\'s behaviour — publishes', async () => {
    seedPostAndJob();
    seed('social_accounts', { id: ACCOUNT, company_id: null });

    await processPublishJob(job(0));

    expect(platformCalls).toEqual(['sp-1']);
    expect(tenantCheckRan()).toBe(false);
  });

  test('CONTROL: org present and ACTIVE — the tenant check runs and the post publishes', async () => {
    seedPostAndJob();
    seedOrg('active');

    await processPublishJob(job(0));

    expect(tenantCheckRan()).toBe(true);
    expect(platformCalls).toEqual(['sp-1']);
    expect(post().status).toBe('published');
  });

  test('CONTROL: org present but SUSPENDED — the tenant check refuses, no platform call', async () => {
    seedPostAndJob();
    seedOrg('suspended');

    await expect(processPublishJob(job(0))).rejects.toThrow(/PUBLISH_BLOCKED_TENANT_INVALID:ORG_INACTIVE/);

    expect(tenantCheckRan()).toBe(true);
    expect(platformCalls).toEqual([]);
    expect(qjob()).toMatchObject({ status: 'failed', error_code: 'PUBLISH_BLOCKED_TENANT_INVALID' });
  });

  test('CONTROL: org present but INACTIVE (soft-deleted) — refused, no platform call', async () => {
    seedPostAndJob();
    seedOrg('inactive');

    await expect(processPublishJob(job(0))).rejects.toThrow(/PUBLISH_BLOCKED_TENANT_INVALID/);

    expect(platformCalls).toEqual([]);
  });
});
