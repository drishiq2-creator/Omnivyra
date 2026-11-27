/**
 * Phase C — durable, claimed RPA execution (rpa_retry_queue claim + worker gate
 * + synthetic handler). Real rpaRetryQueue + rpaWorkerService + rpaTaskQueue
 * over an in-memory table double whose RPCs mirror
 * 20270314000001_rpa_retry_queue_claim.sql (helpers/rpaClaimQueueDouble). The
 * SQL itself is proven by realschema/phaseCRpaClaimQueue.realschema.test.ts.
 *
 * Every refusal is paired with a CONTROL that differs in one input and must
 * reach the thing the refusal withholds (probe, handler, execution).
 */
import { createRpaClaimRpc, orFilter } from '../helpers/rpaClaimQueueDouble';

type Row = Record<string, any>;
const tables: Record<string, Row[]> = { rpa_retry_queue: [], community_ai_actions: [] };

function makeQuery(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let countMode = false;
  let single = false;
  const run = () => {
    const matched = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
    if (countMode) return { data: null, count: matched.length, error: null };
    if (single) return { data: matched[0] ?? null, error: null };
    return { data: matched.map((r) => ({ ...r })), error: null };
  };
  const q: any = {
    select: (_c?: string, opts?: { count?: string }) => { if (opts?.count) countMode = true; return q; },
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
    is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
    lte: (k: string, v: string) => { filters.push((r) => String(r[k]) <= v); return q; },
    lt: (k: string, v: number) => { filters.push((r) => Number(r[k]) < v); return q; },
    or: (expr: string) => { filters.push(orFilter(expr)); return q; },
    order: () => q,
    limit: () => q,
    maybeSingle: () => { single = true; return Promise.resolve(run()); },
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  };
  return q;
}

const queueRpc = createRpaClaimRpc(() => tables.rpa_retry_queue);
jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: jest.fn((t: string) => makeQuery(t)), rpc: jest.fn((fn: string, args: any) => queueRpc.rpc(fn, args)) },
}));

const policy = { execution_enabled: true, auto_rules_enabled: true, require_human_approval: false };
jest.mock('../../services/communityAiPlatformPolicyService', () =>
  jest.requireActual('../helpers/communityAiPolicyMock').policyServiceMock(() => policy));
jest.mock('../../services/communityAiContactGovernanceGate', () => ({
  checkCommunityActionContactGovernance: jest.fn(async () => ({ allowed: true })),
}));
jest.mock('../../services/rpaWorker/rpaEnv', () => ({
  rpaEnvReady: jest.fn(async () => ({ ok: true })),
  assertRpaEnvReady: jest.fn(async () => undefined),
  isProbeFailure: jest.fn((r: any) => r?.ok === false),
  getRpaEnvProbeDiagnostics: jest.fn(() => ({ failure_streak: 0, next_probe_in_s: 0 })),
}));
jest.mock('../../services/rpaWorker/rpaQueueState', () => ({
  admitRpaTask: jest.fn(async () => ({ admit: true, defer: false, status: 'READY', reason: null })),
  observeAllActiveOrgs: jest.fn(async () => undefined),
}));
jest.mock('../../services/rpaWorker/rpaPlatformScripts', () => ({
  buildScript: jest.fn(() => ({ targetUrl: 'https://www.linkedin.com/feed/update/urn:1', steps: [] })),
}));
jest.mock('../../services/rpaWorker/rpaPlaywrightRunner', () => ({
  runRpaScript: jest.fn(async () => ({ success: true, platform_id: 'p-1' })),
}));
jest.mock('../../queue/bullmqClient', () => ({
  withHeavyJobSlot: jest.fn((fn: () => unknown) => fn()),
}));

import { executeRpaTask, rpaSchedulerHooks, registeredRpaPlatforms, type RpaTask } from '../../services/rpaWorker/rpaWorkerService';
import {
  acceptRpaTask,
  claimRpaRetryRows,
  finalizeRpaClaim,
  flushRpaRetryQueueForOrg,
  countDueRpaRetries,
} from '../../services/rpaWorker/rpaRetryQueue';
import { runRpaScript } from '../../services/rpaWorker/rpaPlaywrightRunner';
import { rpaEnvReady } from '../../services/rpaWorker/rpaEnv';
import {
  classifySyntheticTarget,
  createSyntheticPageCheckHandler,
  SYNTHETIC_PAGE_CHECK_PLATFORM,
} from '../../services/rpaWorker/syntheticPageCheckHandler';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const ACT = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const task = (n: number, over: Partial<RpaTask> = {}): RpaTask => ({
  tenant_id: ORG, organization_id: ORG, platform: 'linkedin', action_type: 'like',
  target_url: 'https://www.linkedin.com/feed/update/urn:1', text: null, action_id: ACT(n), ...over,
});
const approvedAction = (n: number) => ({
  id: ACT(n), organization_id: ORG, status: 'approved', approved_at: '2026-11-01T00:00:00Z',
  platform: 'linkedin', action_type: 'like', target_id: 'https://www.linkedin.com/feed/update/urn:1',
});
const queueRow = (over: Row = {}): Row => ({
  id: `q-${Math.random().toString(16).slice(2)}`, action_id: ACT(1), organization_id: ORG, platform: 'linkedin',
  action_type: 'like', target_url: 'https://www.linkedin.com/feed/update/urn:1', text: null,
  attempts: 1, max_attempts: 5, last_error: null, next_retry_at: new Date(Date.now() - 60_000).toISOString(),
  claim_token: null, claimed_by: null, claimed_at: null, claim_expires_at: null, completed_at: null, ...over,
});

const ENV_KEYS = ['OMNIVYRA_BROWSER_RUNTIME', 'VERCEL', 'RPA_SYNTHETIC_HANDLER_ENABLED'] as const;
const saved: Record<string, string | undefined> = {};
const asWorker = () => { process.env.OMNIVYRA_BROWSER_RUNTIME = 'worker'; delete process.env.VERCEL; };
const asVercel = () => { process.env.OMNIVYRA_BROWSER_RUNTIME = 'worker'; process.env.VERCEL = '1'; };
const asWeb = () => { delete process.env.OMNIVYRA_BROWSER_RUNTIME; delete process.env.VERCEL; };

beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
let warn: jest.SpyInstance;
beforeEach(() => {
  tables.rpa_retry_queue = [];
  tables.community_ai_actions = [];
  queueRpc.calls.length = 0;
  (runRpaScript as jest.Mock).mockReset().mockImplementation(async () => ({ success: true, platform_id: 'p-1' }));
  (rpaEnvReady as jest.Mock).mockClear();
  policy.execution_enabled = true;
  asWeb();
  delete process.env.RPA_SYNTHETIC_HANDLER_ENABLED;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('Vercel / web never launches: rpa is durably queued for the worker (not attempted)', () => {
  it('VERCEL set (even with OMNIVYRA_BROWSER_RUNTIME=worker): no probe, no runner, one unclaimed due row', async () => {
    asVercel();
    const r = await executeRpaTask(task(1));
    expect(r).toMatchObject({ success: false, not_attempted: true, queued_for_worker: true });
    expect(rpaEnvReady).not.toHaveBeenCalled();
    expect(runRpaScript).not.toHaveBeenCalled();
    expect(tables.rpa_retry_queue).toHaveLength(1);
    expect(tables.rpa_retry_queue[0]).toMatchObject({ action_id: ACT(1), attempts: 0, claim_token: null });
  });

  it('a web process (runtime env unset): same — queued, never probed', async () => {
    const r = await executeRpaTask(task(2));
    expect(r.queued_for_worker).toBe(true);
    expect(rpaEnvReady).not.toHaveBeenCalled();
    expect(runRpaScript).not.toHaveBeenCalled();
  });

  it('CONTROL: on the browser worker the same task IS probed and executed', async () => {
    asWorker();
    const r = await executeRpaTask(task(3));
    expect(r.success).toBe(true);
    expect(rpaEnvReady).toHaveBeenCalledTimes(1);
    expect(runRpaScript).toHaveBeenCalledTimes(1);
  });
});

describe('the in-memory queue is not the only record: durable row first, born claimed', () => {
  it('while the handler runs, the action already has a claimed durable row', async () => {
    asWorker();
    let seen: Row | undefined;
    (runRpaScript as jest.Mock).mockImplementation(async () => {
      seen = { ...tables.rpa_retry_queue.find((r) => r.action_id === ACT(4)) };
      return { success: true };
    });
    await executeRpaTask(task(4));
    expect(seen).toBeDefined();
    expect(seen!.claim_token).toEqual(expect.any(String));
    expect(seen!.claimed_by).toEqual(expect.stringContaining(':'));
    // after: success tombstone, claim released
    expect(tables.rpa_retry_queue[0]).toMatchObject({ claim_token: null, attempts: 5, last_error: null });
    expect(tables.rpa_retry_queue[0].completed_at).toEqual(expect.any(String));
  });

  it('a process that dies mid-run leaves a claim that expires and is PARKED unknown, never re-run', async () => {
    asWorker();
    // the dead process: born-claimed row whose lease has run out
    tables.rpa_retry_queue = [queueRow({
      attempts: 0, claim_token: 'dead-token', claimed_by: 'host:1', claimed_at: new Date(Date.now() - 3_600_000).toISOString(),
      claim_expires_at: new Date(Date.now() - 1_000).toISOString(),
    })];
    tables.community_ai_actions = [approvedAction(1)];
    expect((await countDueRpaRetries()).due).toBe(1); // the expired claim brings the tick in
    const out = await rpaSchedulerHooks.flushRetries();
    expect(out.parked_expired).toBe(1);
    expect(runRpaScript).not.toHaveBeenCalled();
    expect(tables.rpa_retry_queue[0].last_error).toMatch(/^RPA_OUTCOME_UNKNOWN:CLAIM_EXPIRED claimed_by=host:1/);
    expect(tables.rpa_retry_queue[0].attempts).toBe(5);
    await rpaSchedulerHooks.flushRetries();
    expect(runRpaScript).not.toHaveBeenCalled();
  });

  it('CONTROL: the same row, unclaimed and due, IS executed by the flush', async () => {
    asWorker();
    tables.rpa_retry_queue = [queueRow({ attempts: 0 })];
    tables.community_ai_actions = [approvedAction(1)];
    const out = await rpaSchedulerHooks.flushRetries();
    expect(out.succeeded).toBe(1);
    expect(runRpaScript).toHaveBeenCalledTimes(1);
  });

  it('a claim that has NOT expired is neither parked nor re-run (another worker holds it)', async () => {
    asWorker();
    tables.rpa_retry_queue = [queueRow({
      claim_token: 'live', claimed_by: 'other:2', claimed_at: new Date().toISOString(),
      claim_expires_at: new Date(Date.now() + 600_000).toISOString(),
    })];
    tables.community_ai_actions = [approvedAction(1)];
    const out = await rpaSchedulerHooks.flushRetries();
    expect(out.skipped_empty).toBe(1);
    expect(runRpaScript).not.toHaveBeenCalled();
    expect(tables.rpa_retry_queue[0].claim_token).toBe('live');
  });
});

describe('idempotency: one execution per action id', () => {
  it('a duplicate enqueue of a finished action is a no-op (handler runs once)', async () => {
    asWorker();
    const first = await executeRpaTask(task(5));
    const second = await executeRpaTask(task(5));
    expect(first.success).toBe(true);
    expect(second).toMatchObject({ success: false, duplicate: true, not_attempted: true, error: 'RPA_TASK_ALREADY_QUEUED' });
    expect(runRpaScript).toHaveBeenCalledTimes(1);
    expect(tables.rpa_retry_queue).toHaveLength(1);
  });

  it('a duplicate while the first is still running is a no-op too', async () => {
    asWorker();
    let release!: () => void;
    (runRpaScript as jest.Mock).mockImplementation(() => new Promise((res) => { release = () => res({ success: true }); }));
    const first = executeRpaTask(task(6));
    await new Promise((r) => setImmediate(r));
    const second = await executeRpaTask(task(6));
    expect(second.duplicate).toBe(true);
    release();
    expect((await first).success).toBe(true);
    expect(runRpaScript).toHaveBeenCalledTimes(1);
  });

  it('web-queued then worker flush: the worker run is the only run; re-queue after it is a no-op', async () => {
    await executeRpaTask(task(7)); // web: queued
    tables.community_ai_actions = [approvedAction(7)];
    asWorker();
    const out = await rpaSchedulerHooks.flushRetries();
    expect(out.succeeded).toBe(1);
    asWeb();
    const again = await executeRpaTask(task(7));
    expect(again.duplicate).toBe(true);
    asWorker();
    await rpaSchedulerHooks.flushRetries();
    expect(runRpaScript).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: a different action id is accepted and executed', async () => {
    asWorker();
    await executeRpaTask(task(8));
    await executeRpaTask(task(9));
    expect(runRpaScript).toHaveBeenCalledTimes(2);
    expect(tables.rpa_retry_queue).toHaveLength(2);
  });
});

describe('claim: overlapping flushes get disjoint rows; finalisation needs the token', () => {
  it('two concurrent per-org flushes execute every row exactly once', async () => {
    asWorker();
    tables.rpa_retry_queue = [1, 2, 3, 4].map((n) => queueRow({ action_id: ACT(n), id: `q${n}` }));
    const executed: string[] = [];
    const handler = async (t: RpaTask) => { executed.push(t.action_id); await new Promise((r) => setImmediate(r)); return { success: true }; };
    const [a, b] = await Promise.all([
      flushRpaRetryQueueForOrg({ organization_id: ORG, handler, limit: 3, worker: 'A' }),
      flushRpaRetryQueueForOrg({ organization_id: ORG, handler, limit: 3, worker: 'B' }),
    ]);
    // CONTROL inside: both flushes really claimed work (the overlap exists)
    expect(a.claimed).toBeGreaterThan(0);
    expect(b.claimed).toBeGreaterThan(0);
    expect(a.claimed + b.claimed).toBe(4);
    expect(executed.sort()).toEqual([ACT(1), ACT(2), ACT(3), ACT(4)]);
  });

  it('a finaliser with the wrong token is refused and writes nothing', async () => {
    tables.rpa_retry_queue = [queueRow({ id: 'q1' })];
    const { rows } = await claimRpaRetryRows({ worker: 'A', limit: 1 });
    expect(rows).toHaveLength(1);
    const before = { ...tables.rpa_retry_queue[0] };
    const r = await finalizeRpaClaim({ queue_id: 'q1', claim_token: 'not-the-token' }, 'succeeded');
    expect(r).toBe('token_mismatch');
    expect(tables.rpa_retry_queue[0]).toEqual(before);
    // CONTROL: the real token finalises
    expect(await finalizeRpaClaim({ queue_id: 'q1', claim_token: rows[0].claim_token }, 'succeeded')).toBe('finalized');
    expect(tables.rpa_retry_queue[0].completed_at).toEqual(expect.any(String));
  });

  it('a definite failure is rescheduled (attempts+1, backoff), an unknown is parked, a terminal is retired', async () => {
    tables.rpa_retry_queue = [queueRow({ id: 'f', action_id: ACT(1) }), queueRow({ id: 'u', action_id: ACT(2) }), queueRow({ id: 't', action_id: ACT(3) })];
    const handler = async (t: RpaTask) => (t.action_id === ACT(1) ? { success: false, error: 'RPA_TIMEOUT' }
      : t.action_id === ACT(2) ? { success: false, outcome_unknown: true, error: 'RPA_OUTCOME_UNKNOWN:lost' }
        : { success: false, terminal: true, error: 'RPA_RETRY_CONTACT_SUPPRESSED' });
    const out = await flushRpaRetryQueueForOrg({ organization_id: ORG, handler, worker: 'A' });
    expect(out).toMatchObject({ claimed: 3, failed: 2, unknown: 1, errors: 0 });
    const byId = (id: string) => tables.rpa_retry_queue.find((r) => r.id === id)!;
    expect(byId('f')).toMatchObject({ attempts: 2, claim_token: null, last_error: 'RPA_TIMEOUT' });
    expect(Date.parse(byId('f').next_retry_at)).toBeGreaterThan(Date.now() + 3 * 60_000);
    expect(byId('u')).toMatchObject({ attempts: 5, last_error: 'RPA_OUTCOME_UNKNOWN:lost' });
    expect(byId('t')).toMatchObject({ attempts: 5, last_error: 'RPA_RETRY_CONTACT_SUPPRESSED' });
  });

  it('the flush on a non-worker process claims nothing and never probes', async () => {
    tables.rpa_retry_queue = [queueRow()];
    tables.community_ai_actions = [approvedAction(1)];
    const out = await rpaSchedulerHooks.flushRetries();
    expect(out).toMatchObject({ skipped_runtime: 1, claimed: 0 });
    expect(rpaEnvReady).not.toHaveBeenCalled();
    expect(queueRpc.calls.filter((c) => c.fn === 'claim_rpa_retry_queue')).toHaveLength(0);
    // CONTROL: the same row on the worker is claimed and run
    asWorker();
    const ok = await rpaSchedulerHooks.flushRetries();
    expect(ok.claimed).toBe(1);
    expect(rpaEnvReady).toHaveBeenCalled();
  });

  it('a worker env not ready after the claim releases the row as a retry (not attempted), never runs it', async () => {
    asWorker();
    (rpaEnvReady as jest.Mock).mockImplementationOnce(async () => ({ ok: false, reason: 'no chromium' }));
    const r = await executeRpaTask(task(10));
    expect(r).toMatchObject({ success: false, not_attempted: true });
    expect(runRpaScript).not.toHaveBeenCalled();
    expect(tables.rpa_retry_queue[0]).toMatchObject({ attempts: 1, claim_token: null });
    expect(tables.rpa_retry_queue[0].last_error).toMatch(/^RPA_ENV_NOT_READY/);
  });

  it('acceptRpaTask reports a read failure as an error, never as "accepted"', async () => {
    const { supabase } = jest.requireMock('../../db/supabaseClient');
    (supabase.rpc as jest.Mock).mockImplementationOnce(async () => ({ data: null, error: null }));
    const r = await acceptRpaTask(task(11));
    expect(r).toEqual({ ok: false, error: 'RPA_ACCEPT_NO_RESULT' });
  });
});

describe('synthetic_page_check handler (no real platform)', () => {
  it('registry: real platform handlers unchanged, plus only the synthetic entry', () => {
    expect(registeredRpaPlatforms()).toEqual(['facebook', 'instagram', 'linkedin', 'reddit', SYNTHETIC_PAGE_CHECK_PLATFORM, 'twitter'].sort());
  });

  it.each([
    ['https://www.linkedin.com/feed/', 'SYNTHETIC_TARGET_HOST_REFUSED'],
    ['http://127.0.0.1.evil.example/', 'SYNTHETIC_TARGET_HOST_REFUSED'],
    ['http://localhost@evil.example/', 'SYNTHETIC_TARGET_USERINFO_REFUSED'],
    ['http://user:pw@localhost/', 'SYNTHETIC_TARGET_USERINFO_REFUSED'],
    ['http://[::1]/', 'SYNTHETIC_TARGET_HOST_REFUSED'],
    ['file:///etc/passwd', 'SYNTHETIC_TARGET_SCHEME_REFUSED'],
    ['javascript:alert(1)', 'SYNTHETIC_TARGET_SCHEME_REFUSED'],
    ['not a url', 'SYNTHETIC_TARGET_INVALID'],
  ])('refuses %s', (url, code) => {
    expect(classifySyntheticTarget(url)).toEqual({ ok: false, error: code });
  });

  it.each([
    ['data:text/plain,ok', 'data'],
    ['http://127.0.0.1:4010/health', 'loopback'],
    ['http://localhost/check', 'loopback'],
    ['https://LOCALHOST:8443/x', 'loopback'],
  ])('CONTROL: accepts %s', (url, kind) => {
    expect(classifySyntheticTarget(url)).toMatchObject({ ok: true, kind });
  });

  it('is off unless enabled (terminal, nothing fetched); CONTROL: enabled, a loopback 200 succeeds', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 200 }));
    const off = createSyntheticPageCheckHandler({ env: {}, fetchImpl });
    expect(await off(task(1, { platform: SYNTHETIC_PAGE_CHECK_PLATFORM, target_url: 'http://127.0.0.1/' })))
      .toEqual({ success: false, terminal: true, error: 'SYNTHETIC_HANDLER_DISABLED' });
    expect(fetchImpl).not.toHaveBeenCalled();
    const on = createSyntheticPageCheckHandler({ env: { RPA_SYNTHETIC_HANDLER_ENABLED: 'true' }, fetchImpl });
    expect((await on(task(1, { platform: SYNTHETIC_PAGE_CHECK_PLATFORM, target_url: 'http://127.0.0.1/' }))).success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1/', expect.objectContaining({ method: 'GET', redirect: 'error' }));
  });

  it('a non-loopback target never reaches fetch even when enabled', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 200 }));
    const on = createSyntheticPageCheckHandler({ env: { RPA_SYNTHETIC_HANDLER_ENABLED: 'true' }, fetchImpl });
    const r = await on(task(1, { platform: SYNTHETIC_PAGE_CHECK_PLATFORM, target_url: 'https://www.linkedin.com/' }));
    expect(r).toEqual({ success: false, terminal: true, error: 'SYNTHETIC_TARGET_HOST_REFUSED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('END TO END: web enqueue -> worker claim -> synthetic execute -> outcome recorded -> claim released', async () => {
    process.env.RPA_SYNTHETIC_HANDLER_ENABLED = 'true';
    const t = task(20, { platform: SYNTHETIC_PAGE_CHECK_PLATFORM, target_url: 'data:text/plain,pipeline-ok' });
    const queued = await executeRpaTask(t); // web process
    expect(queued.queued_for_worker).toBe(true);
    tables.community_ai_actions = [{ ...approvedAction(20), platform: SYNTHETIC_PAGE_CHECK_PLATFORM, target_id: t.target_url }];
    asWorker();
    const out = await rpaSchedulerHooks.flushRetries();
    expect(out).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, unknown: 0, errors: 0 });
    expect(runRpaScript).not.toHaveBeenCalled(); // no browser, no platform script
    expect(queueRpc.calls.map((c) => c.fn)).toEqual([
      'rpa_retry_queue_accept', 'park_expired_rpa_retry_claims', 'claim_rpa_retry_queue', 'finalize_rpa_retry_queue_claim',
    ]);
    expect(tables.rpa_retry_queue[0]).toMatchObject({ claim_token: null, attempts: 5, last_error: null });
    expect(tables.rpa_retry_queue[0].completed_at).toEqual(expect.any(String));
  });

  it('END TO END (worker direct path): synthetic data: target executes once and is tombstoned', async () => {
    process.env.RPA_SYNTHETIC_HANDLER_ENABLED = 'true';
    asWorker();
    const r = await executeRpaTask(task(21, { platform: SYNTHETIC_PAGE_CHECK_PLATFORM, target_url: 'data:text/plain,x' }));
    expect(r).toMatchObject({ success: true, platform_id: 'synthetic:data:1' });
    expect(tables.rpa_retry_queue[0].completed_at).toEqual(expect.any(String));
    expect(runRpaScript).not.toHaveBeenCalled();
  });
});
