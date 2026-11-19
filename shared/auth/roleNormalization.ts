/**
 * THE role-name normaliser for code that must not import server modules (UI, shared predicates). Dependency-free:
 * no supabase, next, env or server imports, so client bundles can use it.
 *
 * It MIRRORS backend/services/rbacPrimitives.ts normalizeRole, which the server gates compare against (getUserRole,
 * TenantGuard requireNormalizedRoleIn). rbacPrimitives cannot be imported here because it imports the supabase
 * client. roleNormalizationParity.test.ts pins the two to identical output over every known role and spelling
 * variant; a change to either one without the other fails CI. (Unifying them, so rbacPrimitives re-exports this one,
 * needs an edit to rbacPrimitives.ts and is left to its owner.)
 */

/** Every role value rbacPrimitives' Role table knows (same order). */
export const KNOWN_ROLE_NAMES: readonly string[] = Object.freeze([
  'SUPER_ADMIN',
  'ADMIN',
  'COMPANY_ADMIN',
  'CONTENT_MANAGER',
  'CONTENT_REVIEWER',
  'CONTENT_PUBLISHER',
  'CONTENT_PLANNER',
  'CONTENT_CREATOR',
  'CONTENT_ENGAGER',
  'VIEWER',
  'VIEW_ONLY',
]);

/**
 * Same contract as rbacPrimitives normalizeRole: trims, uppercases, turns whitespace into '_', maps the aliases
 * (ADMIN / COMPANYADMIN -> COMPANY_ADMIN; CONTENT_MANAGER / CONTENT_PLANNER / CONTENTPLANNER -> CONTENT_CREATOR;
 * CONTENT_ENGAGER / VIEWER -> VIEW_ONLY) and returns null for an empty or unknown role.
 */
export function normalizeRoleName(value?: string | null): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase().replace(/\s+/g, '_');
  if (upper === 'ADMIN' || upper === 'COMPANYADMIN') return 'COMPANY_ADMIN';
  if (upper === 'COMPANY_ADMIN') return 'COMPANY_ADMIN';
  if (upper === 'CONTENT_MANAGER' || upper === 'CONTENTPLANNER') return 'CONTENT_CREATOR';
  if (upper === 'CONTENT_PLANNER') return 'CONTENT_CREATOR';
  if (upper === 'CONTENT_CREATOR') return 'CONTENT_CREATOR';
  if (upper === 'CONTENT_ENGAGER') return 'VIEW_ONLY';
  if (upper === 'VIEWER') return 'VIEW_ONLY';
  return KNOWN_ROLE_NAMES.includes(upper) ? upper : null;
}
