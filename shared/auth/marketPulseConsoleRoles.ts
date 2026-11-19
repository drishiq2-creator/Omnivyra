/**
 * WHO MAY USE THE MARKET PULSE SCAN CONSOLE - the ONE role source for the server gate and the UI (04/89 2026-11-19: one
 * source, not two lists that drift).
 *
 * DEPENDENCY-FREE: safe to import from BOTH client and server bundles. It imports nothing but ./roleNormalization (itself
 * import-free) - no server code, supabase, next or env. sharedAuthRoleModules.test.ts fails on any other import.
 *
 * DIRECTION: the SERVER is authoritative. This is the server's definition, MOVED here from
 * backend/services/marketPulse/consoleAccess.ts (whose MARKET_PULSE_CONSOLE_ROLES / isMarketPulseConsoleRole now ARE
 * this set and predicate), and the UI consumes it. marketPulseConsoleRolesPin.test.ts pins the set and that the server
 * gate consumes it.
 *
 * Owner ruling 2026-11-13: the scan console (start / cancel scans, run detail, history, automation, finding actions,
 * company-wide Executive-room writes) is company-admin only.
 *
 * CONTENT_ARCHITECT is deliberately NOT allowed (b3 on the owner's ruling, 2026-11-19). On today's main it is the
 * legacy synthetic every-company principal; under the ruling the new CA is Omnivyra support staff who edit a company
 * PROFILE on an open help request and never run Market Pulse. So the console refuses it whether or not the CA
 * removal lands first. A name the normaliser does not know (such as the synthetic CONTENT_ARCHITECT) is never admitted.
 */
import { normalizeRoleName } from './roleNormalization';

/** Role names that may use the console: normalised company admins and super admins only. */
export const MARKET_PULSE_CONSOLE_ROLE_NAMES: readonly string[] = Object.freeze(['SUPER_ADMIN', 'COMPANY_ADMIN']);

/**
 * True when `role` may use the console. The role is normalised the way the server normalises it
 * ('ADMIN' / 'company admin' -> COMPANY_ADMIN); a role the normaliser does not recognise is refused.
 */
export function canUseMarketPulseConsole(role: string | null | undefined): boolean {
  if (typeof role !== 'string') return false;
  const name = normalizeRoleName(role);
  return name !== null && MARKET_PULSE_CONSOLE_ROLE_NAMES.includes(name);
}
