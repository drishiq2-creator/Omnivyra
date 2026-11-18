/**
 * e1 (2026-11-12): /api/onboarding/company-domain-check uses the session email's DOMAIN as its only
 * evidence, but never required that email to be verified - an unverified session at someone else's
 * domain learned their company id, name and admin (with the admin's email local-part as fallback).
 * Now: 403 EMAIL_NOT_VERIFIED before any read. CI-309 (2026-11-19): a verified match returns
 * { matched: true } ONLY - no company id or name, no admin (the requester learns only that their own
 * verified domain already has a workspace). The domain is always the session's verified email; a
 * domain the caller passes is never read.
 */
export {};
type Row = Record<string, any>;
const mockDb: Record<string, Row[]> = {};
const mockReads: string[] = [];
function mockTable(table: string) {
  const tests: Array<(r: Row) => boolean> = []; let one = false;
  const b: any = {
    select: () => b, limit: () => b,
    eq: (c: string, v: unknown) => { tests.push((r) => r[c] === v); return b; },
    or: (expr: string) => {
      const alts = expr.split(',').map((p) => { const [col, , ...rest] = p.split('.'); return [col, rest.join('.')]; });
      tests.push((r) => alts.some(([c, v]) => r[c] === v)); return b;
    },
    maybeSingle: () => { one = true; return b; },
    then: (ok: any, ko: any) => {
      mockReads.push(table);
      if (mockFailTable === table) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(ok, ko);
      const hit = (mockDb[table] ?? []).filter((r) => tests.every((t) => t(r)));
      const res = one && hit.length > 1 ? { data: null, error: { code: 'PGRST116' } } : { data: one ? hit[0] ?? null : hit, error: null };
      return Promise.resolve(res).then(ok, ko);
    },
  };
  return b;
}
let mockVerified = true;
let mockEmail = 'p@acme.com';
let mockFailTable: string | null = null;
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => mockTable(t) } }));
// The shared verified-domain lookup (findCompaniesByVerifiedEmailDomain) reads through ownedDbTable.
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => mockTable(t) }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/authResolver', () => ({
  resolveAuthenticatedUser: async () => ({ user: { id: 'x', supabaseUid: 'sb-p', email: mockEmail, emailVerified: mockVerified }, error: null }),
}));
/* eslint-disable @typescript-eslint/no-var-requires */
const route = require('../../../pages/api/onboarding/company-domain-check').default;
/* eslint-enable @typescript-eslint/no-var-requires */
async function get(query: Record<string, unknown> = {}) {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (x: unknown) => { res.body = x; return res; };
  await route({ method: 'GET', headers: {}, query }, res);
  return res;
}
beforeEach(() => {
  mockVerified = true; mockReads.length = 0; mockEmail = 'p@acme.com'; mockFailTable = null;
  mockDb.users = [{ id: 'u-p', supabase_uid: 'sb-p', email: 'p@acme.com' }, { id: 'u-admin', name: 'Ada Admin', email: 'ada@acme.com' }];
  mockDb.companies = [{ id: 'c-acme', name: 'Acme', status: 'active', website_domain: 'acme.com', admin_email_domain: 'acme.com' }];
  mockDb.user_company_roles = [{ user_id: 'u-admin', company_id: 'c-acme', role: 'COMPANY_ADMIN', status: 'active' }];
});

it('an UNVERIFIED session is refused before anything is read', async () => {
  mockVerified = false;
  const r = await get();
  expect(r.statusCode).toBe(403);
  expect(r.body.code).toBe('EMAIL_NOT_VERIFIED');
  expect(mockReads).toEqual([]);
});
it('a verified match returns { matched: true } only - no company id or name, no admin', async () => {
  const r = await get();
  expect(r.statusCode).toBe(200);
  expect(r.body).toEqual({ matched: true });
});
it("an admin with no display name changes nothing - never the email's local-part", async () => {
  mockDb.users[1].name = null;
  const r = await get();
  expect(r.body).toEqual({ matched: true });
  expect(JSON.stringify(r.body)).not.toContain('ada');
});
it('the admin is never looked up (nothing about them can reach the reply)', async () => {
  await get();
  expect(mockReads.filter((t) => t === 'user_company_roles')).toHaveLength(1); // the caller's own membership only
});
it("control: a domain passed by the caller is ignored - only the session's verified email domain is checked", async () => {
  mockDb.companies.push({ id: 'c-other', name: 'Other', status: 'active', website_domain: 'other.com', admin_email_domain: 'other.com' });
  mockDb.companies = mockDb.companies.filter((c) => c.id !== 'c-acme');
  const r = await get({ domain: 'other.com', email: 'x@other.com' });
  expect(r.body).toEqual({ matched: false });
});

describe('the SAME verified-domain lookup as setup-company (findCompaniesByVerifiedEmailDomain)', () => {
  it('a mail-subdomain user (p@mail.acme.com) is matched by registrable domain, as setup-company matches them', async () => {
    mockEmail = 'p@mail.acme.com';
    mockDb.users[0].email = 'p@mail.acme.com';
    const r = await get();
    expect([r.statusCode, r.body]).toEqual([200, { matched: true }]);
  });
  it('several companies on the domain: the same 409 COMPANY_DOMAIN_AMBIGUOUS setup-company gives, nothing revealed', async () => {
    mockDb.companies.push({ id: 'c-acme-2', name: 'Acme Two', status: 'active', website_domain: null, admin_email_domain: 'acme.com' });
    mockDb.companies[0].admin_email_domain = null;
    const r = await get();
    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('COMPANY_DOMAIN_AMBIGUOUS');
    expect(JSON.stringify(r.body)).not.toMatch(/c-acme|Acme Two|"Acme"/);
  });
  it('a failed company read is 503 - never "not matched"', async () => {
    mockFailTable = 'companies';
    const r = await get();
    expect(r.statusCode).toBe(503);
    expect(r.body.matched).toBeUndefined();
  });
});
