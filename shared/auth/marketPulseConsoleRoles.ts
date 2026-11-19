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
 * company-wide Executive-room writes) is company-admin only. CONTENT_ARCHITECT is the platform-internal session that
 * resolveCompanyAccess admits with that synthetic role; it is not a stored company role (normalizeRoleName returns
 * null for it), so the predicate also accepts the upper-cased raw name.
 */
import { normalizeRoleName } from './roleNormalization';

/** Role names that may use the console (normalised company roles + the synthetic CONTENT_ARCHITECT session). */
export const MARKET_PULSE_CONSOLE_ROLE_NAMES: readonly string[] = Object.freeze(['SUPER_ADMIN', 'COMPANY_ADMIN', 'CONTENT_ARCHITECT']);

/**
 * True when `role` may use the console. A stored company role is normalised the way the server normalises it
 * ('ADMIN' / 'company admin' -> COMPANY_ADMIN); a name the normaliser does not know (the synthetic CONTENT_ARCHITECT)
 * is compared upper-cased with whitespace as '_'.
 */
export function canUseMarketPulseConsole(role: string | null | undefined): boolean {
  if (typeof role !== 'string') return false;
  const name = normalizeRoleName(role) ?? role.trim().toUpperCase().replace(/\s+/g, '_');
  return MARKET_PULSE_CONSOLE_ROLE_NAMES.includes(name);
}
