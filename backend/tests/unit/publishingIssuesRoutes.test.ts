/**
 * Routes for dead-lettered CMS publishes: GET /api/blogs/publishing-issues and
 * POST /api/blogs/publishing-jobs/[jobId]/retry. Retry is gated like publishing itself (company
 * access + COMPANY_ADMIN / SUPER_ADMIN); the refusals map to 404 / 409 with their code; an unreadable
 * queue or job is 503 + Retry-After with its own code (b3, 2026-11-19), never an empty list or NOT_FOUND;
 * any other failure stays a 500.
 */
const gates = { access: true, role: true, roleCalls: [] as unknown[] };
const mockSvc = { list: jest.fn(), requeue: jest.fn() };

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/userContextService', () => ({
  enforceCompanyAccess: async (a: { res: any }) => {
    if (!gates.access) { a.res.status(403).json({ error: 'forbidden' }); return null; }
    return { userId: 'u1' };
  },
}));
jest.mock('../../services/rbacService', () => ({
  Role: { COMPANY_ADMIN: 'COMPANY_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' },
  enforceRole: async (a: { res: any; allowedRoles: unknown }) => {
    gates.roleCalls.push(a.allowedRoles);
    if (!gates.role) { a.res.status(403).json({ error: 'role' }); return false; }
    return true;
  },
}));
jest.mock('../../services/publishingJobService', () => ({
  listPublishingIssues: (...a: unknown[]) => mockSvc.list(...a),
  requeueDeadLetteredPublishingJob: (...a: unknown[]) => mockSvc.requeue(...a),
}));

import { PublishingStateUnreadableError } from '../../services/publishingStateUnreadable';
import issuesRoute from '../../../pages/api/blogs/publishing-issues';
import retryRoute from '../../../pages/api/blogs/publishing-jobs/[jobId]/retry';

async function call(handler: unknown, req: Record<string, unknown>) {
  const res: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: unknown) => { res.body = p; return res; };
  await (handler as any)({ headers: {}, query: {}, body: {}, ...req }, res);
  return res;
}
const retry = (body: Record<string, unknown> = { company_id: 'co-a' }) => call(retryRoute, { method: 'POST', query: { jobId: 'j1' }, body });

beforeEach(() => {
  gates.access = true; gates.role = true; gates.roleCalls.length = 0;
  mockSvc.list.mockReset(); mockSvc.requeue.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it('GET issues: 200 with the list; an UNREADABLE queue is 503 + Retry-After PUBLISHING_ISSUES_UNREADABLE, not []', async () => {
  mockSvc.list.mockResolvedValue([{ job_id: 'j1' }]);
  expect((await call(issuesRoute, { method: 'GET', query: { company_id: 'co-a' } })).body).toEqual({ issues: [{ job_id: 'j1' }] });
  mockSvc.list.mockRejectedValue(new PublishingStateUnreadableError('Publishing jobs', 'socket hang up'));
  const r = await call(issuesRoute, { method: 'GET', query: { company_id: 'co-a' } });
  expect(r.statusCode).toBe(503);
  expect(r.headers['Retry-After']).toBe('5');
  expect(r.body).toEqual({ code: 'PUBLISHING_ISSUES_UNREADABLE', error: expect.stringMatching(/doesn't mean there are none/) });
});

it('CONTROL: GET issues - a failure that is NOT a read stays a 500 (not dressed up as retryable)', async () => {
  mockSvc.list.mockRejectedValue(new TypeError('x is not a function'));
  const r = await call(issuesRoute, { method: 'GET', query: { company_id: 'co-a' } });
  expect(r.statusCode).toBe(500);
  expect(r.headers['Retry-After']).toBeUndefined();
  expect(r.body).not.toHaveProperty('issues');
});

it('retry: the job is UNREADABLE -> 503 + Retry-After PUBLISHING_JOB_UNREADABLE, retried:false - never 404 NOT_FOUND', async () => {
  mockSvc.requeue.mockRejectedValue(new PublishingStateUnreadableError('Publishing job', 'socket hang up'));
  const r = await retry();
  expect(r.statusCode).toBe(503);
  expect(r.headers['Retry-After']).toBe('5');
  expect(r.body).toEqual({ retried: false, code: 'PUBLISHING_JOB_UNREADABLE', error: expect.stringMatching(/nothing was retried/) });
});

it('CONTROL: retry - a failure that is NOT a read (e.g. the re-queue write) stays a 500', async () => {
  mockSvc.requeue.mockRejectedValue(new Error('Publishing job not re-queued: x'));
  const r = await retry();
  expect(r.statusCode).toBe(500);
  expect(r.headers['Retry-After']).toBeUndefined();
});

it('retry: gated on the admin roles; denied -> 403 and the service is never called', async () => {
  gates.role = false;
  expect((await retry()).statusCode).toBe(403);
  expect(gates.roleCalls).toEqual([['COMPANY_ADMIN', 'SUPER_ADMIN']]);
  expect(mockSvc.requeue).not.toHaveBeenCalled();
});

it('retry: no company access -> 403, service never called', async () => {
  gates.access = false;
  expect((await retry()).statusCode).toBe(403);
  expect(mockSvc.requeue).not.toHaveBeenCalled();
});

it('retry passes the confirmation through ONLY when it is literally true', async () => {
  mockSvc.requeue.mockResolvedValue({ ok: true, outcome_unknown: true });
  await retry({ company_id: 'co-a', confirm_outcome_unknown: 'yes' });
  expect(mockSvc.requeue).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: 'j1', companyId: 'co-a', actorUserId: 'u1', confirmOutcomeUnknown: false }));
  await retry({ company_id: 'co-a', confirm_outcome_unknown: true });
  expect(mockSvc.requeue).toHaveBeenLastCalledWith(expect.objectContaining({ confirmOutcomeUnknown: true }));
});

it.each([
  ['CONFIRM_OUTCOME_UNKNOWN', 409],
  ['NOT_DEAD_LETTER', 409],
  ['NOT_FOUND', 404],
] as const)('a %s refusal -> %s with its code', async (code, status) => {
  mockSvc.requeue.mockResolvedValue({ ok: false, code, message: 'm' });
  const r = await retry();
  expect(r.statusCode).toBe(status);
  expect(r.body).toMatchObject({ retried: false, code });
});

it('NEGATIVE CONTROL: an admin with access retries -> 200', async () => {
  mockSvc.requeue.mockResolvedValue({ ok: true, outcome_unknown: false });
  const r = await retry();
  expect(r.statusCode).toBe(200);
  expect(r.body).toEqual({ retried: true, outcome_unknown: false });
});
