/**
 * e9 ruling 2026-11-14: resolveTenantOfRow THROWS a retryable TenantSeamError('TENANT_PARENT_UNREADABLE') when the
 * tenant read FAILS (it used to answer null, so a job silently skipped the row). For every caller this pins:
 *   - the failure reaches the caller's retry path (propagates retryable, or is caught + logged as tenant_row_unreadable);
 *   - it is NOT mapped onto the caller's "absent" outcome (its not-found error / skip);
 *   - nothing is written after it (the store records every op; a swallowed failure cannot pass silently).
 *
 * The store double: every table read/write is recorded. A `select(<tenant column>)` on a table in `unreadable` that
 * ends in maybeSingle() answers a statement timeout (57014); every other terminal answers { data: null, error: null }.
 */
type Op = { table: string; op: string; args: unknown[] };
const ops: Op[] = [];
const unreadable = new Set<string>();
const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

function builder(table: string): any {
  const mine: Op[] = [];
  const terminal = async () => {
    const first = mine[0];
    const isTenantRead = first?.op === 'select' && first.args[0] === 'company_id' && mine.some((o) => o.op === 'eq' && o.args[0] === 'id');
    if (isTenantRead && unreadable.has(table)) return { data: null, error: TIMEOUT };
    return { data: null, error: null };
  };
  const b: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => terminal().then(ok, ko);
      }
      if (prop === 'maybeSingle' || prop === 'single') {
        return () => { const o = { table, op: prop, args: [] }; ops.push(o); mine.push(o); return terminal(); };
      }
      return (...args: unknown[]) => { const o = { table, op: prop, args }; ops.push(o); mine.push(o); return b; };
    },
  });
  return b;
}

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (t: string) => builder(t),
  ownedDbRpc: async () => ({ data: null, error: null }),
}));
jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) },
}));

import { TenantSeamError } from '../../db/tenantTable';
import { acquireRunLock, extendRunLock, releaseRunLock } from '../../services/boltExecutionLock';
import { updateRun, assertCampaignValid, runSourceRecommendation } from '../../services/boltPipelineServiceModel';
import { BoltError } from '../../../lib/shared/bolt/boltErrorCodes';
import { markThemeConsumedForCampaign, releaseThemeFromCampaign } from '../../services/companyThemeStateService';
import { saveWeekPlans, insertActivity } from '../../services/executionPlannerPersistence';
import { writeExecutionItem } from '../../services/orchestration/canonicalExecutionAdapter';
import { executePublishingJob } from '../../services/publishingJobService';
import { queueBoltContentJobs, processCreatorStructuredSchedule } from '../../services/structuredPlanSchedulerExecWeeklyA';
import { scheduleStructuredPlan } from '../../services/structuredPlanSchedulerExecWeeklyB';
import { scheduleCreatorAttachmentPost } from '../../services/creator/creatorRowScheduler';

const ID = '0b0b0b0b-0000-4000-8000-000000000001';
const COMPANY = 'c0c0c0c0-0000-4000-8000-000000000001';
const WRITES = new Set(['insert', 'upsert', 'update', 'delete']);
const writes = () => ops.filter((o) => WRITES.has(o.op));
const tablesTouched = () => [...new Set(ops.map((o) => o.table))];

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e);
}
function expectRetryable(err: unknown) {
  expect(err).toBeInstanceOf(TenantSeamError);
  expect((err as TenantSeamError).code).toBe('TENANT_PARENT_UNREADABLE');
  expect((err as TenantSeamError).retryable).toBe(true);
}

let warn: jest.SpyInstance;
let log: jest.SpyInstance;
let error: jest.SpyInstance;
beforeEach(() => {
  ops.length = 0;
  unreadable.clear();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { warn.mockRestore(); log.mockRestore(); error.mockRestore(); });

describe('boltExecutionLock (bolt_execution_runs tenant read fails)', () => {
  beforeEach(() => unreadable.add('bolt_execution_runs'));
  it('acquireRunLock propagates retryable (not null = "another worker holds it") and claims nothing', async () => {
    expectRetryable(await caught(acquireRunLock(ID)));
    expect(writes()).toEqual([]);
    expect(error).not.toHaveBeenCalledWith('[bolt/lock] acquire refused: run has no resolvable tenant', expect.anything());
  });
  it('extendRunLock propagates retryable (not false = "lock lost")', async () => {
    expectRetryable(await caught(extendRunLock(ID, 'tok')));
    expect(writes()).toEqual([]);
  });
  it('releaseRunLock never throws: logs tenant_row_unreadable, writes nothing, lock left to its TTL', async () => {
    await expect(releaseRunLock(ID, 'tok')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('tenant_row_unreadable', expect.objectContaining({ table: 'bolt_execution_runs', id: ID, caller: 'releaseRunLock' }));
    expect(warn).not.toHaveBeenCalledWith('[bolt/lock] release failed (non-fatal): run has no resolvable tenant', expect.anything());
    expect(writes()).toEqual([]);
  });
});

describe('boltPipelineServiceModel', () => {
  it('updateRun: run tenant unreadable -> retryable seam error, not RUN_UPDATE_FAILED; no write', async () => {
    unreadable.add('bolt_execution_runs');
    const err = await caught(updateRun(ID, { status: 'running' } as never));
    expectRetryable(err);
    expect(err).not.toBeInstanceOf(BoltError);
    expect(writes()).toEqual([]);
  });
  it('assertCampaignValid: campaign tenant unreadable -> retryable, not SCHEDULING_CAMPAIGN_NOT_FOUND', async () => {
    unreadable.add('campaigns');
    const err = await caught(assertCampaignValid(ID));
    expectRetryable(err);
    expect(err).not.toBeInstanceOf(BoltError);
  });
  it('runSourceRecommendation: campaign tenant unreadable -> retryable, not CAMPAIGN_VERSION_NOT_FOUND; nothing written', async () => {
    unreadable.add('campaigns');
    const err = await caught(runSourceRecommendation(ID, { companyId: COMPANY, userId: ID, generatedCampaignId: ID } as never));
    expectRetryable(err);
    expect(err).not.toBeInstanceOf(BoltError);
    expect(writes()).toEqual([]);
    expect(tablesTouched()).not.toContain('campaign_versions');
  });
});

describe('companyThemeStateService (campaign tenant read fails)', () => {
  beforeEach(() => unreadable.add('campaigns'));
  it('markThemeConsumedForCampaign: logged as unreadable (not "skipped"), nothing written, never throws', async () => {
    await expect(markThemeConsumedForCampaign(ID)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('tenant_row_unreadable', expect.objectContaining({ table: 'campaigns', id: ID, caller: 'markThemeConsumedForCampaign' }));
    expect(warn).not.toHaveBeenCalledWith('companyThemeStateService: mark CONSUMED skipped (campaign has no resolvable tenant)', expect.anything());
    expect(writes()).toEqual([]);
  });
  it('releaseThemeFromCampaign: rethrows retryable (the DELETE answers 503 before any destructive step), logged', async () => {
    expectRetryable(await caught(releaseThemeFromCampaign(ID)));
    expect(warn).toHaveBeenCalledWith('tenant_row_unreadable', expect.objectContaining({ table: 'campaigns', id: ID, caller: 'releaseThemeFromCampaign' }));
    expect(warn).not.toHaveBeenCalledWith('companyThemeStateService: releaseThemeFromCampaign skipped (campaign has no resolvable tenant)', expect.anything());
    expect(writes()).toEqual([]);
  });
  it('control: an ABSENT campaign is still the logged skip, not a throw', async () => {
    unreadable.clear();
    await expect(releaseThemeFromCampaign(ID)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('companyThemeStateService: releaseThemeFromCampaign skipped (campaign has no resolvable tenant)', expect.anything());
  });
});

describe('executionPlannerPersistence (campaign tenant read fails)', () => {
  beforeEach(() => unreadable.add('campaigns'));
  it('saveWeekPlans propagates retryable BEFORE the week delete (the week is not lost)', async () => {
    expectRetryable(await caught(saveWeekPlans(ID, 1, [], 'manual')));
    expect(writes()).toEqual([]);
    expect(tablesTouched()).not.toContain('daily_content_plans');
  });
  it('insertActivity propagates retryable; nothing inserted', async () => {
    expectRetryable(await caught(insertActivity({ campaign_id: ID } as never, 'board')));
    expect(writes()).toEqual([]);
  });
});

describe('canonicalExecutionAdapter (campaign tenant read fails)', () => {
  it('writeExecutionItem -> { ok: false } with the unreadable reason (never row_not_found), logged, nothing written', async () => {
    unreadable.add('campaigns');
    const res = await writeExecutionItem(ID, 'exec-1', { title: 't' });
    expect(res.ok).toBe(false);
    expect(String((res as { reason?: string }).reason)).toMatch(/TENANT_PARENT_UNREADABLE/);
    expect(log).toHaveBeenCalledWith('[tenant_row_unreadable]', expect.stringContaining('"caller":"canonicalExecutionAdapter.planRowWriteHandle"'));
    expect(log).not.toHaveBeenCalledWith('[ORCHESTRATION_WRITE]', expect.stringContaining('row_not_found'));
    expect(writes()).toEqual([]);
  });
});

describe('publishingJobService (publishing_jobs tenant read fails)', () => {
  it('executePublishingJob propagates retryable BEFORE the claim (job stays queued for the worker tick)', async () => {
    unreadable.add('publishing_jobs');
    const err = await caught(executePublishingJob(ID));
    expectRetryable(err);
    expect((err as Error).message).not.toMatch(/not found or not claimable/);
    expect(writes()).toEqual([]);
  });
});

describe('structured plan scheduler (campaign tenant read fails)', () => {
  beforeEach(() => unreadable.add('campaigns'));
  const plans = [{ id: 'r1', campaign_id: ID, week_number: 1, day_of_week: 'Monday', date: '2099-01-05', platform: 'linkedin', content_type: 'post', title: 'T', topic: 'T', content: '{}' }];
  it('queueBoltContentJobs propagates retryable (logged) before any job/slot row is written', async () => {
    const err = await caught(queueBoltContentJobs(ID, ID, plans as never, { start_date: '2099-01-05', user_id: ID, company_id: COMPANY }, new Map([['linkedin', 'acct']]), {}, (p: string) => p));
    expectRetryable(err);
    expect(warn).toHaveBeenCalledWith('tenant_row_unreadable', expect.objectContaining({ table: 'campaigns', id: ID, caller: 'structuredPlanSchedulerExecWeeklyA.campaignTenant' }));
    expect(writes()).toEqual([]);
  });
  it('processCreatorStructuredSchedule propagates retryable before any plan row is touched', async () => {
    const err = await caught(processCreatorStructuredSchedule({
      campaignId: ID, companyId: COMPANY, userId: ID, dailyPlans: plans as never, accountMap: new Map(), normalize: (p: string) => p,
      typeMapByPlatform: {}, currentPlanVersion: 1,
    }));
    expectRetryable(err);
    expect(writes()).toEqual([]);
  });
  it('scheduleStructuredPlan: retryable, not SCHEDULING_CAMPAIGN_NOT_FOUND; nothing scheduled', async () => {
    const err = await caught(scheduleStructuredPlan({ weeks: [{ week: 1 }] } as never, ID));
    expectRetryable(err);
    expect(err).not.toBeInstanceOf(BoltError);
    expect(writes()).toEqual([]);
  });
});

describe('creatorRowScheduler (campaign tenant read fails)', () => {
  it("scheduleCreatorAttachmentPost -> status 'error' (row untouched, next run retries), logged; no scheduled_posts insert", async () => {
    unreadable.add('campaigns');
    const res = await scheduleCreatorAttachmentPost({
      row: { id: 'row-1', campaign_id: ID, date: '2099-01-05', content_type: 'video' },
      attachedContent: { uploaded_media_url: 'https://cdn.example.test/v.mp4' },
      userId: ID, campaignId: ID, platform: 'linkedin', socialAccountId: 'acct', dbPlatform: 'linkedin', dbContentType: 'video',
    });
    expect(res.status).toBe('error');
    expect(String(res.reason)).toMatch(/TENANT_PARENT_UNREADABLE/);
    expect(warn).toHaveBeenCalledWith('tenant_row_unreadable', expect.objectContaining({ table: 'campaigns', id: ID, caller: 'creatorRowScheduler.campaignTenant' }));
    expect(writes()).toEqual([]);
  });
});
