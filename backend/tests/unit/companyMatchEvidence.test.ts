/**
 * CI-231 exact-domain binding (re-derived 2026-11-19). Originally (e1, 2026-11-12) findMatchingCompany
 * reported WHAT proved a match (verified email domain / typed website / exact name) so callers would
 * disclose only on a verified match. The ruling is now stricter: a name or typed website never matches
 * at all, so the only lookup left is findCompaniesByVerifiedEmailDomain - keyed on the registrable
 * domain of the verified email (lib/shared/domain/companyDomain.normalizeCompanyDomain), returning EVERY
 * company on that domain so the caller can refuse an ambiguous one, and failing closed on a read error.
 */
export {};
type Row = Record<string, any>;
const mockCompanies: Row[] = [];
let mockFail = false;
const mockQueries: Array<Record<string, unknown>> = [];
function mockTable() {
  const tests: Array<(r: Row) => boolean> = []; let cap = Infinity; const q: Record<string, unknown> = {};
  const b: any = {
    select: () => b,
    limit: (n: number) => { cap = n; return b; },
    eq: (c: string, v: unknown) => { q[c] = v; tests.push((r) => r[c] === v); return b; },
    then: (ok: any, ko: any) => {
      mockQueries.push(q);
      return Promise.resolve(mockFail
        ? { data: null, error: { message: 'boom' } }
        : { data: mockCompanies.filter((r) => tests.every((t) => t(r))).slice(0, cap), error: null }).then(ok, ko);
    },
  };
  return b;
}
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: () => mockTable() }));
/* eslint-disable @typescript-eslint/no-var-requires */
const { findCompaniesByVerifiedEmailDomain } = require('../../services/companyMatchService');
/* eslint-enable @typescript-eslint/no-var-requires */
beforeEach(() => {
  mockFail = false;
  mockQueries.length = 0;
  mockCompanies.length = 0;
  mockCompanies.push(
    { id: 'c-acme', name: 'Acme Corporation', status: 'active', website_domain: 'acme.com', admin_email_domain: 'acme.com' },
    { id: 'c-zeta', name: 'Zeta Labs', status: 'active', website_domain: 'zeta.io', admin_email_domain: null },
    { id: 'c-uk', name: 'Acme UK', status: 'active', website_domain: 'acme.co.uk', admin_email_domain: 'acme.co.uk' },
  );
});

it('the verified corporate email domain -> that company, once (it holds both columns)', async () => {
  const r = await findCompaniesByVerifiedEmailDomain('p@acme.com');
  expect(r).toEqual({ ok: true, domain: 'acme.com', companies: [{ company_id: 'c-acme', company_name: 'Acme Corporation' }] });
});

it('the comparison is by registrable domain (normalizeCompanyDomain): a mail subdomain reaches its company', async () => {
  const r = await findCompaniesByVerifiedEmailDomain('p@mail.acme.com');
  expect(r).toMatchObject({ ok: true, domain: 'acme.com', companies: [{ company_id: 'c-acme' }] });
  expect(mockQueries.map((q) => q.website_domain ?? q.admin_email_domain)).toEqual(['acme.com', 'acme.com']);
});

it('acme.co.uk and foo.co.uk are different domains: x@foo.co.uk matches nothing', async () => {
  const r = await findCompaniesByVerifiedEmailDomain('x@foo.co.uk');
  expect(r).toEqual({ ok: true, domain: 'foo.co.uk', companies: [] });
  const uk = await findCompaniesByVerifiedEmailDomain('boss@acme.co.uk');
  expect(uk).toMatchObject({ ok: true, companies: [{ company_id: 'c-uk' }] });
});

it('a company NAME is never an input: an email at a domain no company holds matches nothing', async () => {
  const r = await findCompaniesByVerifiedEmailDomain('ceo@acme-corporation.net');
  expect(r).toEqual({ ok: true, domain: 'acme-corporation.net', companies: [] });
});

it('a free / public email domain looks nothing up and matches nothing', async () => {
  for (const email of ['p@gmail.com', 'p@outlook.com', '', null, undefined, 'not-an-email']) {
    const r = await findCompaniesByVerifiedEmailDomain(email);
    expect([email, r]).toEqual([email, { ok: true, domain: null, companies: [] }]);
  }
  expect(mockQueries).toEqual([]);
});

it('several companies on the domain are ALL returned (the caller refuses an ambiguous domain)', async () => {
  mockCompanies.push({ id: 'c-zeta-2', name: 'Zeta Two', status: 'active', website_domain: null, admin_email_domain: 'zeta.io' });
  const r = await findCompaniesByVerifiedEmailDomain('p@zeta.io');
  expect(r.ok).toBe(true);
  expect(r.companies.map((c: { company_id: string }) => c.company_id).sort()).toEqual(['c-zeta', 'c-zeta-2']);
});

it('a failed read is ok:false - never "no company"', async () => {
  mockFail = true;
  expect(await findCompaniesByVerifiedEmailDomain('p@acme.com')).toEqual({ ok: false });
});
