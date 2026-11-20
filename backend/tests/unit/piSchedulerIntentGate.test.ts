/**
 * PI scheduler fix (c6 2026-11-20, owner ruling: c6 builds Prospect Intelligence).
 * prospectEnrichmentRetry and prospectScoreEvaluation sat behind the inactive-company gate, whose only input is an
 * activity set that nothing writes (recordUserActivity has no callers) - so even switched ON they never ran, and the
 * Prospects list read "Not scored" forever. They are now exempt from that gate ONLY. The protection that keeps them
 * OFF is their OWN gate (flag + tenant scope), proven here by running each job with an empty env (control).
 * Same harness as readinessSnapshotIntentGate.test.ts (REAL gate, REAL warm path, Redis stubbed).
 */
const zrangebyscoreResult: { value: string[] | Error } = { value: [] };

jest.mock('../../queue/standaloneRedisClient', () => ({
  getInstrumentedStandaloneRedisClient: jest.fn(() => ({
    // No active companies (or a Redis fault) — both collapse to [].
    zrangebyscore: jest.fn(async () => {
      if (zrangebyscoreResult.value instanceof Error) throw zrangebyscoreResult.value;
      return zrangebyscoreResult.value;
    }),
    zadd: jest.fn(async () => 1),
    zremrangebyscore: jest.fn(async () => 0),
    get: jest.fn(async () => null),
    set: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 1),
    hincrby: jest.fn(async () => 1),
    hgetall: jest.fn(async () => ({})),
    expire: jest.fn(async () => 1),
    scan: jest.fn(async () => ['0', [] as string[]]),
    pipeline: jest.fn(() => ({ hincrby: jest.fn(), expire: jest.fn(), exec: jest.fn(async () => []) })),
  })),
}));

import { warmIntentContext, getIntentGate } from '../../services/intentExecutionService';
import { runProspectRetryJob } from '../../jobs/prospectRetryJob';
import { runProspectScoreEvaluationJob } from '../../jobs/prospectScoreEvaluationJob';

const PI_JOBS = ['prospectEnrichmentRetry', 'prospectScoreEvaluation'];

describe('PI jobs are exempt from the inactive-company gate', () => {
  beforeEach(() => { zrangebyscoreResult.value = []; });

  test.each(PI_JOBS)('%s is allowed with an EMPTY activity set', async (job) => {
    await warmIntentContext();
    expect(getIntentGate(job)).toMatchObject({ allowed: true, reason: null });
  });

  test.each(PI_JOBS)('%s is allowed when Redis ERRORS (indistinguishable from idle)', async (job) => {
    zrangebyscoreResult.value = new Error('redis unavailable');
    await warmIntentContext();
    expect(getIntentGate(job).allowed).toBe(true);
  });

  test('CONTROL: an ordinary gated job is still refused on the same empty set', async () => {
    await warmIntentContext();
    expect(getIntentGate('signalClustering')).toMatchObject({ allowed: false, reason: 'no_active_companies' });
  });
});

describe('the exemption switches nothing on - each job keeps its OWN gate', () => {
  test('retry job: flag unset -> idle (ran:false), no ports touched', async () => {
    const ports: any = new Proxy({}, { get: () => { throw new Error('a port was touched while the flag is off'); } });
    const r = await runProspectRetryJob({ env: {}, ports });
    expect(r.ran).toBe(false);
  });
  test('retry job: flag on but NO tenants in scope -> idle', async () => {
    const ports: any = new Proxy({}, { get: () => { throw new Error('a port was touched with no tenants'); } });
    const r = await runProspectRetryJob({ env: { PI_RETRY_SCHEDULER_ENABLED: 'true' }, ports });
    expect(r.ran).toBe(false);
  });
  test('score job: flag unset -> idle; flag on without org ids -> idle', async () => {
    const ports: any = new Proxy({}, { get: () => { throw new Error('a port was touched'); } });
    expect((await runProspectScoreEvaluationJob(ports, {})).ran).toBe(false);
    expect((await runProspectScoreEvaluationJob(ports, { PI_SCORE_EVALUATION_ENABLED: 'true' })).ran).toBe(false);
  });
});
