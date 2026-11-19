/**
 * CI-434 (owner ruling 2026-11-13: billing writes are company admins only). GET /api/user/subscription is a read of
 * the plan tier and is EXEMPT from the billing-write gate only because it accepts no write: every other method is 405
 * before auth, membership or plan resolution. If a write method is ever added here, this suite fails and the route
 * must take requireNormalizedRoleIn: BILLING_WRITE_ROLES like the other billing writes.
 */
const mockCalls: string[] = [];
jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: jest.fn(async () => { mockCalls.push('auth'); return { user: { id: 'u-1' }, error: null }; }),
}));
jest.mock('../../services/planResolutionService', () => ({
  resolveOrganizationPlanLimits: jest.fn(async () => { mockCalls.push('plan'); return { plan_key: 'pro', limits: {} }; }),
}));
jest.mock('../../services/userContextService', () => ({
  enforceCompanyAccess: jest.fn(async () => { mockCalls.push('membership'); return { userId: 'u-1' }; }),
}));
jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

/* eslint-disable @typescript-eslint/no-var-requires */
const handler = require('../../../pages/api/user/subscription').default;
/* eslint-enable @typescript-eslint/no-var-requires */

async function call(method: string) {
  const out = { code: 0, body: null as any };
  const res: any = { status: (c: number) => { out.code = c; return res; }, json: (b: any) => { out.body = b; return res; }, setHeader: () => res, end: () => res };
  await handler({ method, query: { company_id: 'c-1' }, body: { company_id: 'c-1', plan_key: 'enterprise' }, headers: {} }, res);
  return out;
}

beforeEach(() => { mockCalls.length = 0; });

it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s -> 405 before auth, membership or plan resolution (no write path exists)', async (method) => {
  const r = await call(method);
  expect(r.code).toBe(405);
  expect(mockCalls).toEqual([]);
});

it('control: GET is the one accepted method (membership-checked read of the tier)', async () => {
  const r = await call('GET');
  expect(r.code).toBe(200);
  expect(mockCalls).toEqual(['auth', 'membership', 'plan']);
  expect(r.body).toMatchObject({ ok: true, data: { tier: 'pro' } });
});
