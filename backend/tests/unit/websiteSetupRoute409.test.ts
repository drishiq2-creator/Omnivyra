/**
 * U6 server half: POST /api/websites/setup {action:'create_website'} maps WebsiteAlreadyExistsError to
 * 409 { code: 'WEBSITE_ALREADY_EXISTS' }; any other failure is unchanged; a different URL creates (201).
 */
const createWebsiteFromSetup = jest.fn();
jest.mock('../../services/websiteSetupService', () => ({
  createWebsiteFromSetup: (...a: unknown[]) => createWebsiteFromSetup(...a),
  getOrCreateWebsiteSetup: jest.fn(),
  markWebsiteSetupStep: jest.fn(),
}));
jest.mock('../../services/userContextService', () => ({ enforceCompanyAccess: jest.fn(async () => ({ userId: 'u1' })) }));
jest.mock('../../services/rbacService', () => ({
  Role: { COMPANY_ADMIN: 'COMPANY_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' },
  enforceRole: jest.fn(async () => ({ userId: 'u1' })),
}));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: jest.fn() }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

import handler from '../../../pages/api/websites/setup';
import { WebsiteAlreadyExistsError } from '../../services/websiteService';

function call(body: Record<string, unknown>) {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => res;
  const req: any = { method: 'POST', query: {}, body: { company_id: 'co', action: 'create_website', name: 'A', ...body } };
  return (handler as any)(req, res).then(() => res);
}

beforeEach(() => createWebsiteFromSetup.mockReset());

describe('create_website duplicate -> 409 WEBSITE_ALREADY_EXISTS', () => {
  it('a duplicate address answers 409 with the code', async () => {
    createWebsiteFromSetup.mockRejectedValue(new WebsiteAlreadyExistsError('duplicate key ...'));
    const res = await call({ canonical_url: 'https://a.test' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ code: 'WEBSITE_ALREADY_EXISTS' }));
    expect(String(res.body.error)).not.toMatch(/try again|retry/i);
  });

  it('control: a different URL creates (201)', async () => {
    createWebsiteFromSetup.mockResolvedValue({ website: { id: 'w2' }, progress: {} });
    const res = await call({ canonical_url: 'https://b.test' });
    expect(res.statusCode).toBe(201);
  });

  it('control: any other failure is not turned into a 409', async () => {
    createWebsiteFromSetup.mockRejectedValue(new Error('boom'));
    await expect(call({ canonical_url: 'https://a.test' })).rejects.toThrow('boom');
  });
});
