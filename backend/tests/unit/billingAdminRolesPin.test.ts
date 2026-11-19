/**
 * PIN: billing admin roles have ONE source (shared/auth/billingAdminRoles.ts) and the SERVER gate consumes it
 * (04/89/7c 2026-11-19). The server is authoritative; the module holds its definition and the UI reads it. This suite
 * covers the SERVER side (04 adds the UI-side import pin when the UI consumes canManageBilling).
 */
import { BILLING_ADMIN_ROLES, canManageBilling } from '../../../shared/auth/billingAdminRoles';
import { ADMIN_SPELLINGS, hasRoleLiteralList, readRepo, stripComments } from '../helpers/rolePinHelpers';

jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));
/* eslint-disable @typescript-eslint/no-var-requires */
const { normalizeRole } = require('../../services/rbacPrimitives');
const { BILLING_WRITE_ROLES } = require('../../security/billingWriteRoles');
/* eslint-enable @typescript-eslint/no-var-requires */

const GATE_FILE = 'backend/security/billingWriteRoles.ts';
const ROUTES = [
  'pages/api/billing/checkout-session.ts',
  'pages/api/billing/profile.ts',
  'pages/api/billing/context.ts',
  'pages/api/billing/checkout/create-order.ts',
];

describe('billing admin roles: one source, consumed by the server gate', () => {
  it('the ruling (owner 2026-11-13): company admins only', () => {
    expect([...BILLING_ADMIN_ROLES]).toEqual(['COMPANY_ADMIN', 'SUPER_ADMIN']);
  });

  it('the server set IS the module set (same object, not a copy)', () => {
    expect(BILLING_WRITE_ROLES).toBe(BILLING_ADMIN_ROLES);
  });

  it('the server gate file imports the module and keeps no literal role list', () => {
    const code = stripComments(readRepo(GATE_FILE));
    expect(code).toMatch(/import\s*\{\s*BILLING_ADMIN_ROLES\s*\}\s*from\s*'\.\.\/\.\.\/shared\/auth\/billingAdminRoles'/);
    expect(code).toMatch(/BILLING_WRITE_ROLES[^=]*=\s*BILLING_ADMIN_ROLES\s*;/);
    expect(hasRoleLiteralList(code)).toBe(false);
  });

  it.each(ROUTES)('%s gates with requireNormalizedRoleIn: BILLING_WRITE_ROLES and lists no roles itself', (route) => {
    const code = stripComments(readRepo(route));
    expect(code).toMatch(/requireNormalizedRoleIn:\s*BILLING_WRITE_ROLES\b/);
    expect(code).not.toMatch(/require(?:Normalized)?RoleIn:\s*\[/);
    expect(hasRoleLiteralList(code)).toBe(false);
  });

  it('canManageBilling decides what the server decides (normalizeRole(role) in BILLING_WRITE_ROLES) over every spelling', () => {
    const corpus = [...ADMIN_SPELLINGS, 'SUPER_ADMIN', 'super admin', 'VIEW_ONLY', 'VIEWER', 'CONTENT_ENGAGER', 'CONTENT_CREATOR',
      'CONTENT_MANAGER', 'CONTENT_PLANNER', 'CONTENT_REVIEWER', 'CONTENT_PUBLISHER', 'CONTENT_ARCHITECT', 'garbage', '', null, undefined];
    for (const r of corpus) expect([r, canManageBilling(r)]).toEqual([r, BILLING_WRITE_ROLES.includes(normalizeRole(r))]);
  });

  it.each(ADMIN_SPELLINGS)('admin spelling %j -> true', (r) => expect(canManageBilling(r)).toBe(true));
  it.each(['VIEW_ONLY', 'VIEWER', 'CONTENT_CREATOR', 'CONTENT_REVIEWER', 'CONTENT_PUBLISHER', null, ''])('%j -> false', (r) => {
    expect(canManageBilling(r as string | null)).toBe(false);
  });
});
