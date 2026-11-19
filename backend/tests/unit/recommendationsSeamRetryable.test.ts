/**
 * The recommendations job routes read a child table through the tenant seam. A RETRYABLE seam failure
 * (TENANT_PARENT_UNREADABLE: the parent row could not be read) must answer 503 + Retry-After, the same as every
 * other seam route (seamDenial). Before: an untyped catch answered 404 "Job not found", telling the caller the
 * job does not exist when the database only could not be read. Non-retryable refusals keep the uniform 404.
 */
export {};

const JOB = { id: '11111111-1111-4111-8111-111111111111', company_id: '22222222-2222-4222-8222-222222222222', status: 'COMPLETED' };
let seamThrow: unknown = null;

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: async () => ({ userId: 'u1', companyIds: [JOB.company_id] }),
}));
jest.mock('../../services/rbacService', () => ({ isSuperAdmin: async () => false }));
jest.mock('../../db/supabaseClient', () => {
  const q: Record<string, unknown> = {};
  q.select = () => q; q.eq = () => q; q.in = () => q;
  q.maybeSingle = async () => ({ data: JOB, error: null });
  return { supabase: { from: () => q } };
});
jest.mock('../../db/tenantTable', () => {
  const actual = jest.requireActual('../../db/tenantTable');
  return {
    ...actual,
    tenantContextFor: (_p: unknown, companyId: string) => ({ companyId }),
    tenantChildTable: async () => { if (seamThrow) throw seamThrow; throw new Error('test: no child read expected'); },
  };
});

/* eslint-disable @typescript-eslint/no-var-requires */
const { TenantSeamError } = jest.requireActual('../../db/tenantTable');
const resultHandler = require('../../../pages/api/recommendations/[id]/result').default;
const statusHandler = require('../../../pages/api/recommendations/[id]/status').default;
/* eslint-enable @typescript-eslint/no-var-requires */

function call(handler: (req: unknown, res: unknown) => Promise<unknown>) {
  const out: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const res = {
    setHeader: (k: string, v: string) => { out.headers[k] = v; return res; },
    status: (s: number) => { out.status = s; return res; },
    json: (b: unknown) => { out.body = b; return res; },
  };
  return handler({ method: 'GET', query: { id: JOB.id }, headers: {} }, res).then(() => out);
}

describe.each([
  ['result', () => resultHandler],
  ['status', () => statusHandler],
])('recommendations/[id]/%s: seam failures', (_name, get) => {
  it('a RETRYABLE seam read failure is 503 + Retry-After, never "Job not found"', async () => {
    seamThrow = new TenantSeamError('TENANT_PARENT_UNREADABLE', 'parent read failed');
    const out = await call(get());
    expect(out.status).toBe(503);
    expect(out.headers['Retry-After']).toBeDefined();
    expect(JSON.stringify(out.body)).not.toContain('Job not found');
  });

  it('CONTROL: a non-retryable seam refusal keeps the uniform 404', async () => {
    seamThrow = new TenantSeamError('TENANT_MISMATCH', 'not this tenant');
    const out = await call(get());
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: 'Job not found' });
  });
});
