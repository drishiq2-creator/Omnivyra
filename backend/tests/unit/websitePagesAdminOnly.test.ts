/**
 * Owner ruling 2026-11-20 (via b3): the website & lead-capture pages are ADMIN-ONLY, enforced SERVER-SIDE.
 *
 * Every member-readable API those pages used, and only they used (grep-verified per endpoint), now runs
 * requireCompanyAdmin after enforceCompanyAccess. Per endpoint: an admin is served, a member gets
 * 403 COMPANY_ADMIN_REQUIRED and the service is NEVER called, and a member of another company is refused as a
 * non-member before the role gate or the service runs (cross-tenant control).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { COMPANY_ADMIN_REQUIRED, COMPANY_ADMIN_REQUIRED_MESSAGE } from '../../../shared/auth/companyAdminRequired';

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

type Who = 'admin' | 'member' | 'outsider';
let who: Who = 'admin';
const enforceRoleCalls: unknown[] = [];

jest.mock('../../services/userContextService', () => ({
  enforceCompanyAccess: jest.fn(async ({ res }: { res: any }) => {
    if (who === 'outsider') { res.status(403).json({ error: 'COMPANY_ACCESS_DENIED' }); return null; }
    return { userId: 'u1' };
  }),
}));
jest.mock('../../services/rbacService', () => ({
  Role: { COMPANY_ADMIN: 'COMPANY_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' },
  // The real enforceRole's two relevant answers: an allowed role passes, a member is refused FORBIDDEN_ROLE.
  enforceRole: jest.fn(async ({ res, allowedRoles }: { res: any; allowedRoles: string[] }) => {
    enforceRoleCalls.push(allowedRoles);
    if (who === 'admin') return { userId: 'u1', role: 'COMPANY_ADMIN' };
    res.status(403).json({ error: 'FORBIDDEN_ROLE' });
    return null;
  }),
}));

const serviceCalls: string[] = [];
const svc = (name: string, value: unknown = { ok: name }) => jest.fn(async () => { serviceCalls.push(name); return value; });
jest.mock('../../services/websiteSetupService', () => ({
  getOrCreateWebsiteSetup: svc('getOrCreateWebsiteSetup'),
  createWebsiteFromSetup: svc('createWebsiteFromSetup'),
  markWebsiteSetupStep: svc('markWebsiteSetupStep'),
}));
jest.mock('../../services/providerDiagnosticsService', () => ({
  buildAllProviderDiagnostics: svc('buildAllProviderDiagnostics', []),
  buildProviderDiagnosticsCard: svc('buildProviderDiagnosticsCard'),
}));
jest.mock('../../services/cms/registry', () => ({ isCmsProvider: () => true }));
jest.mock('../../services/activationReadinessService', () => ({ buildActivationReadiness: svc('buildActivationReadiness') }));
jest.mock('../../services/formIntelligenceService', () => ({
  getFormPerformance: svc('getFormPerformance'),
  aggregateFormPerformance: svc('aggregateFormPerformance'),
}));
jest.mock('../../services/formAbandonmentService', () => ({ buildFormAbandonmentReport: svc('buildFormAbandonmentReport') }));
jest.mock('../../services/leadIntelligenceDigestService', () => ({ buildLeadIntelligenceDigest: svc('buildLeadIntelligenceDigest') }));
jest.mock('../../services/operatorObservabilityService', () => ({ buildOperatorObservability: svc('buildOperatorObservability') }));

/* eslint-disable @typescript-eslint/no-var-requires */
const ENDPOINTS: Array<[string, (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>, string]> = [
  ['GET /api/websites/setup', require('../../../pages/api/websites/setup').default, 'GET'],
  ['GET /api/integrations/diagnostics', require('../../../pages/api/integrations/diagnostics').default, 'GET'],
  ['GET /api/activation/readiness', require('../../../pages/api/activation/readiness').default, 'GET'],
  ['GET /api/website-intelligence/form-performance', require('../../../pages/api/website-intelligence/form-performance').default, 'GET'],
  ['POST /api/website-intelligence/form-performance', require('../../../pages/api/website-intelligence/form-performance').default, 'POST'],
  ['GET /api/website-intelligence/form-abandonment', require('../../../pages/api/website-intelligence/form-abandonment').default, 'GET'],
  ['GET /api/website-intelligence/lead-digest', require('../../../pages/api/website-intelligence/lead-digest').default, 'GET'],
  ['GET /api/website-intelligence/operator-observability', require('../../../pages/api/website-intelligence/operator-observability').default, 'GET'],
  ['GET /api/company-admin/access (the page probe)', require('../../../pages/api/company-admin/access').default, 'GET'],
];
/* eslint-enable @typescript-eslint/no-var-requires */

function mockRes() {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, unknown> };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: unknown) => { res.headers[k] = v; return res; };
  return res as NextApiResponse & { statusCode: number; body: any };
}
async function call(handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>, method: string) {
  const res = mockRes();
  await handler({ method, query: { company_id: 'co-A' }, body: { company_id: 'co-A' }, headers: {} } as unknown as NextApiRequest, res);
  return res;
}

beforeEach(() => { serviceCalls.length = 0; enforceRoleCalls.length = 0; who = 'admin'; });

describe.each(ENDPOINTS)('%s', (_name, handler, method) => {
  it('CONTROL: a company admin is served (2xx), through the admin role list', async () => {
    who = 'admin';
    const res = await call(handler, method);
    expect(res.statusCode).toBeGreaterThanOrEqual(200);
    expect(res.statusCode).toBeLessThan(300);
    expect(enforceRoleCalls).toEqual([['COMPANY_ADMIN', 'SUPER_ADMIN']]);
  });

  it('a non-admin MEMBER gets 403 COMPANY_ADMIN_REQUIRED with the page copy, and no service runs', async () => {
    who = 'member';
    const res = await call(handler, method);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'FORBIDDEN_ROLE', code: COMPANY_ADMIN_REQUIRED, message: COMPANY_ADMIN_REQUIRED_MESSAGE });
    expect(serviceCalls).toEqual([]);
  });

  it('cross-tenant: a member of ANOTHER company is refused as a non-member, before the role gate and any service', async () => {
    who = 'outsider';
    const res = await call(handler, method);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'COMPANY_ACCESS_DENIED' });
    expect(res.body.code).toBeUndefined(); // never told "ask an admin": they are not in this company at all
    expect(enforceRoleCalls).toEqual([]);
    expect(serviceCalls).toEqual([]);
  });
});

describe('websites/setup: a member GET can no longer CREATE setup state', () => {
  it('getOrCreateWebsiteSetup is not reached for a member', async () => {
    who = 'member';
    await call(ENDPOINTS[0][1], 'GET');
    expect(serviceCalls).not.toContain('getOrCreateWebsiteSetup');
  });
});
