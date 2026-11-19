/**
 * PIN: content authoring roles have ONE source (shared/auth/contentAuthoringRoles.ts) and the SERVER gate
 * (enforceContentWriteRole) consumes it (04/89/7c 2026-11-19). The server is authoritative; the module holds its
 * definition and the UI reads it. This suite covers the SERVER side (04 adds the UI-side import pin).
 */
import { CONTENT_AUTHORING_ROLES, canAuthorBlog } from '../../../shared/auth/contentAuthoringRoles';
import { ADMIN_SPELLINGS, hasRoleLiteralList, readRepo, stripComments } from '../helpers/rolePinHelpers';

const mockAllowed: { roles: unknown } = { roles: null };
jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));
jest.mock('../../services/rbacService', () => ({
  Role: jest.requireActual('../../services/rbacPrimitives').Role,
  enforceRole: jest.fn(async (input: { allowedRoles: unknown }) => {
    mockAllowed.roles = input.allowedRoles;
    return { userId: 'u', role: 'COMPANY_ADMIN' };
  }),
}));
/* eslint-disable @typescript-eslint/no-var-requires */
const { normalizeRole } = require('../../services/rbacPrimitives');
const { CONTENT_WRITE_ROLES, enforceContentWriteRole } = require('../../services/content/contentWriteAuthz');
/* eslint-enable @typescript-eslint/no-var-requires */

const GATE_FILE = 'backend/services/content/contentWriteAuthz.ts';

describe('content authoring roles: one source, consumed by the server gate', () => {
  it('the policy (rbacService PERMISSIONS.CREATE_CAMPAIGN)', () => {
    expect([...CONTENT_AUTHORING_ROLES]).toEqual(['COMPANY_ADMIN', 'CONTENT_CREATOR', 'CONTENT_REVIEWER', 'CONTENT_PUBLISHER', 'SUPER_ADMIN']);
  });

  it('the server set IS the module set (same object, not a copy)', () => {
    expect(CONTENT_WRITE_ROLES).toBe(CONTENT_AUTHORING_ROLES);
  });

  it('the server gate file imports the module and keeps no literal role list', () => {
    const code = stripComments(readRepo(GATE_FILE));
    expect(code).toMatch(/import\s*\{\s*CONTENT_AUTHORING_ROLES\s*\}\s*from\s*'\.\.\/\.\.\/\.\.\/shared\/auth\/contentAuthoringRoles'/);
    expect(code).toMatch(/CONTENT_WRITE_ROLES[^=]*=\s*CONTENT_AUTHORING_ROLES\s*;/);
    expect(hasRoleLiteralList(code)).toBe(false);
  });

  it('enforceContentWriteRole hands enforceRole exactly the module set', async () => {
    await enforceContentWriteRole({ req: {}, res: {}, companyId: 'c-1' });
    expect(mockAllowed.roles).toEqual([...CONTENT_AUTHORING_ROLES]);
  });

  it('canAuthorBlog decides what the server decides (normalizeRole(role) in CONTENT_WRITE_ROLES) over every spelling', () => {
    const corpus = [...ADMIN_SPELLINGS, 'SUPER_ADMIN', 'VIEW_ONLY', 'VIEWER', 'viewer', 'CONTENT_ENGAGER', 'CONTENT_CREATOR', 'content creator',
      'CONTENT_MANAGER', 'CONTENT_PLANNER', 'CONTENTPLANNER', 'CONTENT_REVIEWER', 'CONTENT_PUBLISHER', 'CONTENT_ARCHITECT', 'garbage', '', null, undefined];
    for (const r of corpus) expect([r, canAuthorBlog(r)]).toEqual([r, CONTENT_WRITE_ROLES.includes(normalizeRole(r))]);
  });

  it.each([...ADMIN_SPELLINGS, 'CONTENT_CREATOR', 'CONTENT_MANAGER', 'CONTENT_REVIEWER', 'CONTENT_PUBLISHER'])('%j -> true', (r) => {
    expect(canAuthorBlog(r)).toBe(true);
  });
  it.each(['VIEW_ONLY', 'VIEWER', 'CONTENT_ENGAGER', 'garbage', null, ''])('%j -> false', (r) => {
    expect(canAuthorBlog(r as string | null)).toBe(false);
  });
});
