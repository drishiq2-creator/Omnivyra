/**
 * b3 (2026-11-20): GET /api/integrations turned a failed read into `200 { integrations: [] }`
 * (`.catch(() => [])`), so every caller showed "nothing connected" (Rule 1). Now 503 INTEGRATIONS_UNAVAILABLE, and a
 * genuinely empty list is still a 200 [] (control).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { INTEGRATIONS_UNAVAILABLE, readIntegrationsList } from '../../../shared/integrations/integrationsReadCodes';

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/userContextService', () => ({ enforceCompanyAccess: jest.fn(async () => ({ userId: 'u1' })) }));
jest.mock('../../services/rbacService', () => ({
  Role: { COMPANY_ADMIN: 'COMPANY_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' },
  enforceRole: jest.fn(),
  getUserCompanyRole: jest.fn(async () => ({ role: 'COMPANY_ADMIN', userId: 'u1' })),
}));
let mockRead: () => Promise<unknown[]> = async () => [];
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: jest.fn(() => { throw new Error('no DB in this test'); }) }));
jest.mock('../../services/integrationService', () => ({
  // R26 T-2: the route shapes every integration with the REAL toPublicIntegration.
  toPublicIntegration: jest.requireActual('../../services/integrationService').toPublicIntegration,
  getIntegrations: jest.fn(() => mockRead()),
  createIntegration: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../../../pages/api/integrations/index').default;

async function get() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await handler({ method: 'GET', query: { company_id: 'co-A' } } as unknown as NextApiRequest, res as NextApiResponse);
  return res;
}

describe('GET /api/integrations read failure', () => {
  it('a failed read is 503 INTEGRATIONS_UNAVAILABLE, never 200 []', async () => {
    mockRead = async () => { throw new Error('connection terminated'); };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ code: INTEGRATIONS_UNAVAILABLE });
    expect(res.body.integrations).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('connection terminated'); // no DB text to the client
    errSpy.mockRestore();
  });

  it('CONTROL: a genuinely empty company is still 200 with an empty list', async () => {
    mockRead = async () => [];
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body.integrations).toEqual([]);
  });
});

describe('readIntegrationsList (every caller)', () => {
  it('a 2xx with an array is the list (empty included)', () => {
    expect(readIntegrationsList(true, { integrations: [] })).toEqual([]);
    expect(readIntegrationsList(true, { integrations: [{ id: 'a' }] })).toEqual([{ id: 'a' }]);
  });
  it.each<[string, boolean, unknown]>([
    ['the 503', false, { code: INTEGRATIONS_UNAVAILABLE }],
    ['a 2xx without the array', true, { error: 'x' }],
    ['a 2xx with a non-array', true, { integrations: 'nope' }],
    ['an unparseable body', true, null],
  ])('%s is null ("couldn\'t load"), never []', (_n, ok, body) => {
    expect(readIntegrationsList(ok, body)).toBeNull();
  });
});
