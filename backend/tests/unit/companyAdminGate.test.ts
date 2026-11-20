/**
 * requireCompanyAdmin IS enforceRole([COMPANY_ADMIN, SUPER_ADMIN]) with one difference: the member refusal carries a
 * code + the page copy. Every other enforceRole answer passes through unchanged, and a null without an answer fails
 * closed (never falls through to the handler).
 */
import type { NextApiRequest, NextApiResponse } from 'next';

let mockAnswer: { status: number; body: unknown } | 'pass' | 'silent' = 'pass';
jest.mock('../../services/rbacService', () => ({
  Role: { COMPANY_ADMIN: 'COMPANY_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' },
  enforceRole: jest.fn(async ({ res }: { res: any }) => {
    if (mockAnswer === 'pass') return { userId: 'u1', role: 'SUPER_ADMIN' };
    if (mockAnswer === 'silent') return null;
    res.status(mockAnswer.status).json(mockAnswer.body);
    return null;
  }),
}));

import { requireCompanyAdmin } from '../../services/companyAdminGate';
import { COMPANY_ADMIN_REQUIRED, COMPANY_ADMIN_REQUIRED_MESSAGE, isCompanyAdminRequired } from '../../../shared/auth/companyAdminRequired';

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = jest.fn();
  return res as NextApiResponse & { statusCode: number; body: any };
}
const run = async () => { const res = mockRes(); const out = await requireCompanyAdmin({ req: {} as NextApiRequest, res, companyId: 'co-A' }); return { out, res }; };

describe('requireCompanyAdmin', () => {
  it('an allowed role passes through untouched (nothing written)', async () => {
    mockAnswer = 'pass';
    const { out, res } = await run();
    expect(out).toEqual({ userId: 'u1', role: 'SUPER_ADMIN' });
    expect(res.statusCode).toBe(0);
  });

  it('the member refusal (403 FORBIDDEN_ROLE) gains the code + copy, keeping error for old matchers', async () => {
    mockAnswer = { status: 403, body: { error: 'FORBIDDEN_ROLE' } };
    const { out, res } = await run();
    expect(out).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'FORBIDDEN_ROLE', code: COMPANY_ADMIN_REQUIRED, message: COMPANY_ADMIN_REQUIRED_MESSAGE });
  });

  it.each<[string, number, unknown]>([
    ['unauthenticated', 401, { error: 'Authentication required. Please sign in again.', code: 'UNAUTHENTICATED' }],
    ['another company (scope violation)', 403, { error: 'COMPANY_SCOPE_VIOLATION' }],
    ['missing company', 400, { error: 'companyId required' }],
  ])('%s passes through UNCHANGED (never relabelled "ask an admin")', async (_n, status, body) => {
    mockAnswer = { status, body };
    const { out, res } = await run();
    expect(out).toBeNull();
    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual(body);
  });

  it('FAIL-CLOSED: enforceRole returning null without answering is still a 403, never a pass', async () => {
    mockAnswer = 'silent';
    const { out, res } = await run();
    expect(out).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe(COMPANY_ADMIN_REQUIRED);
  });
});

describe('isCompanyAdminRequired (client recogniser)', () => {
  it('matches the coded refusal and the older bare FORBIDDEN_ROLE', () => {
    expect(isCompanyAdminRequired(403, { code: COMPANY_ADMIN_REQUIRED })).toBe(true);
    expect(isCompanyAdminRequired(403, { error: 'FORBIDDEN_ROLE' })).toBe(true);
  });
  it.each<[number, unknown]>([
    [403, { error: 'COMPANY_SCOPE_VIOLATION' }],
    [403, { error: 'COMPANY_ACCESS_DENIED' }],
    [401, { code: COMPANY_ADMIN_REQUIRED }],
    [500, { error: 'FORBIDDEN_ROLE' }],
    [403, null],
  ])('does NOT match %s %j (not an admin-ness answer)', (status, body) => {
    expect(isCompanyAdminRequired(status, body)).toBe(false);
  });
});
