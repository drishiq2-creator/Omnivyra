/**
 * Outreach approval queue (a9, 2026-11-20; slice 2). Service + route:
 *   - lists ONE company's decision rows: 'awaiting_approval', and 'pending' WITH requires_approval; a 'pending' row
 *     that needs no approval is not listed; every row read is filtered by the named company;
 *   - truncation is reported, never hidden;
 *   - a read failure (error object AND thrown rejection) is { ok: false } / 503 OUTREACH_TASKS_UNREADABLE + Retry-After,
 *     never an empty queue; CONTROL: a readable empty queue is 200 with no items;
 *   - the route asks the tenant seam with the named company and the admin roles, and reads nothing when it refuses.
 */
type R = { data?: unknown; error?: { message: string } | null } | 'throw';
let next: R = { data: [], error: null };
const calls: Array<[string, unknown[]]> = [];
function builder() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'or', 'order', 'limit']) b[m] = (...a: unknown[]) => { calls.push([m, a]); return b; };
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    (next === 'throw' ? Promise.reject(new Error('socket hang up')) : Promise.resolve({ data: next.data ?? null, error: next.error ?? null })).then(res, rej);
  return b;
}
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: () => builder() }));
const guard = jest.fn();
jest.mock('../../security/TenantGuard', () => ({ requireTenantAccess: (...a: unknown[]) => guard(...a) }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

import { listTasksAwaitingApproval } from '../../services/leadOutreachExecution/approvalQueue';
import handler from '../../../pages/api/outreach/tasks/awaiting-approval';

const row = (id: string, status: string, requires_approval: boolean, extra: Record<string, unknown> = {}) => ({
  id, lead_id: `lead-${id}`, status, requires_approval, channel: 'internal', kind: 'k', action: 'a', explanation: 'why', created_at: `2026-11-20T00:00:0${id}Z`, ...extra,
});
let warn: jest.SpyInstance;
beforeEach(() => { next = { data: [], error: null }; calls.length = 0; guard.mockReset(); guard.mockResolvedValue({ userId: 'u1' }); warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => warn.mockRestore());

describe('listTasksAwaitingApproval', () => {
  it('lists only decision rows, mapped to a stage, filtered by the named company', async () => {
    next = { data: [row('1', 'awaiting_approval', true), row('2', 'pending', true), row('3', 'pending', false)] };
    const r = await listTasksAwaitingApproval('co-1');
    expect(r).toEqual({ ok: true, truncated: false, items: [
      expect.objectContaining({ taskId: '1', leadId: 'lead-1', stage: 'awaiting_approval' }),
      expect.objectContaining({ taskId: '2', stage: 'not_submitted' }),
    ] });
    expect(calls).toContainEqual(['eq', ['company_id', 'co-1']]);
    expect(calls).toContainEqual(['or', ['status.eq.awaiting_approval,and(status.eq.pending,requires_approval.eq.true)']]);
  });

  it('TENANT PIN: the company filter is its own top-level eq, and the .or() string never mentions company_id', async () => {
    await listTasksAwaitingApproval('co-1');
    const ors = calls.filter(([m]) => m === 'or');
    expect(ors).toHaveLength(1);
    expect(String(ors[0][1][0])).not.toMatch(/company_id/);
    expect(calls.filter(([m, a]) => m === 'eq' && a[0] === 'company_id')).toEqual([['eq', ['company_id', 'co-1']]]);
  });

  it('NO STARVATION: the database filters, so the read asks for exactly limit + 1 decision rows', async () => {
    await listTasksAwaitingApproval('co-1', { limit: 2 });
    expect(calls).toContainEqual(['limit', [3]]);
  });

  it('CONTROL: exactly limit decision rows is complete, not truncated', async () => {
    next = { data: [row('1', 'awaiting_approval', true), row('2', 'awaiting_approval', true)] };
    await expect(listTasksAwaitingApproval('co-1', { limit: 2 })).resolves.toMatchObject({ ok: true, truncated: false });
  });

  it('reports truncation when more decision rows exist than the limit', async () => {
    next = { data: [row('1', 'awaiting_approval', true), row('2', 'awaiting_approval', true), row('3', 'awaiting_approval', true)] };
    const r = await listTasksAwaitingApproval('co-1', { limit: 2 });
    expect(r).toMatchObject({ ok: true, truncated: true });
    expect((r as { items: unknown[] }).items).toHaveLength(2);
  });

  it.each([
    ['an error object', { data: null, error: { message: 'connection reset' } } as R],
    ['a thrown rejection', 'throw' as R],
  ])('a read failure (%s) is { ok: false, OUTREACH_TASKS_UNREADABLE } - never an empty queue', async (_n, outcome) => {
    next = outcome;
    await expect(listTasksAwaitingApproval('co-1')).resolves.toMatchObject({ ok: false, code: 'OUTREACH_TASKS_UNREADABLE' });
  });
});

describe('GET /api/outreach/tasks/awaiting-approval', () => {
  const call = async (query: Record<string, string>, method = 'GET') => {
    const res: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; return res; };
    await (handler as any)({ method, query, headers: {} }, res);
    return res;
  };

  it('asks the tenant seam with the NAMED company and the admin roles; 200 with the items', async () => {
    next = { data: [row('1', 'awaiting_approval', true)] };
    const res = await call({ companyId: 'co-1' });
    expect(guard).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'co-1', { requireRoleIn: ['COMPANY_ADMIN', 'SUPER_ADMIN', 'ADMIN'] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ companyId: 'co-1', truncated: false, items: [expect.objectContaining({ taskId: '1' })] });
  });

  it('the seam refuses -> nothing is read', async () => {
    guard.mockImplementation(async (_req: unknown, res: any) => { res.status(403).json({ error: 'forbidden' }); return null; });
    const res = await call({ companyId: 'co-1' });
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it.each([
    ['an error object', { data: null, error: { message: 'connection reset' } } as R],
    ['a thrown rejection', 'throw' as R],
  ])('a read failure (%s) -> 503 OUTREACH_TASKS_UNREADABLE + Retry-After, no items', async (_n, outcome) => {
    next = outcome;
    const res = await call({ companyId: 'co-1' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'The approval queue could not be read', code: 'OUTREACH_TASKS_UNREADABLE' });
    expect(res.headers['retry-after']).toBe('5');
  });

  it('CONTROL: a readable EMPTY queue is 200 with no items (genuinely nothing waiting)', async () => {
    const res = await call({ companyId: 'co-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ companyId: 'co-1', items: [], truncated: false });
  });

  it('missing companyId -> 400 before the seam; a non-GET -> 405', async () => {
    expect((await call({})).statusCode).toBe(400);
    expect(guard).not.toHaveBeenCalled();
    expect((await call({ companyId: 'co-1' }, 'POST')).statusCode).toBe(405);
  });
});
