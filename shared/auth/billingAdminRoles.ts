/**
 * WHO MAY MANAGE BILLING - the ONE role source for the server gate and the UI (04/89 2026-11-19: one source, not two
 * lists that drift).
 *
 * DEPENDENCY-FREE: safe to import from BOTH client and server bundles. It imports nothing but ./roleNormalization (itself
 * import-free) - no server code, supabase, next or env. sharedAuthRoleModules.test.ts fails on any other import.
 *
 * DIRECTION: the SERVER is authoritative. This is the server's definition, MOVED here from
 * backend/security/billingWriteRoles.ts (whose BILLING_WRITE_ROLES now IS this set), and the UI consumes it. Changing
 * who may manage billing is an owner-ruling change made HERE; billingAdminRolesPin.test.ts pins the set and that the
 * server gate consumes it.
 *
 * Owner ruling 2026-11-13: billing WRITES (buy credits, start a subscription / top-up session, change the billing
 * profile or billing context) are company admins only. The server applies the set through requireTenantAccess
 * { requireNormalizedRoleIn }, which compares the NORMALISED stored role ('ADMIN', 'COMPANYADMIN', 'company admin' all
 * count as COMPANY_ADMIN). Platform super admins also bypass the gate inside TenantGuard (not via this set).
 */
import { normalizeRoleName } from './roleNormalization';

/** Normalised role names that may manage billing. */
export const BILLING_ADMIN_ROLES: readonly string[] = Object.freeze(['COMPANY_ADMIN', 'SUPER_ADMIN']);

/** True when `role` (raw or already normalised) may manage billing; normalised exactly as the server normalises. */
export function canManageBilling(role: string | null | undefined): boolean {
  const normalized = normalizeRoleName(role);
  return normalized !== null && BILLING_ADMIN_ROLES.includes(normalized);
}
