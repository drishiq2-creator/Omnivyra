/**
 * POST /api/super-admin/companies created a company with `website` but NO website_domain (the column was
 * simply omitted), so the company escaped idx_companies_website_domain_unique and every website-only
 * lookup, and violated the writer invariants A/B (owner ruling 2026-11-19: identity = website domain).
 * The companies-domain writer guard could not see it, because it only looked for writes that NAME a
 * domain column (89, 2026-11-19).
 *
 * Now: through companyIdentityWriter (companyWebsiteCreation), with approve.ts's website-uniqueness
 * behaviour - 409 COMPANY_WEBSITE_TAKEN on a live holder (and on a concurrent 23505), 422 invalid,
 * 409 public suffix - nothing written on any refusal.
 *
 * REAL: the route, companyWebsiteCreation, companyIdentityWriter, companyMatchService over the in-memory
 * routeAuthHarness. FAKED: the capability gate and admin rate limiter, profile save, telemetry.
 */
import { seed, rows, invoke, uniqueKey, resetHarnessDeclarations } from '../helpers/routeAuthHarness';

const mockBeforeWrite: { fn: ((table: string, op: string) => void) | null } = { fn: null };
function mockWrap(builder: Record<string, unknown>, table: string) {
  for (const op of ['update', 'delete', 'insert'] as const) {
    const orig = builder[op] as (p?: unknown, o?: unknown) => Record<string, unknown>;
    builder[op] = (p?: unknown, o?: unknown) => { if (mockBeforeWrite.fn) mockBeforeWrite.fn(table, op); return orig(p, o); };
  }
  return builder;
}
jest.mock('@/config', () => ({ config: { DEV_USER_ID: '', NODE_ENV: 'production' } }));
jest.mock('../../db/supabaseClient', () => {
  const fake = require('../helpers/routeAuthHarness').supabaseModule().supabase;
  const wrapped = { ...fake, from: (t: string) => mockWrap(fake.from(t), t) };
  return { supabase: wrapped, default: wrapped, getSupabase: () => wrapped, supabaseAdmin: wrapped };
});
jest.mock('../../db/writeOwner', () => {
  const base = require('../helpers/routeAuthHarness').writeOwnerModule();
  return { ownedDbTable: (t: string) => mockWrap(base.ownedDbTable(t), t) };
});
jest.mock('../../security/requireCapability', () => ({
  requireCapability: async () => ({ ok: true, principal: { userId: 'u-super' } }),
}));
jest.mock('../../services/requestAccessService', () => ({ requireAdminRateLimit: async () => true }));
const mockProfiles: Array<Record<string, unknown>> = [];
jest.mock('../../services/companyProfileService', () => ({ saveProfile: async (p: Record<string, unknown>) => { mockProfiles.push(p); } }));
jest.mock('../../services/lifecycleGovernance', () => ({ cascadeDisableCompany: jest.fn(), hardDeleteCompany: jest.fn(), softDeleteCompanyWithCascade: jest.fn() }));
jest.mock('../../services/auditActorService', () => ({ insertAuditLogStrict: jest.fn(async () => undefined), SYSTEM_USER_ID: 'system' }));
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../services/companyIdentityDriftService', () => ({ monitorCompanyIdentityDrift: jest.fn(() => null) }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

import route from '../../../pages/api/super-admin/companies';

const HOLDER = '30930930-0000-4000-8000-0000000006a0';
let seeded = new Set<string>();
const world = (companies: Record<string, unknown>[] = []) => {
  seed({ companies });
  seeded = new Set(rows('companies').map((c) => String(c.id)));
};
const created = () => rows('companies').filter((c) => !seeded.has(String(c.id)));
const post = (body: Record<string, unknown>) => invoke(route as never, { method: 'POST', body });
const holder = (over: Record<string, unknown> = {}) => ({ id: HOLDER, name: 'Beta Holder', status: 'active', website: 'https://beta.test', website_domain: 'beta.test', admin_email_domain: null, ...over });

beforeEach(() => {
  resetHarnessDeclarations();
  mockBeforeWrite.fn = null;
  mockProfiles.length = 0;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

describe('POST /api/super-admin/companies writes the company identity through the writer', () => {
  it('201: website AND website_domain (the registrable root) are written together; admin_email_domain null', async () => {
    world();
    const r = await post({ name: ' Gamma Labs ', website: 'https://www.Shop.Gamma.test/path?q=1', industry: 'Retail' });
    expect(r.status).toBe(201);
    expect(created()).toEqual([expect.objectContaining({
      name: 'Gamma Labs', status: 'active', industry: 'Retail',
      website: 'https://shop.gamma.test', website_domain: 'gamma.test', admin_email_domain: null,
    })]);
    expect(r.body.company).toEqual(expect.objectContaining({ id: created()[0].id, website_domain: 'gamma.test' }));
    expect(mockProfiles).toEqual([expect.objectContaining({ company_id: created()[0].id, name: 'Gamma Labs' })]);
  });

  it('409 COMPANY_WEBSITE_TAKEN when a LIVE company holds the website domain (any host / scheme / path), nothing written', async () => {
    world([holder()]);
    const r = await post({ name: 'Copycat', website: 'http://www.beta.test/about' });
    expect([r.status, r.body.code]).toEqual([409, 'COMPANY_WEBSITE_TAKEN']);
    expect(created()).toEqual([]);
    expect(mockProfiles).toEqual([]);
  });

  it('CONTROL: a SOFT-DELETED holder does not hold it', async () => {
    world([holder({ deleted_at: '2026-10-01T00:00:00Z' })]);
    const r = await post({ name: 'Beta Again', website: 'beta.test' });
    expect(r.status).toBe(201);
    expect(created()).toEqual([expect.objectContaining({ website_domain: 'beta.test' })]);
  });

  it('a CONCURRENT create that wins idx_companies_website_domain_unique (23505) -> 409 COMPANY_WEBSITE_TAKEN, not 500', async () => {
    world();
    uniqueKey('companies', 'website_domain');
    let raced = false;
    mockBeforeWrite.fn = (table, op) => {
      if (table !== 'companies' || op !== 'insert' || raced) return;
      raced = true;
      rows('companies').push(holder());
    };
    const r = await post({ name: 'Racer', website: 'beta.test' });
    expect(raced).toBe(true);
    expect([r.status, r.body.code]).toEqual([409, 'COMPANY_WEBSITE_TAKEN']);
    expect(created().map((c) => c.id)).toEqual([HOLDER]);
    expect(mockProfiles).toEqual([]);
  });

  it('422 COMPANY_WEBSITE_INVALID for an unusable website; 409 COMPANY_WEBSITE_AMBIGUOUS for a public suffix; nothing written', async () => {
    world();
    const bad = await post({ name: 'Local', website: 'http://localhost:3000' });
    const psl = await post({ name: 'Suffix', website: 'https://co.uk' });
    expect([bad.status, bad.body.code, psl.status, psl.body.code]).toEqual([422, 'COMPANY_WEBSITE_INVALID', 409, 'COMPANY_WEBSITE_AMBIGUOUS']);
    expect(created()).toEqual([]);
  });

  it('CONTROL (unchanged): name and website are still required (400)', async () => {
    world();
    const r = await post({ name: 'No Site' });
    expect(r.status).toBe(400);
    expect(created()).toEqual([]);
  });
});
