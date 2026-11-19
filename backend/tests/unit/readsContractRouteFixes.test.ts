/**
 * Reads contract BLOCKING fixes in auth / onboarding / admin routes (e9: a FAILED read refuses retryably, never
 * "absent"). Behavioural on the real auth chain (routeAuthHarness, with a targeted one-read failure) for
 * company/users; a structural pin for every fixed site (the read destructures its error AND refuses on it BEFORE the
 * action the old code took on a null).
 */
import fs from 'fs';
import path from 'path';

jest.mock('@/config', () => ({ config: { DEV_USER_ID: '', NODE_ENV: 'production', REDIS_URL: 'redis://127.0.0.1:6379' } }));
jest.mock('../../db/supabaseClient', () => require('../helpers/routeAuthHarness').supabaseModule());
jest.mock('../../db/writeOwner', () => require('../helpers/routeAuthHarness').writeOwnerModule());
jest.mock('../../services/supabaseAuthService', () => require('../helpers/routeAuthHarness').authModule());
jest.mock('../../security/IdentityResolver', () => require('../helpers/routeAuthHarness').identityModule());

/* eslint-disable @typescript-eslint/no-var-requires */
const H = require('../helpers/routeAuthHarness');
const usersRoute = require('../../../pages/api/company/users').default;
/* eslint-enable @typescript-eslint/no-var-requires */
const { CO_A, invoke, rows, failSelectOnce } = H;

const adminCount = (q: { cols: string; filters: Array<{ col: string; val: unknown }> }) =>
  q.cols === 'id' && q.filters.some((f) => f.col === 'role' && f.val === 'COMPANY_ADMIN') && q.filters.some((f) => f.col === 'company_id');

describe('company/users - the one-active-admin rule is never bypassed by a failed read', () => {
  it('POST invite as COMPANY_ADMIN: the admin COUNT read fails -> 503 ADMIN_STATE_UNVERIFIABLE, nothing invited', async () => {
    const before = rows('invitations')?.length ?? 0;
    failSelectOnce('user_company_roles', adminCount);
    const r = await invoke(usersRoute, { method: 'POST', as: 'A', body: { companyId: CO_A, email: 'second.admin@acmeinc.com', role: 'COMPANY_ADMIN' }, headers: { 'idempotency-key': `inv-${Math.random()}` } });
    expect(r).toMatchObject({ status: 503, body: { code: 'ADMIN_STATE_UNVERIFIABLE', error: 'ADMIN_STATE_UNVERIFIABLE', retryable: true } });
    expect(r.headers['retry-after']).toBe('5'); // b3 standing rule (2026-11-19)
    expect(rows('invitations')?.length ?? 0).toBe(before);
  });
  it('CONTROL: the same request with the read working gets the existing 409 (an admin already exists)', async () => {
    const r = await invoke(usersRoute, { method: 'POST', as: 'A', body: { companyId: CO_A, email: 'second.admin@acmeinc.com', role: 'COMPANY_ADMIN' }, headers: { 'idempotency-key': `inv-${Math.random()}` } });
    expect(r.status).toBe(409);
    expect(r.body?.error).toBe('ADMIN_TRANSFER_REQUIRED');
  });
});

describe('every fixed site reads its error and refuses BEFORE acting (structural pin)', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // [file, the error variable, the refusal that must follow it]
  const SITES: Array<[string, string, RegExp]> = [
    ['pages/api/onboarding/setup-company.ts', 'orgCountErr', /if \(orgCountErr\) \{\s*res\.setHeader\('Retry-After', '5'\);\s*return res\.status\(503\)/],
    ['pages/api/onboarding/setup-company.ts', 'existingRoleErr', /if \(existingRoleErr\) \{\s*res\.setHeader\('Retry-After', '5'\);\s*return res\.status\(503\)/],
    ['pages/api/onboarding/setup-company.ts', 'existingRowsErr', /if \(existingRowsErr\) \{\s*res\.setHeader\('Retry-After', '5'\);\s*return res\.status\(503\)/],
    ['pages/api/company/users.ts', 'adminCountErr', /if \(adminCountErr\) \{\s*res\.setHeader\('Retry-After', '5'\);\s*return res\.status\(503\)/],
    ['pages/api/company/users.ts', 'anotherAdminErr', /if \(anotherAdminErr\) \{\s*res\.setHeader\('Retry-After', '5'\);\s*return res\.status\(503\)/],
    // grant.ts: credits are granted BEFORE this read, so its failure is a partial success (200 roleEnsured:false),
    // never a 503 - a retry minted a new grant and key and GRANTED AGAIN before c6's money SHIP (c6, 2026-11-19).
    ['pages/api/super-admin/free-credits/grant.ts', 'existingRoleErr', /if \(existingRoleErr\) \{\s*roleEnsured = false;/],
    ['pages/api/super-admin/free-credits/requests.ts', 'existingRoleErr', /if \(existingRoleErr\) \{\s*res\.setHeader\('Retry-After', '5'\);\s*return res\.status\(503\)/],
    ['pages/api/team/accept-invite.ts', 'existingRoleErr', /if \(existingRoleErr\) \{\s*res\.setHeader\('Retry-After', '5'\);\s*return res\.status\(503\)/],
    ['pages/api/super-admin/companies.ts', 'previousActiveErr', /if \(previousActiveErr\) \{\s*res\.setHeader\('Retry-After', '5'\);\s*return res\.status\(503\)/],
    ['pages/api/admin/bootstrap-super-admin.ts', 'existingCount2Err', /if \(existingCount2Err\) \{\s*res\.setHeader\('Retry-After', '5'\);\s*return res\.status\(503\)/],
    ['pages/api/admin/bootstrap-super-admin.ts', 'existingCountErr', /if \(existingCountErr\) \{\s*res\.setHeader\('Retry-After', '5'\);\s*return res\.status\(503\)/],
    ['pages/api/credits/claim-action.ts', 'membershipErr', /if \(membershipErr\) \{[\s\S]{0,300}?free_credit_claims'\)\.delete\(\)[\s\S]{0,200}?res\.setHeader\('Retry-After', '5'\);\s*return res\.status\(503\)/],
    ['pages/api/webhooks/payments/[provider].ts', 'purchaseErr', /if \(purchaseErr\) \{[\s\S]{0,400}?res\.setHeader\('Retry-After', '5'\);\s*return res\.status\(503\)/],
    ['backend/services/omnivyraWebsiteCompanyService.ts', 'rolesErr', /if \(rolesErr\) return null;/],
  ];
  it.each(SITES)('%s - %s', (rel, errVar, refusal) => {
    const s = src(rel);
    expect(s).toMatch(new RegExp(`error:\\s*${errVar}\\b`));   // the read destructures its error
    const at = s.search(refusal);
    expect(at).toBeGreaterThan(0);                              // and refuses on it
    expect(s.indexOf(`error: ${errVar}`)).toBeLessThan(at);     // after the read, before anything else uses it
  });
  it('grant.ts never refuses AFTER the credit is granted: no 503 / retryable anywhere past createCredit', () => {
    const s = src('pages/api/super-admin/free-credits/grant.ts');
    const after = s.slice(s.indexOf('createCredit('));
    expect(s.indexOf('createCredit(')).toBeGreaterThan(0);
    expect(after).not.toMatch(/status\(503\)/);
    expect(after).not.toMatch(/retryable:\s*true/);
  });

  // 7c: the 'thrown form' at these sites is covered by postgrest-js turning a fetch rejection into { error }
  // (2.105.3 dist/index.cjs:293) - but only while nobody calls .throwOnError(). Pin that absence.
  it('none of the fixed sites opts into .throwOnError() (the error-object path covers a network failure only without it)', () => {
    const files = [...new Set(SITES.map(([rel]) => rel))];
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const rel of files) expect([rel, /\.throwOnError\(/.test(src(rel))]).toEqual([rel, false]);
  });

  it('POSITIVE CONTROL: a { data }-only read does not satisfy the pin', () => {
    const old = "const { count: activeOrgCount } = await supabase.from('user_company_roles').select('id');\nif ((activeOrgCount ?? 0) >= maxOrgs) {}";
    expect(new RegExp('error:\\s*orgCountErr\\b').test(old)).toBe(false);
  });
});
