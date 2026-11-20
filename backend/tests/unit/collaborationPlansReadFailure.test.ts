/**
 * PL-129 (04, 2026-11-20; handed over by a9). POST /api/collaboration-plans read the opportunity with
 * `const { data: existing } = await supabase…single()`:
 *   - an error object (a FAILED read) was answered "404 Opportunity not found", i.e. absence;
 *   - a THROWN rejection escaped the handler raw;
 *   - an insert failure returned the raw database message to the client.
 * Now (same shape as a9's outreach-plans fix 4d8fba601): an error object OR a thrown rejection is
 * 503 { code: OPPORTUNITY_UNREADABLE } + Retry-After, nothing is written; PGRST116 stays the genuine 404;
 * an insert failure is 500 { code: COLLABORATION_PLAN_CREATE_FAILED } with no raw message.
 *
 * Only the data layer and the RBAC seam are mocked; the handler runs for real.
 */
const USER = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const COMPANY = 'a0000000-0000-0000-0000-00000000000a';
const OPP = 'oa000000-0000-0000-0000-00000000000a';

type ReadMode = 'ok' | 'none' | 'error' | 'throw';
let readMode: ReadMode = 'ok';
let insertFails = false;
const writes: Array<{ table: string; payload: unknown }> = [];

jest.mock('../../db/supabaseClient', () => {
  const from = (table: string) => {
    const b: any = {};
    b.select = () => b;
    b.eq = () => b;
    b.insert = (p: unknown) => { writes.push({ table, payload: p }); return b; };
    b.single = () => {
      if (table === 'opportunity_items') {
        if (readMode === 'throw') return Promise.reject(new Error('socket hang up'));
        if (readMode === 'error') return Promise.resolve({ data: null, error: { code: '08006', message: 'connection reset' } });
        if (readMode === 'none') return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
        return Promise.resolve({ data: { id: OPP, company_id: COMPANY }, error: null });
      }
      if (table === 'collaboration_plans') {
        return insertFails
          ? Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "secret_internal_idx"' } })
          : Promise.resolve({ data: { id: 'plan1', opportunity_id: OPP }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    return b;
  };
  return { supabase: { from } };
});
// RBAC seam: the role wrapper passes the identified user through; tenant access is granted for COMPANY.
jest.mock('../../middleware/withRBAC', () => ({
  withRBAC: (h: any) => (req: any, res: any) => { req.rbac = { userId: USER }; return h(req, res); },
}));
jest.mock('../../middleware/authMiddleware', () => ({
  requireCompanyAccess: jest.fn(async (_u: string, companyId?: string, res?: any) => {
    if (companyId === COMPANY) return true;
    res.status(403).json({ error: 'forbidden' });
    return false;
  }),
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

import handler from '../../../pages/api/collaboration-plans/index';

function mockRes() {
  const res: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> };
  res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; return res; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}
async function post() {
  const res = mockRes();
  await (handler as any)({ method: 'POST', body: { opportunityId: OPP, companyId: COMPANY }, headers: {} }, res);
  return res;
}

let errSpy: jest.SpyInstance;
beforeEach(() => {
  readMode = 'ok'; insertFails = false; writes.length = 0;
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('PL-129 collaboration-plans: a failed opportunity read is not "not found"', () => {
  it.each<[string, ReadMode]>([
    ['an error object', 'error'],
    ['a thrown rejection', 'throw'],
  ])('%s → 503 OPPORTUNITY_UNREADABLE + Retry-After, nothing written, never raw', async (_n, mode) => {
    readMode = mode;
    const res = await post();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'The opportunity could not be read', code: 'OPPORTUNITY_UNREADABLE' });
    expect(res.headers['retry-after']).toBe('5');
    expect(writes).toEqual([]);
  });

  it('control: PGRST116 (the genuine no-row answer) is still 404, nothing written', async () => {
    readMode = 'none';
    const res = await post();
    expect(res.statusCode).toBe(404);
    expect(writes).toEqual([]);
  });

  it('control: a readable opportunity of the caller\'s company creates the plan (201)', async () => {
    const res = await post();
    expect(res.statusCode).toBe(201);
    expect(writes.filter((w) => w.table === 'collaboration_plans')).toHaveLength(1);
  });

  it('an insert failure answers a code, never the raw database message', async () => {
    insertFails = true;
    const res = await post();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'The collaboration plan could not be created', code: 'COLLABORATION_PLAN_CREATE_FAILED' });
    expect(JSON.stringify(res.body)).not.toMatch(/secret_internal_idx|duplicate key/);
  });
});
