/**
 * Market Pulse CONSOLE access (owner ruling 2026-11-13, via e9).
 *
 * The Executive room (/market-pulse) is the one customer entry and is member-readable. The scan console (the V2 tab:
 * starting / cancelling scans, run detail, history, automation, finding actions) is for company ADMINS only - the
 * UI shows its entry only when CompanyContext.isAdmin (COMPANY_ADMIN || SUPER_ADMIN), and this is the server-side
 * gate that makes that real (hiding a button is not access control). Scans spend money (LLM + data providers), so
 * starting one is an admin decision.
 *
 * Allowed: SUPER_ADMIN and COMPANY_ADMIN only. Everything else (members, invited, viewers, and the CONTENT_ARCHITECT
 * session: support staff never run Market Pulse, b3/owner 2026-11-19) gets 403 MARKET_PULSE_ADMIN_REQUIRED.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCompanyAccess } from '../contentArchitectService';
import { MARKET_PULSE_CONSOLE_ROLE_NAMES, canUseMarketPulseConsole } from '../../../shared/auth/marketPulseConsoleRoles';

/**
 * The role set and predicate are DEFINED in shared/auth/marketPulseConsoleRoles.ts - the one source the UI also reads
 * (04/89 2026-11-19). Re-exported here under the names the routes use; do not put a literal list here
 * (marketPulseConsoleRolesPin.test.ts fails on one).
 */
export const MARKET_PULSE_CONSOLE_ROLES: ReadonlySet<string> = new Set(MARKET_PULSE_CONSOLE_ROLE_NAMES);

export const isMarketPulseConsoleRole = canUseMarketPulseConsole;

/**
 * Role gate on an access ALREADY resolved by resolveCompanyAccess in the route (so the route-auth gate still sees the
 * approved primitive at the call site). Writes 403 and returns false for non-console roles.
 */
export function refuseUnlessMarketPulseConsoleRole(access: { role?: string | null }, res: NextApiResponse): boolean {
  if (isMarketPulseConsoleRole(access.role)) return true;
  res.status(403).json({ error: 'Market Pulse scan console is for company admins', code: 'MARKET_PULSE_ADMIN_REQUIRED' });
  return false;
}

/**
 * Membership + role for `companyId` (resolveCompanyAccess answers 400/401/403 itself), then the console role gate.
 * Returns the access on success; null when a response has already been written.
 */
export async function requireMarketPulseConsoleAccess(
  req: NextApiRequest,
  res: NextApiResponse,
  companyId: string | null | undefined,
): Promise<{ userId: string; role: string } | null> {
  const access = await resolveCompanyAccess(req, res, companyId);
  if (!access) return null;
  return refuseUnlessMarketPulseConsoleRole(access, res) ? access : null;
}
