/**
 * c6 2026-11-18 - the getUserRole class (89/a9/7c/b3). The class is SEMANTIC: a FAILED role read must reach the client
 * as a retryable 503 (+ Retry-After), never as "you lack the role" (a final 403) and never as echoed text.
 *   1. respondRoleRefusal - the one response shape;
 *   2. BEHAVIOUR: real call sites driven with a failed role read answer 503 (not a grep for one spelling - 7c);
 *   3. CLOSED SET: every file that calls getUserRole handles ROLE_LOOKUP_FAILED, or is on KNOWN_UNHANDLED (a list that
 *      can only shrink: an entry that now handles it, or no longer calls getUserRole, fails as stale).
 */
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => { throw new Error('no db'); } } }));
import * as fs from 'fs';
import * as path from 'path';

let roleAnswer: { role: string | null; error: string | null } = { role: null, error: 'ROLE_LOOKUP_FAILED' };
jest.mock('../../services/rbacService', () => {
  const actual = jest.requireActual('../../services/rbacService');
  return { ...actual, getUserRole: jest.fn(async () => roleAnswer), isSuperAdmin: jest.fn(async () => false) };
});
jest.mock('../../services/supabaseAuthService', () => ({ getSupabaseUserFromRequest: async () => ({ user: { id: 'u1' }, error: null }) }));
jest.mock('../../services/rbacPrimitives', () => ({ ...jest.requireActual('../../services/rbacPrimitives'), getCompanyRoleIncludingInvited: async () => null }));

import { respondRoleRefusal, ROLE_LOOKUP_FAILED } from '../../services/rbacService';
import { resolveCompanyAccess } from '../../services/contentArchitectService';

function res() {
  const r: any = { statusCode: 0, body: undefined, headers: {} as Record<string, unknown> };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.setHeader = (k: string, v: unknown) => { r.headers[k] = v; return r; };
  return r;
}
const req = () => ({ headers: {}, query: {}, cookies: {} }) as any;

describe('1. respondRoleRefusal', () => {
  test('ROLE_LOOKUP_FAILED -> 503 retryable with Retry-After (unknown, not denied)', () => {
    const r = res(); respondRoleRefusal(r, ROLE_LOOKUP_FAILED);
    expect([r.statusCode, r.body]).toEqual([503, { error: 'ROLE_LOOKUP_FAILED', retryable: true }]);
    expect(r.headers['Retry-After']).toBe('5');
  });
  test('COMPANY_ACCESS_DENIED keeps its 403 contract', () => {
    const r = res(); respondRoleRefusal(r, 'COMPANY_ACCESS_DENIED');
    expect([r.statusCode, r.body]).toEqual([403, { error: 'COMPANY_ACCESS_DENIED' }]);
  });
  test.each([[null], [undefined], ['some unexpected internal text']])('%p -> generic 403 FORBIDDEN_ROLE (never echoed)', (e) => {
    const r = res(); respondRoleRefusal(r, e as any);
    expect([r.statusCode, r.body]).toEqual([403, { error: 'FORBIDDEN_ROLE' }]);
  });
});

describe('2. behaviour: a failed role read reaches the client as 503, not 403', () => {
  test('contentArchitectService.resolveCompanyAccess (one of the hand-written sites 7c found)', async () => {
    roleAnswer = { role: null, error: ROLE_LOOKUP_FAILED };
    const r = res();
    expect(await resolveCompanyAccess(req(), r, 'co-1')).toBeNull();
    expect(r.statusCode).toBe(503);
    expect(r.headers['Retry-After']).toBe('5');
  });
  test('control: a genuine no-role answer is still a 403 there', async () => {
    roleAnswer = { role: null, error: null };
    const r = res();
    expect(await resolveCompanyAccess(req(), r, 'co-1')).toBeNull();
    expect(r.statusCode).toBe(403);
  });
});

describe('3. closed set over getUserRole callers', () => {
  // Callers that still do NOT distinguish a failed read (they fail CLOSED - deny/403 - so not a security hole), queued
  // as the next sweep. The list can only shrink.
  const KNOWN_UNHANDLED = [
    'backend/services/prospectIdentity/attributeAuthorityStore.ts',
    'backend/services/reportCardServiceModel.ts',
    'backend/services/userManagementService.ts',
    'pages/api/admin/autonomous.ts',
    'pages/api/admin/consumption/apis.ts',
    'pages/api/admin/consumption/llm.ts',
    'pages/api/admin/credits/index.ts',
    'pages/api/admin/delete-campaign.ts',
    'pages/api/campaigns/index.ts',
    'pages/api/campaigns/list.ts',
    'pages/api/campaigns/pending/[id]/approve.ts',
    'pages/api/company/llm-providers.ts',
    'pages/api/recommendations/[id]/create-campaign.ts',
    'pages/api/social-accounts/refresh-tokens.ts',
    'pages/api/social-accounts/status.ts',
    'pages/api/team/assign-week.ts',
  ];
  const files: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.next', 'tests'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  for (const d of ['pages', 'backend', 'lib']) walk(path.join(process.cwd(), d));
  const rel = (f: string) => path.relative(process.cwd(), f).split(path.sep).join('/');
  const src = (f: string) => fs.readFileSync(f, 'utf8');
  const callers = files.filter((f) => /getUserRole\(/.test(src(f)) && !/export const getUserRole/.test(src(f)));
  const handles = (f: string) => /ROLE_LOOKUP_FAILED|respondRoleRefusal|RoleLookupFailedError/.test(src(f));

  test('positive control: the scan finds the callers (>= 90 files)', () => {
    expect(callers.length).toBeGreaterThanOrEqual(90);
  });
  test('every getUserRole caller handles a failed read, or is on the shrinking KNOWN_UNHANDLED list', () => {
    const unhandled = callers.filter((f) => !handles(f)).map(rel).sort();
    expect(unhandled).toEqual([...KNOWN_UNHANDLED].sort());
  });
  test('no response echoes getUserRole\'s error', () => {
    expect(files.filter((f) => /json\(\{\s*error:\s*roleError\s*(\?\?|\})/.test(src(f))).map(rel)).toEqual([]);
  });
});
