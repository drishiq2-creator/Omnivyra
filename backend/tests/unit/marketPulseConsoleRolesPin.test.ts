/**
 * PIN: the Market Pulse console roles have ONE source (shared/auth/marketPulseConsoleRoles.ts) and the SERVER gate
 * (backend/services/marketPulse/consoleAccess.ts) consumes it (04/89/7c 2026-11-19). The server is authoritative; the
 * module holds its definition and the UI reads it. This suite covers the SERVER side (04 adds the UI-side import pin).
 */
import { MARKET_PULSE_CONSOLE_ROLE_NAMES, canUseMarketPulseConsole } from '../../../shared/auth/marketPulseConsoleRoles';
import { ADMIN_SPELLINGS, hasRoleLiteralList, readRepo, stripComments } from '../helpers/rolePinHelpers';

jest.mock('../../services/contentArchitectService', () => ({ resolveCompanyAccess: jest.fn() }));
/* eslint-disable @typescript-eslint/no-var-requires */
const {
  MARKET_PULSE_CONSOLE_ROLES,
  isMarketPulseConsoleRole,
  refuseUnlessMarketPulseConsoleRole,
} = require('../../services/marketPulse/consoleAccess');
/* eslint-enable @typescript-eslint/no-var-requires */

const GATE_FILE = 'backend/services/marketPulse/consoleAccess.ts';

/** What the SERVER gate actually decides for a role (true = let through, false = 403 written). */
function serverAdmits(role: string | null | undefined): boolean {
  const res: any = { status: () => res, json: () => res };
  return refuseUnlessMarketPulseConsoleRole({ role }, res);
}

const CORPUS: Array<string | null | undefined> = [
  ...ADMIN_SPELLINGS, 'SUPER_ADMIN', 'super admin', 'CONTENT_ARCHITECT', 'content_architect', 'content architect',
  'VIEW_ONLY', 'VIEWER', 'CONTENT_ENGAGER', 'CONTENT_CREATOR', 'CONTENT_MANAGER', 'CONTENT_PLANNER', 'CONTENT_REVIEWER',
  'CONTENT_PUBLISHER', 'CAMPAIGN_ARCHITECT', 'garbage', '', null, undefined,
];

describe('Market Pulse console roles: one source, consumed by the server gate', () => {
  it('the ruling (owner 2026-11-13; CA excluded 2026-11-19): company admins and super admins ONLY', () => {
    expect([...MARKET_PULSE_CONSOLE_ROLE_NAMES]).toEqual(['SUPER_ADMIN', 'COMPANY_ADMIN']);
    expect(MARKET_PULSE_CONSOLE_ROLE_NAMES).not.toContain('CONTENT_ARCHITECT');
  });

  it('the server set and predicate ARE the module set and predicate', () => {
    expect([...MARKET_PULSE_CONSOLE_ROLES]).toEqual([...MARKET_PULSE_CONSOLE_ROLE_NAMES]);
    expect(isMarketPulseConsoleRole).toBe(canUseMarketPulseConsole);
  });

  it('the server gate file imports the module, uses it, and keeps no literal role list', () => {
    const code = stripComments(readRepo(GATE_FILE));
    expect(code).toMatch(/import\s*\{[^}]*\bMARKET_PULSE_CONSOLE_ROLE_NAMES\b[^}]*\bcanUseMarketPulseConsole\b[^}]*\}\s*from\s*'\.\.\/\.\.\/\.\.\/shared\/auth\/marketPulseConsoleRoles'/);
    expect(code).toMatch(/new Set\(\s*MARKET_PULSE_CONSOLE_ROLE_NAMES\s*\)/);
    expect(code).toMatch(/isMarketPulseConsoleRole\s*=\s*canUseMarketPulseConsole\s*;/);
    expect(hasRoleLiteralList(code)).toBe(false);
  });

  it('the server gate admits exactly what canUseMarketPulseConsole admits, over every spelling', () => {
    for (const r of CORPUS) expect([r, serverAdmits(r)]).toEqual([r, canUseMarketPulseConsole(r)]);
  });

  it.each([...ADMIN_SPELLINGS, 'SUPER_ADMIN'])('%j -> true', (r) => {
    expect(canUseMarketPulseConsole(r)).toBe(true);
  });
  it.each(['CONTENT_ARCHITECT', 'content_architect', 'content architect', 'VIEW_ONLY', 'VIEWER', 'CONTENT_CREATOR', 'CONTENT_MANAGER', 'CONTENT_REVIEWER', 'CAMPAIGN_ARCHITECT', 'garbage', '', null])('%j -> false', (r) => {
    expect(canUseMarketPulseConsole(r as string | null)).toBe(false);
  });
});
