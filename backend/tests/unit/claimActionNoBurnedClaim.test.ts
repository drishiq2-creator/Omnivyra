/**
 * c6 2026-11-19 (7c BLOCKING, money): /api/credits/claim-action wrote the one-time free_credit_claims row
 * (UNIQUE(user_id, category)) FIRST and only then looked up the org. A failed membership read, a failed company-status
 * read (the inactive-company gate fails closed to null) or no operational company all skipped the grant and returned
 * 200 { success, credits } - no credits, and the claim burnt forever. Now the org is resolved BEFORE the claim:
 *   - membership read error / company-status read error -> 503 retryable, NOTHING written;
 *   - no operational company -> 409 no_active_organization, nothing written;
 *   - an operational company -> claim written, credit granted, 200.
 */
type Res = { data?: unknown; error?: unknown };
const writes: string[] = [];
let membership: Res = { data: [{ company_id: 'co-1' }], error: null };
let companies: Res | 'throw' = { data: [{ id: 'co-1', status: 'active', deleted_at: null }], error: null };
const mockCreateCredit = jest.fn(async () => undefined);

function chain(table: string): any {
  const q: any = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) q[m] = () => q;
  q.maybeSingle = async () => ({ data: null, error: null });
  q.insert = async () => { writes.push(`insert:${table}`); return { error: null }; };
  q.delete = () => {
    writes.push(`delete:${table}`);
    const d: any = { eq: () => d, then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: (global as any).__rollbackFails ? { message: 'rollback boom' } : null }).then(ok) };
    return d;
  };
  q.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => {
    if (table === 'user_company_roles') return Promise.resolve(membership).then(ok, err);
    if (table === 'companies') return (companies === 'throw' ? Promise.reject(new Error('fetch failed')) : Promise.resolve(companies)).then(ok, err);
    return Promise.resolve({ data: [], error: null }).then(ok, err);
  };
  return q;
}
jest.mock('@/backend/db/supabaseClient', () => ({ supabase: { from: (t: string) => chain(t) } }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => chain(t) } }));
jest.mock('../../services/supabaseAuthService', () => ({ getSupabaseUserFromRequest: async () => ({ user: { id: 'u-1', email: null }, error: null }) }));
jest.mock('../../services/domainEligibilityService', () => ({ checkDomainEligibility: async () => ({ eligible: true, result: 'eligible' }) }));
jest.mock('../../services/creditExecutionService', () => ({ createCredit: (...a: unknown[]) => mockCreateCredit(...(a as [])), makeIdempotencyKey: (...p: string[]) => p.join(':') }));
jest.mock('../../middleware/withIdempotency', () => ({ withIdempotency: (h: unknown) => h }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../../../pages/api/credits/claim-action').default;

async function call() {
  const res: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  await handler({ method: 'POST', body: { category: 'feedback' }, headers: {} }, res);
  return res;
}

beforeEach(() => {
  writes.length = 0; mockCreateCredit.mockClear();
  membership = { data: [{ company_id: 'co-1' }], error: null };
  companies = { data: [{ id: 'co-1', status: 'active', deleted_at: null }], error: null };
});

test('control: an operational company -> claim written, credit granted, 200', async () => {
  const r = await call();
  expect(r.statusCode).toBe(200);
  expect(writes).toEqual(['insert:free_credit_claims']);
  expect(mockCreateCredit).toHaveBeenCalledTimes(1);
});

test.each([
  ['membership read returns { error }', () => { membership = { data: null, error: { message: 'boom' } }; }, 'membership_unavailable'],
  ['company-status read returns { error }', () => { companies = { data: null, error: { message: 'boom' } }; }, 'company_status_unavailable'],
])('%s -> 503 retryable, NO claim written, no credit (the claim is never burnt)', async (_n, arrange, code) => {
  arrange();
  const r = await call();
  expect(r.statusCode).toBe(503);
  expect(r.body).toMatchObject({ error: code, retryable: true });
  expect(r.headers['Retry-After']).toBe('5');
  expect(writes).toEqual([]);
  expect(mockCreateCredit).not.toHaveBeenCalled();
});

test('company-status read REJECTS -> never a 200 success, no claim written', async () => {
  companies = 'throw';
  const r = await call();
  expect(r.statusCode).not.toBe(200);
  expect(writes).toEqual([]);
  expect(mockCreateCredit).not.toHaveBeenCalled();
});

test.each([
  ['no membership at all', () => { membership = { data: [], error: null }; }],
  ['only an INACTIVE company', () => { companies = { data: [{ id: 'co-1', status: 'suspended', deleted_at: null }], error: null }; }],
])('%s -> 409 no_active_organization, NO claim written', async (_n, arrange) => {
  arrange();
  const r = await call();
  expect(r.statusCode).toBe(409);
  expect(r.body).toMatchObject({ error: 'no_active_organization' });
  expect(writes).toEqual([]);
  expect(mockCreateCredit).not.toHaveBeenCalled();
});

describe('7c residual: grant fails AND the claim rollback fails', () => {
  test('-> 500 CLAIM_GRANT_FAILED_UNRELEASED (support can reconcile), never "Please try again"', async () => {
    mockCreateCredit.mockImplementationOnce(async () => { throw new Error('ledger down'); });
    // the delete() rollback reports an error
    (global as any).__rollbackFails = true;
    const r = await call();
    (global as any).__rollbackFails = false;
    expect(r.statusCode).toBe(500);
    expect(r.body).toMatchObject({ code: 'CLAIM_GRANT_FAILED_UNRELEASED' });
  });
  test('control: grant fails, rollback succeeds -> 500 "Please try again" (claim released)', async () => {
    mockCreateCredit.mockImplementationOnce(async () => { throw new Error('ledger down'); });
    const r = await call();
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ error: 'Credit grant failed. Please try again.' });
    expect(writes).toEqual(['insert:free_credit_claims', 'delete:free_credit_claims']);
  });
});
