/**
 * 24C — RPA retry flush noise + safety.
 *
 * Production 2026-11-26: every 90 s `[rpaRetryQueueFlush] skipped — RPA env
 * not ready: browserType.launch: Target page, context or browser has been
 * closed` + a multi-line call log, with 0 rows in rpa_retry_queue. The flush
 * probed Chromium (rpaEnvReady) BEFORE looking for due rows and before the
 * kill switch, and re-logged the cached failure on every tick.
 *
 * Real flushRetries + real rpaEnv (backoff/cache/logging) + real
 * flushRpaRetryQueueRoundRobin + real rpaTaskQueue over an in-memory table
 * double. Playwright is a fake module injected through the rpaEnv loader seam;
 * no browser is ever launched. Only the runner (runRpaScript) is stubbed.
 *
 * Every refusal is paired with a positive control proving the scenario
 * exists (the same harness DOES probe / execute when it should).
 */

type Row = Record<string, any>;
const tables: Record<string, Row[]> = { rpa_retry_queue: [], community_ai_actions: [] };

function makeQuery(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: 'select' | 'delete' | 'update' = 'select';
  let patch: Row = {};
  let countMode = false;
  let single = false;
  const run = () => {
    const rows = tables[table] || [];
    const matched = rows.filter((r) => filters.every((f) => f(r)));
    if (op === 'delete') {
      tables[table] = rows.filter((r) => !matched.includes(r));
      return { data: null, error: null };
    }
    if (op === 'update') {
      matched.forEach((r) => Object.assign(r, patch));
      return { data: null, error: null };
    }
    if (countMode) return { data: null, count: matched.length, error: null };
    if (single) return { data: matched[0] ?? null, error: null };
    return { data: matched.map((r) => ({ ...r })), error: null };
  };
  const q: any = {
    select: (_cols?: string, opts?: { count?: string }) => {
      if (opts?.count) countMode = true;
      return q;
    },
    delete: () => { op = 'delete'; return q; },
    update: (p: Row) => { op = 'update'; patch = p; return q; },
    insert: () => Promise.resolve({ error: null }),
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
    lte: (k: string, v: string) => { filters.push((r) => String(r[k]) <= v); return q; },
    lt: (k: string, v: number) => { filters.push((r) => Number(r[k]) < v); return q; },
    order: () => q,
    limit: () => q,
    maybeSingle: () => { single = true; return Promise.resolve(run()); },
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  };
  return q;
}

jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: jest.fn((t: string) => makeQuery(t)), rpc: jest.fn() },
}));

const policy = { execution_enabled: true, auto_rules_enabled: true, require_human_approval: false };
const policyRead = jest.fn(async () => ({ ...policy, updated_at: null, updated_by: null }));
// Round 28: the real fail-closed evaluator decides over this value (configured row unless stated).
jest.mock('../../services/communityAiPlatformPolicyService', () =>
  jest.requireActual('../helpers/communityAiPolicyMock').policyServiceMock(() => policyRead()));
jest.mock('../../services/rpaWorker/rpaQueueState', () => ({
  admitRpaTask: jest.fn(async () => ({ admit: true })),
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

import { rpaSchedulerHooks } from '../../services/rpaWorker/rpaWorkerService';
import { runRpaScript } from '../../services/rpaWorker/rpaPlaywrightRunner';
import * as rpaEnv from '../../services/rpaWorker/rpaEnv';
import { startRpaWorker, enqueueRpaTask } from '../../services/rpaWorker/rpaTaskQueue';

const ORG = 'org-1';
// Fixture clock drives BOTH Date.now() and `new Date()` (the queue queries
// use new Date().toISOString()); a Date.now-only spy would mix in the real clock.
const T0 = Date.parse('2030-01-01T10:00:00Z');
let now = T0;
const setNow = (t: number) => { now = t; jest.setSystemTime(t); };
const advance = (ms: number) => setNow(now + ms);

// Multi-line Playwright launch error as seen in production.
const PW_LAUNCH_ERROR = [
  'browserType.launch: Target page, context or browser has been closed',
  'Browser logs:',
  '<launching> /ms-playwright/chromium_headless_shell-1217/chrome-linux/headless_shell --disable-field-trial-config',
  '<launched> pid=123',
  '[pid=123][err] Received signal 5 SIGTRAP',
  'Call log:',
  '  - <launching> /ms-playwright/chromium_headless_shell',
  '  - <launched> pid=123',
  '  - [pid=123] <process did exit: exitCode=null, signal=SIGTRAP>',
  '  - [pid=123] starting temporary directories deletion',
].join('\n');

let launchFails = true;
const launch = jest.fn(async () => {
  if (launchFails) throw new Error(PW_LAUNCH_ERROR);
  return { close: jest.fn(async () => undefined) };
});

function dueRow(extra: Row = {}): Row {
  return {
    id: 'rq-1',
    action_id: 'act-1',
    organization_id: ORG,
    platform: 'linkedin',
    action_type: 'like',
    target_url: 'https://www.linkedin.com/feed/update/urn:1',
    text: null,
    attempts: 1,
    max_attempts: 5,
    next_retry_at: new Date(T0 - 60_000).toISOString(),
    ...extra,
  };
}
function seed(rows: Row[], action: Row | null) {
  tables.rpa_retry_queue = rows;
  tables.community_ai_actions = action ? [{ id: 'act-1', organization_id: ORG, ...action }] : [];
}
const APPROVED = { status: 'failed', approved_at: '2026-11-01T00:00:00Z' };

let warn: jest.SpyInstance;
let log: jest.SpyInstance;
const lines = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => c.map(String).join(' '));

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'],
  });
  setNow(T0);
  rpaEnv.__resetRpaEnvStateForTests();
  rpaEnv.__setRpaPlaywrightLoaderForTests(async () => ({ chromium: { launch } }));
  launch.mockClear();
  launchFails = true;
  policyRead.mockClear();
  policy.execution_enabled = true;
  (runRpaScript as jest.Mock).mockReset();
  (runRpaScript as jest.Mock).mockImplementation(async () => ({ success: true, platform_id: 'p-1' }));
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  rpaEnv.__setRpaPlaywrightLoaderForTests(null);
});

describe('24C (a) empty queue never probes', () => {
  it('no due rows: no Chromium launch, no policy read, silent, skipped_empty=1', async () => {
    seed([], null);
    const outs = [];
    for (let i = 0; i < 5; i += 1) {
      outs.push(await rpaSchedulerHooks.flushRetries({ limit_per_org: 10, max_orgs: 100 }));
      advance(90_000);
    }
    // behaviour first (what the old code violated), diagnostics after
    expect(launch).not.toHaveBeenCalled();
    expect(policyRead).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    for (const out of outs) expect(out).toMatchObject({ skipped_empty: 1, claimed: 0 });
  });

  it('rows exist but none due yet (future next_retry_at): no probe', async () => {
    seed([dueRow({ next_retry_at: new Date(T0 + 3_600_000).toISOString() })], APPROVED);
    await rpaSchedulerHooks.flushRetries();
    expect(launch).not.toHaveBeenCalled();
  });

  it('CONTROL: one due row DOES probe (the launch spy is wired)', async () => {
    seed([dueRow()], APPROVED);
    const out = await rpaSchedulerHooks.flushRetries();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(runRpaScript).not.toHaveBeenCalled();
    expect(out).toMatchObject({ skipped_env: 1, due: 1 });
  });
});

describe('24C (b) failed probe backs off and logs once per real probe', () => {
  it('ticks inside the backoff window neither relaunch nor log; the one line is single-line', async () => {
    seed([dueRow()], APPROVED);
    const outs = [];
    for (const t of [0, 30_000, 60_000, 89_000]) {
      setNow(T0 + t);
      outs.push(await rpaSchedulerHooks.flushRetries());
    }
    expect(launch).toHaveBeenCalledTimes(1);
    const w = lines(warn);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('[rpaEnv] probe failed (streak=1); next probe in 90s');
    expect(w[0]).toContain('browserType.launch: Target page, context or browser has been closed');
    expect(w[0]).not.toMatch(/\n/);
    // nothing about the queue is touched while the env is down
    expect(runRpaScript).not.toHaveBeenCalled();
    expect(tables.rpa_retry_queue[0].attempts).toBe(1);
    for (const out of outs) expect(out.skipped_env).toBe(1);
  });

  it('the cached reason handed to callers is the first line only (no call log)', async () => {
    const r = await rpaEnv.rpaEnvReady();
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('browserType.launch: Target page, context or browser has been closed');
  });

  it('backoff doubles 90s -> 180s -> 360s ... and is capped at 30 min', async () => {
    seed([dueRow()], APPROVED);
    const expected = [90, 180, 360, 720, 1440, 1800, 1800];
    const outs = [];
    for (let i = 0; i < expected.length; i += 1) {
      outs.push(await rpaSchedulerHooks.flushRetries());
      expect(launch).toHaveBeenCalledTimes(i + 1);
      // one tick before expiry: no relaunch
      advance(expected[i] * 1000 - 1000);
      await rpaSchedulerHooks.flushRetries();
      expect(launch).toHaveBeenCalledTimes(i + 1);
      advance(1000);
    }
    expect(lines(warn)).toHaveLength(expected.length);
    outs.forEach((out, i) => expect(out).toMatchObject({ env_failure_streak: i + 1, env_next_probe_in_s: expected[i] }));
    expect(rpaEnv.rpaEnvFailureBackoffMs(50)).toBe(30 * 60 * 1000);
  });

  it('a day of 90 s ticks with a permanently broken env: <= 60 probes/log lines (was 960 lines)', async () => {
    seed([dueRow()], APPROVED);
    const ticks = (24 * 3600) / 90;
    for (let i = 0; i < ticks; i += 1) {
      await rpaSchedulerHooks.flushRetries();
      advance(90_000);
    }
    expect(ticks).toBe(960);
    expect(launch.mock.calls.length).toBeLessThanOrEqual(60);
    expect(lines(warn).length).toBe(launch.mock.calls.length);
  });

  it('concurrent callers share one in-flight probe', async () => {
    await Promise.all([rpaEnv.rpaEnvReady(), rpaEnv.rpaEnvReady(), rpaEnv.rpaEnvReady()]);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe('24C (b) recovery resets the backoff', () => {
  it('after recovery a new failure backs off from 90 s again, and recovery is logged once', async () => {
    seed([dueRow()], APPROVED);
    // three failures: 90 -> 180 -> 360
    await rpaSchedulerHooks.flushRetries();
    advance(90_000);
    await rpaSchedulerHooks.flushRetries();
    advance(180_000);
    await rpaSchedulerHooks.flushRetries();
    expect(launch).toHaveBeenCalledTimes(3);
    // env fixed
    launchFails = false;
    advance(360_000);
    const ok = await rpaSchedulerHooks.flushRetries();
    expect(launch).toHaveBeenCalledTimes(4);
    expect(runRpaScript).toHaveBeenCalledTimes(1);
    expect(ok.succeeded).toBe(1);
    expect(lines(log).filter((l) => l.includes('[rpaEnv] probe recovered'))).toHaveLength(1);
    // env breaks again after the 5-min success TTL
    launchFails = true;
    seed([dueRow({ id: 'rq-2' })], APPROVED);
    advance(5 * 60_000);
    const f = await rpaSchedulerHooks.flushRetries();
    expect(launch).toHaveBeenCalledTimes(5);
    // reset: 91 s later it probes again (an unreset streak of 4 would wait 720 s)
    advance(91_000);
    await rpaSchedulerHooks.flushRetries();
    expect(launch).toHaveBeenCalledTimes(6);
    expect(f.env_failure_streak).toBe(1);
  });
});

describe('24C (c) kill switch and approval stay before any execution', () => {
  it('due rows + kill switch off: no probe, no execution, row untouched', async () => {
    seed([dueRow()], APPROVED);
    policy.execution_enabled = false;
    const out = await rpaSchedulerHooks.flushRetries();
    expect(launch).not.toHaveBeenCalled();
    expect(runRpaScript).not.toHaveBeenCalled();
    expect(tables.rpa_retry_queue[0]).toMatchObject({ attempts: 1, next_retry_at: dueRow().next_retry_at });
    expect(policyRead).toHaveBeenCalled();
    expect(out).toMatchObject({ skipped_policy: 1, claimed: 0 });
  });

  it('unapproved action (approved_at null): refused, runner never called', async () => {
    launchFails = false;
    seed([dueRow()], { status: 'failed', approved_at: null });
    const out = await rpaSchedulerHooks.flushRetries();
    expect(runRpaScript).not.toHaveBeenCalled();
    expect(out.succeeded).toBe(0);
    expect(tables.rpa_retry_queue[0].last_error).toBe('RPA_RETRY_NOT_APPROVED');
  });

  it('CONTROL: the same row WITH approval of record is executed exactly once', async () => {
    launchFails = false;
    seed([dueRow()], APPROVED);
    const out = await rpaSchedulerHooks.flushRetries();
    expect(runRpaScript).toHaveBeenCalledTimes(1);
    expect(out.succeeded).toBe(1);
    expect(tables.rpa_retry_queue).toHaveLength(0);
  });
});

describe('24C (d) an unknown outcome is never a definite failure', () => {
  beforeEach(() => { launchFails = false; });

  it('runner reports outcome_unknown: counted unknown (not failed), row parked, never re-executed', async () => {
    (runRpaScript as jest.Mock).mockImplementation(async () => ({
      success: false, outcome_unknown: true, error: 'RPA_OUTCOME_UNKNOWN:RPA_POST_CONDITION_FAILED',
    }));
    seed([dueRow()], APPROVED);
    const out = await rpaSchedulerHooks.flushRetries();
    // old code: recorded as a failure, rescheduled 2^n min later, re-executed
    advance(3 * 3600_000);
    await rpaSchedulerHooks.flushRetries();
    expect(runRpaScript).toHaveBeenCalledTimes(1);
    expect(tables.rpa_retry_queue[0]).toMatchObject({
      attempts: 5,
      last_error: 'RPA_OUTCOME_UNKNOWN:RPA_POST_CONDITION_FAILED',
    });
    expect(out).toMatchObject({ unknown: 1, failed: 0 });
  });

  it('handler throws mid-action: row parked as unknown, NOT re-executed next tick', async () => {
    (runRpaScript as jest.Mock).mockImplementation(async () => { throw new Error('Target closed\ncall log...'); });
    seed([dueRow()], APPROVED);
    const out = await rpaSchedulerHooks.flushRetries();
    // old code: row left untouched and due -> re-executed on every tick
    advance(90_000);
    await rpaSchedulerHooks.flushRetries();
    advance(90_000);
    await rpaSchedulerHooks.flushRetries();
    expect(runRpaScript).toHaveBeenCalledTimes(1);
    expect(tables.rpa_retry_queue[0].last_error).toBe('RPA_OUTCOME_UNKNOWN:HANDLER_THREW:Target closed');
    expect(out).toMatchObject({ unknown: 1, failed: 0 });
  });

  it('a row already at max_attempts (terminal, still due) is never re-executed', async () => {
    seed([dueRow({ id: 'rq-x', action_id: 'act-0', attempts: 5 }), dueRow({ id: 'rq-y' })], APPROVED);
    tables.community_ai_actions.push({ id: 'act-0', organization_id: ORG, ...APPROVED });
    const out = await rpaSchedulerHooks.flushRetries();
    expect(runRpaScript).toHaveBeenCalledTimes(1);
    expect((runRpaScript as jest.Mock).mock.calls[0][0].action_id).toBe('act-1');
    expect(tables.rpa_retry_queue.map((r) => r.id)).toEqual(['rq-x']);
    expect(out.claimed).toBe(1);
  });

  it('CONTROL: a definite failure is still counted failed and rescheduled (not parked)', async () => {
    (runRpaScript as jest.Mock).mockImplementation(async () => ({ success: false, error: 'SELECTOR_NOT_FOUND' }));
    seed([dueRow()], APPROVED);
    const out = await rpaSchedulerHooks.flushRetries();
    expect(tables.rpa_retry_queue[0]).toMatchObject({ attempts: 2, last_error: 'SELECTOR_NOT_FOUND' });
    expect(out.failed).toBe(1);
    expect(out.unknown ?? 0).toBe(0);
  });
});

describe('24C (d) in-process task queue never re-runs an unknown outcome', () => {
  const task = {
    tenant_id: ORG, organization_id: ORG, platform: 'linkedin', action_type: 'like' as const,
    target_url: 'https://www.linkedin.com/feed/update/urn:1', action_id: 'act-q',
  };

  it('outcome_unknown result: handler called once', async () => {
    const h = jest.fn(async () => ({ success: false, outcome_unknown: true, error: 'RPA_OUTCOME_UNKNOWN:x' }));
    startRpaWorker(h);
    const r = await enqueueRpaTask(task);
    expect(h).toHaveBeenCalledTimes(1);
    expect(r.outcome_unknown).toBe(true);
  });

  it('handler throws: resolved as unknown, handler called once (was re-run, then rejected)', async () => {
    const h = jest.fn(async () => { throw new Error('browser crashed\nCall log: ...'); });
    startRpaWorker(h);
    const r = await enqueueRpaTask(task);
    expect(h).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ success: false, outcome_unknown: true, error: 'RPA_OUTCOME_UNKNOWN:browser crashed' });
  });

  it('CONTROL: a definite failure is still re-run once in-process', async () => {
    const h = jest.fn(async () => ({ success: false, error: 'SELECTOR_NOT_FOUND' }));
    startRpaWorker(h);
    await enqueueRpaTask(task);
    expect(h).toHaveBeenCalledTimes(2);
  });
});
