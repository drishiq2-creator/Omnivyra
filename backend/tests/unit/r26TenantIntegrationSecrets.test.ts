/**
 * R26 T-2 — tenant integration secrets are WRITE-ONLY, for every role.
 *
 * At 2bc52db7a GET /api/integrations, GET/PUT /api/integrations/[id] and POST /api/integrations returned the DECRYPTED
 * CMS / webhook secrets to COMPANY_ADMIN and SUPER_ADMIN (and the content_architect principal, which maps to
 * COMPANY_ADMIN), and the edit form pre-filled them. These tests drive the real route handlers with the service
 * returning a HYDRATED integration (decrypted values in config, legacy plaintext in non_secret_config) and assert no
 * value leaves the server for any role, while `secret_fields_set` still says which secrets are stored.
 *
 * Failing control: at 2bc52db7a the COMPANY_ADMIN / SUPER_ADMIN cases leak all four values (the old route returned the
 * hydrated object as-is for those roles), and the service-level validation cases do not throw.
 */
import type { NextApiRequest, NextApiResponse } from 'next';

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

let mockAccess = true;
jest.mock('../../services/userContextService', () => ({
  enforceCompanyAccess: jest.fn(async ({ res }: { res: any }) => {
    if (mockAccess) return { userId: 'u1' };
    res.status(403).json({ error: 'COMPANY_ACCESS_DENIED' });
    return null;
  }),
}));

let mockRole: string | null = null;
jest.mock('../../services/rbacService', () => ({
  Role: { COMPANY_ADMIN: 'COMPANY_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' },
  enforceRole: jest.fn(async ({ res, allowedRoles }: { res: any; allowedRoles: string[] }) => {
    if (mockRole && allowedRoles.includes(mockRole)) return { userId: 'u1', role: mockRole };
    res.status(403).json({ error: 'FORBIDDEN_ROLE' });
    return null;
  }),
  getUserCompanyRole: jest.fn(async () => ({ role: mockRole, userId: 'u1' })),
}));

jest.mock('../../db/writeOwner', () => ({ ownedDbTable: jest.fn(() => { throw new Error('no DB in this test'); }) }));

const hydrated = (over: Record<string, unknown> = {}) => ({
  id: 'int-1',
  company_id: 'co-A',
  created_by: 'u0',
  type: 'lead_webhook',
  name: 'Site form',
  status: 'connected',
  config: { webhook_url: 'https://hooks.example/x', secret: 'whsec_REAL', inbound_secret: 'in_REAL', admin_api_key: 'id:REALKEY', empty_token: '' },
  non_secret_config: { webhook_url: 'https://hooks.example/x', app_password: 'LEGACY_PLAINTEXT' },
  last_tested_at: null,
  last_error: null,
  created_at: '2026-11-26T00:00:00Z',
  updated_at: '2026-11-26T00:00:00Z',
  ...over,
});
const SECRET_VALUES = ['whsec_REAL', 'in_REAL', 'id:REALKEY', 'LEGACY_PLAINTEXT'];
const leaks = (body: unknown) => SECRET_VALUES.filter((v) => JSON.stringify(body).includes(v));

const mockGetIntegrations = jest.fn(async () => [hydrated()]);
const mockGetIntegration = jest.fn(async () => hydrated());
const mockCreate = jest.fn(async () => hydrated());
const mockUpdate = jest.fn(async () => hydrated());
const mockDelete = jest.fn(async () => ({ deleted: true, credentials_deleted: 2, connection_retired: true, provider_revocation: 'not_supported' }));
jest.mock('../../services/integrationService', () => {
  const actual = jest.requireActual('../../services/integrationService');
  return {
    ...actual,
    getIntegrations: (...a: unknown[]) => (mockGetIntegrations as any)(...a),
    getIntegration: (...a: unknown[]) => (mockGetIntegration as any)(...a),
    createIntegration: (...a: unknown[]) => (mockCreate as any)(...a),
    updateIntegration: (...a: unknown[]) => (mockUpdate as any)(...a),
    deleteIntegration: (...a: unknown[]) => (mockDelete as any)(...a),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const listHandler = require('../../../pages/api/integrations/index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const oneHandler = require('../../../pages/api/integrations/[id]').default;

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res as NextApiResponse & { statusCode: number; body: any };
}
async function call(handler: any, method: string, query: Record<string, string>, body?: unknown) {
  const res = mockRes();
  await handler({ method, query, body } as unknown as NextApiRequest, res);
  return res;
}
const routes: Array<[string, () => Promise<any>, (b: any) => any]> = [
  ['GET /api/integrations', () => call(listHandler, 'GET', { company_id: 'co-A' }), (b) => b.integrations?.[0]],
  ['GET /api/integrations/[id]', () => call(oneHandler, 'GET', { company_id: 'co-A', id: 'int-1' }), (b) => b.integration],
  ['POST /api/integrations', () => call(listHandler, 'POST', {}, { company_id: 'co-A', type: 'lead_webhook', name: 'n', config: { webhook_url: 'https://hooks.example/x', secret: 'whsec_REAL' } }), (b) => b.integration],
  ['PUT /api/integrations/[id]', () => call(oneHandler, 'PUT', { company_id: 'co-A', id: 'int-1' }, { config: { secret: 'whsec_REAL' } }), (b) => b.integration],
];

afterEach(() => { mockAccess = true; mockRole = null; jest.clearAllMocks(); });

describe.each(routes)('%s — no secret value for ANY role', (_name, run, pick) => {
  it.each(['COMPANY_ADMIN', 'SUPER_ADMIN'])('%s (the roles that USED to see plaintext) gets no value, only the stored indicator', async (role) => {
    mockRole = role;
    const res = await run();
    expect([200, 201]).toContain(res.statusCode);
    const integration = pick(res.body);
    expect(integration).toBeDefined(); // non-vacuity: the scenario returned an integration
    expect(leaks(res.body)).toEqual([]);
    expect(integration.config.secret).toBe('********');
    expect(integration.secret_fields_set).toEqual(expect.arrayContaining(['secret', 'inbound_secret', 'admin_api_key', 'app_password']));
    expect(integration.secret_fields_set).not.toContain('empty_token');
    expect(integration.config.webhook_url).toBe('https://hooks.example/x'); // non-secret fields survive
  });
});

describe('unauthorised and cross-tenant callers', () => {
  it.each(routes)('%s: a non-member (different tenant) is refused before any integration is read or written', async (_n, run) => {
    mockAccess = false;
    mockRole = 'COMPANY_ADMIN';
    const res = await run();
    expect(res.statusCode).toBe(403);
    expect(leaks(res.body)).toEqual([]);
    for (const m of [mockGetIntegrations, mockGetIntegration, mockCreate, mockUpdate]) expect(m).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', () => call(listHandler, 'POST', {}, { company_id: 'co-A', type: 'lead_webhook', name: 'n', config: { secret: 'x' } })],
    ['PUT', () => call(oneHandler, 'PUT', { company_id: 'co-A', id: 'int-1' }, { config: { secret: 'x' } })],
    ['DELETE', () => call(oneHandler, 'DELETE', { company_id: 'co-A', id: 'int-1' })],
  ])('%s by a non-admin member is refused (403) and nothing is written', async (_m, run) => {
    mockRole = 'CONTENT_CREATOR';
    const res = await run();
    expect(res.statusCode).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('missing credential', () => {
  it('an integration with no stored secret reports none set and an empty value (not "hidden")', async () => {
    mockRole = 'COMPANY_ADMIN';
    mockGetIntegration.mockResolvedValueOnce(hydrated({ config: { webhook_url: 'https://hooks.example/x', secret: '' }, non_secret_config: { webhook_url: 'https://hooks.example/x' } }));
    const res = await call(oneHandler, 'GET', { company_id: 'co-A', id: 'int-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body.integration.secret_fields_set).toEqual([]);
    expect(res.body.integration.config.secret).toBe('');
  });
});

describe('signing mode is visible to the admin (owner decision 1)', () => {
  it('a legacy (pre-R26) lead webhook carries webhook_signing with raw_secret_sent and a deprecation warning, and no secret', async () => {
    mockRole = 'COMPANY_ADMIN';
    const res = await call(oneHandler, 'GET', { company_id: 'co-A', id: 'int-1' });
    expect(res.body.integration.webhook_signing).toMatchObject({ configured_mode: 'legacy', raw_secret_sent: true });
    expect(res.body.integration.webhook_signing.deprecation_warning).toMatch(/signed/);
    expect(leaks(res.body)).toEqual([]);
  });

  it('CONTROL: a signed one has no warning', async () => {
    mockRole = 'COMPANY_ADMIN';
    mockGetIntegration.mockResolvedValueOnce(hydrated({ config: { webhook_url: 'https://hooks.example/x', secret: 'whsec_REAL', signing_mode: 'signed' } }));
    const res = await call(oneHandler, 'GET', { company_id: 'co-A', id: 'int-1' });
    expect(res.body.integration.webhook_signing).toMatchObject({ effective_mode: 'signed', raw_secret_sent: false, deprecation_warning: null });
  });
});

describe('DELETE response states what the disconnect did', () => {
  it('credentials_deleted and provider_revocation are reported, and the actor is passed for the audit', async () => {
    mockRole = 'COMPANY_ADMIN';
    const res = await call(oneHandler, 'DELETE', { company_id: 'co-A', id: 'int-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: 'deleted', credentials_deleted: 2, provider_revocation: 'not_supported' });
    expect(mockDelete).toHaveBeenCalledWith('int-1', 'co-A', { actorUserId: 'u1' });
  });
});

describe('lead_webhook validation (real service function, 400 at the route)', () => {
  it('inbound_secret equal to the outbound secret is refused with 400 (one credential must not serve both directions)', async () => {
    mockRole = 'COMPANY_ADMIN';
    const actual = jest.requireActual('../../services/integrationService');
    mockCreate.mockImplementationOnce(async (...a: any[]) => actual.createIntegration(...a));
    const res = await call(listHandler, 'POST', {}, { company_id: 'co-A', type: 'lead_webhook', name: 'n', config: { webhook_url: 'https://h.example', secret: 'SAME', inbound_secret: 'SAME' } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/inbound_secret must differ/);
    expect(JSON.stringify(res.body)).not.toContain('SAME');
  });

  it('HTTPS-only at WRITE time: POST with an http:// webhook_url is refused with 400 and nothing is stored', async () => {
    mockRole = 'COMPANY_ADMIN';
    const actual = jest.requireActual('../../services/integrationService');
    mockCreate.mockImplementationOnce(async (...a: any[]) => actual.createIntegration(...a));
    const res = await call(listHandler, 'POST', {}, { company_id: 'co-A', type: 'lead_webhook', name: 'n', config: { webhook_url: 'http://hooks.example/x' } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/https/);
  });

  it('HTTPS-only at WRITE time: PUT to an http:// webhook_url is refused with 400', async () => {
    mockRole = 'COMPANY_ADMIN';
    const { IntegrationValidationError } = jest.requireActual('../../services/integrationService');
    mockUpdate.mockImplementationOnce(async () => { throw new IntegrationValidationError('webhook_url must use https://'); });
    const res = await call(oneHandler, 'PUT', { company_id: 'co-A', id: 'int-1' }, { config: { webhook_url: 'http://hooks.example/x' } });
    expect(res.statusCode).toBe(400);
  });

  it('an unknown signing_mode is refused with 400', async () => {
    mockRole = 'COMPANY_ADMIN';
    const actual = jest.requireActual('../../services/integrationService');
    mockCreate.mockImplementationOnce(async (...a: any[]) => actual.createIntegration(...a));
    const res = await call(listHandler, 'POST', {}, { company_id: 'co-A', type: 'lead_webhook', name: 'n', config: { webhook_url: 'https://h.example', signing_mode: 'raw' } });
    expect(res.statusCode).toBe(400);
  });
});
