/**
 * U6 server half: POST /api/websites/setup {action:'create_website'} maps WebsiteAlreadyExistsError to
 * 409 { code: 'WEBSITE_ALREADY_EXISTS' }; any other failure is unchanged; a different URL creates (201).
 */
const createWebsiteFromSetup = jest.fn();
const getOrCreateWebsiteSetup = jest.fn();
jest.mock('../../services/websiteSetupService', () => ({
  ...jest.requireActual('../../services/websiteSetupService'),
  createWebsiteFromSetup: (...a: unknown[]) => createWebsiteFromSetup(...a),
  getOrCreateWebsiteSetup: (...a: unknown[]) => getOrCreateWebsiteSetup(...a),
  markWebsiteSetupStep: jest.fn(),
}));
const createWebsite = jest.fn();
jest.mock('../../services/websiteService', () => ({
  ...jest.requireActual('../../services/websiteService'),
  createWebsite: (...a: unknown[]) => createWebsite(...a),
  getWebsites: jest.fn(async () => []),
}));
jest.mock('../../services/userContextService', () => ({ enforceCompanyAccess: jest.fn(async () => ({ userId: 'u1' })) }));
jest.mock('../../services/rbacService', () => ({
  Role: { COMPANY_ADMIN: 'COMPANY_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' },
  enforceRole: jest.fn(async () => ({ userId: 'u1' })),
}));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: jest.fn() }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

import handler from '../../../pages/api/websites/setup';
import websitesHandler from '../../../pages/api/websites/index';
import { WebsiteAlreadyExistsError } from '../../services/websiteService';
import { WebsiteSetupReadError } from '../../services/websiteSetupService';

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

function callGet() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => res;
  return (handler as any)({ method: 'GET', query: { company_id: 'co' }, body: {} }, res).then(() => res);
}

describe('GET /api/websites/setup: a failed read is 503, not "new site"', () => {
  beforeEach(() => getOrCreateWebsiteSetup.mockReset());

  it('WebsiteSetupReadError -> 503 WEBSITE_SETUP_UNAVAILABLE', async () => {
    getOrCreateWebsiteSetup.mockRejectedValue(new WebsiteSetupReadError('timeout'));
    const res = await callGet();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({ code: 'WEBSITE_SETUP_UNAVAILABLE' }));
  });

  it('control: a new company is 200 { website: null }', async () => {
    getOrCreateWebsiteSetup.mockResolvedValue({ website: null, progress: null });
    const res = await callGet();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ website: null, progress: null });
  });
});

describe('POST /api/websites duplicate -> 409 (same as the setup route, no constraint name leaked)', () => {
  function callCreate() {
    const res: any = { statusCode: 0, body: undefined };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = () => res;
    return (websitesHandler as any)({ method: 'POST', query: {}, body: { company_id: 'co', name: 'A', canonical_url: 'https://a.test' } }, res).then(() => res);
  }
  beforeEach(() => createWebsite.mockReset());

  it('a duplicate answers 409 WEBSITE_ALREADY_EXISTS without the constraint name', async () => {
    createWebsite.mockRejectedValue(new WebsiteAlreadyExistsError('duplicate key value violates unique constraint "uq_websites_company_canonical_url_active"'));
    const res = await callCreate();
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('WEBSITE_ALREADY_EXISTS');
    expect(JSON.stringify(res.body)).not.toMatch(/uq_websites/);
  });

  it('control: another failure is still a 500', async () => {
    createWebsite.mockRejectedValue(new Error('boom'));
    const res = await callCreate();
    expect(res.statusCode).toBe(500);
  });
});
