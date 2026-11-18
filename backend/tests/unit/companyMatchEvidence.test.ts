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
/** Postgres ILIKE over PostgREST (`*` -> `%`), with backslash escapes - so the lookup's escaping is exercised. */
function ilikeMatch(value: string, pattern: string): boolean {
  const p = pattern.replace(/\*/g, '%');
  let re = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) { re += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (c === '%') re += '.*'; else if (c === '_') re += '.'; else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$', 'is').test(value);
}
const mockCompanies: Row[] = [];
let mockFail = false;
/** Return the first N rows regardless of the filters (an over-broad result), to exercise the cap. */
let mockIgnoreFiltersRows: number | null = null;
const mockQueries: Array<Record<string, unknown>> = [];
function mockTable() {
  const tests: Array<(r: Row) => boolean> = []; let cap = Infinity; const q: Record<string, unknown> = {};
  const b: any = {
    select: () => b,
    limit: (n: number) => { cap = n; return b; },
    eq: (c: string, v: unknown) => { q[c] = v; tests.push((r) => r[c] === v); return b; },
    ilike: (c: string, v: string) => { q[c] = v; tests.push((r) => ilikeMatch(String(r[c] ?? ''), v)); return b; },
    is: (c: string, v: unknown) => { tests.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
    then: (ok: any, ko: any) => {
      mockQueries.push(q);
      return Promise.resolve(mockFail
        ? { data: null, error: { message: 'boom' } }
        : { data: mockIgnoreFiltersRows !== null ? mockCompanies.slice(0, Math.min(mockIgnoreFiltersRows, cap)) : mockCompanies.filter((r) => tests.every((t) => t(r))).slice(0, cap), error: null }).then(ok, ko);
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
  mockIgnoreFiltersRows = null;
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
  // exact root, then the subdomain suffix, for each column - never the raw host as a wildcard-free key
  expect(mockQueries.map((q) => q.website_domain ?? q.admin_email_domain)).toEqual(['acme.com', '%.acme.com', 'acme.com', '%.acme.com']);
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
  for (const email of ['p@gmail.com', 'p@outlook.com', '', null, undefined]) {
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

it('c6 F1: a row stamped with a HOST (legacy) is found from the same host and from the root', async () => {
  mockCompanies.push({ id: 'c-legacy', name: 'Legacy', status: 'active', website_domain: null, admin_email_domain: 'mail.legacy.io' });
  for (const email of ['jane2@mail.legacy.io', 'bob@legacy.io', 'eve@eu.legacy.io']) {
    const r = await findCompaniesByVerifiedEmailDomain(email);
    expect([email, r]).toEqual([email, { ok: true, domain: 'legacy.io', companies: [{ company_id: 'c-legacy', company_name: 'Legacy' }] }]);
  }
});

it('the subdomain suffix never widens to a different registrable domain (notacme.com, acme.com.evil.io)', async () => {
  mockCompanies.push(
    { id: 'c-not', name: 'Not Acme', status: 'active', website_domain: 'notacme.com', admin_email_domain: null },
    { id: 'c-evil', name: 'Evil', status: 'active', website_domain: 'acme.com.evil.io', admin_email_domain: null },
  );
  const r = await findCompaniesByVerifiedEmailDomain('p@acme.com');
  expect(r.ok && r.companies.map((c: { company_id: string }) => c.company_id)).toEqual(['c-acme']);
});

it('7c: a soft-deleted company is out of the match and the ambiguity count; a suspended one is in', async () => {
  mockCompanies.push(
    { id: 'c-dead', name: 'Dead', status: 'inactive', deleted_at: '2026-10-01T00:00:00Z', website_domain: null, admin_email_domain: 'zeta.io' },
  );
  const zeta = await findCompaniesByVerifiedEmailDomain('p@zeta.io');
  expect(zeta.ok && zeta.companies.map((c: { company_id: string }) => c.company_id)).toEqual(['c-zeta']);
  mockCompanies[1].status = 'suspended';
  const susp = await findCompaniesByVerifiedEmailDomain('p@zeta.io');
  expect(susp.ok && susp.companies.map((c: { company_id: string }) => c.company_id)).toEqual(['c-zeta']);
});

it('PSL guard: an email whose host IS a public suffix is ambiguous - never a match - even with a company stored under it', async () => {
  mockCompanies.push({ id: 'c-sfx', name: 'Suffix Holder', status: 'active', website_domain: null, admin_email_domain: 'co.il' });
  for (const email of ['x@co.il', 'x@github.io', 'x@com.sg']) {
    const r = await findCompaniesByVerifiedEmailDomain(email);
    expect([email, r]).toEqual([email, { ok: true, domain: expect.any(String), companies: [], ambiguous: true }]);
  }
  expect(mockQueries).toEqual([]); // decided before any read
});

it('PSL: foo.co.il and bar.co.il are different registrable domains', async () => {
  mockCompanies.push({ id: 'c-foo', name: 'Foo IL', status: 'active', website_domain: null, admin_email_domain: 'foo.co.il' });
  const r = await findCompaniesByVerifiedEmailDomain('bar@bar.co.il');
  expect(r).toEqual({ ok: true, domain: 'bar.co.il', companies: [] });
});

it('cap: a candidate query returning MAX_DOMAIN_CANDIDATES rows is potentially incomplete -> ambiguous, never a decision', async () => {
  for (let i = 0; i < 9; i++) mockCompanies.push({ id: `c-junk-${i}`, name: `Junk ${i}`, status: 'active', website_domain: `junk${i}.example`, admin_email_domain: null });
  mockIgnoreFiltersRows = 10; // acme + zeta + uk + 7 junk... the first 10 rows, only c-acme decides for acme.com
  const r = await findCompaniesByVerifiedEmailDomain('p@acme.com');
  expect(r).toMatchObject({ ok: true, ambiguous: true });
});

it('PSL guard: a host with no registrable root (no dot) is ambiguous, never a match', async () => {
  const r = await findCompaniesByVerifiedEmailDomain('not-an-email');
  expect(r).toMatchObject({ ok: true, companies: [], ambiguous: true });
  expect(mockQueries).toEqual([]);
});
