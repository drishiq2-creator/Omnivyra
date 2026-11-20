/**
 * A failed publishing-queue READ is its own state (b3 standing rule, 2026-11-19): both failure forms - an
 * error object AND a thrown rejection - become PublishingStateUnreadableError, which the routes answer
 * 503 + Retry-After. Never NOT_FOUND, never "no issues". Standalone: the shared fakeWhatsappDb cannot
 * reject, and two branches already edit it.
 */
type Mode = 'ok' | 'error' | 'throw';
const mockDb = {
  mode: {} as Record<string, Mode>,
  rows: {} as Record<string, unknown[]>,
};

function mockBuilder(table: string) {
  const settle = (one: boolean) => {
    const mode = mockDb.mode[table] ?? 'ok';
    if (mode === 'throw') return Promise.reject(new Error('socket hang up'));
    if (mode === 'error') return Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } });
    const rows = mockDb.rows[table] ?? [];
    return Promise.resolve({ data: one ? (rows[0] ?? null) : rows, error: null });
  };
  const b: any = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is', 'update']) b[m] = () => b;
  b.maybeSingle = () => settle(true);
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle(false).then(res, rej);
  return b;
}

jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => mockBuilder(t) }));
jest.mock('../../services/auditEventService', () => ({ recordAuditEvent: async () => undefined }));
jest.mock('../../services/cms/registry', () => ({ isCmsProvider: () => true, getCmsAdapter: () => ({}) }));
jest.mock('../../services/integrationService', () => ({ getIntegration: async () => null }));
jest.mock('../../services/queueOperationsService', () => ({ captureQueueMetrics: async () => null, recordWorkerHeartbeat: async () => null }));
jest.mock('../../services/workerSnapshotShadowHook', () => ({ runWorkerSnapshotShadowHook: async () => undefined }));

import { listPublishingIssues, requeueDeadLetteredPublishingJob } from '../../services/publishingJobService';
import { PublishingStateUnreadableError } from '../../services/publishingStateUnreadable';

const CO = 'co-a';
const DEAD = { id: 'j1', blog_id: 'b1', status: 'dead_letter', dead_letter_at: '2026-11-19T00:00:00Z', created_at: '2026-11-19T00:00:00Z' };
const requeue = () => requeueDeadLetteredPublishingJob({ jobId: 'j1', companyId: CO, actorUserId: 'u1' });

beforeEach(() => { mockDb.mode = {}; mockDb.rows = {}; });

describe.each(['error', 'throw'] as const)('a failed read (%s) is PublishingStateUnreadableError', (mode) => {
  it('listPublishingIssues: the jobs read', async () => {
    mockDb.mode.publishing_jobs = mode;
    const p = listPublishingIssues(CO);
    await expect(p).rejects.toBeInstanceOf(PublishingStateUnreadableError);
    await expect(p).rejects.toThrow('Publishing jobs unreadable');
  });

  it('listPublishingIssues: the attempts read (after a readable jobs read with a dead letter)', async () => {
    mockDb.rows.publishing_jobs = [DEAD];
    mockDb.mode.publishing_attempts = mode;
    const p = listPublishingIssues(CO);
    await expect(p).rejects.toBeInstanceOf(PublishingStateUnreadableError);
    await expect(p).rejects.toThrow('Publishing attempts unreadable');
  });

  it('requeueDeadLetteredPublishingJob: the job read - never NOT_FOUND', async () => {
    mockDb.mode.publishing_jobs = mode;
    const p = requeue();
    await expect(p).rejects.toBeInstanceOf(PublishingStateUnreadableError);
    await expect(p).rejects.toThrow('Publishing job unreadable');
  });
});

it('NEGATIVE CONTROL: a READABLE job read that finds nothing is NOT_FOUND, not unreadable', async () => {
  await expect(requeue()).resolves.toEqual({ ok: false, code: 'NOT_FOUND', message: 'Publishing job not found.' });
});

it('NEGATIVE CONTROL: a readable queue with no dead letters is genuinely no issues', async () => {
  await expect(listPublishingIssues(CO)).resolves.toEqual([]);
});
