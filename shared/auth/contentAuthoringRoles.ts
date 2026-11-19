/**
 * WHO MAY AUTHOR CONTENT (company blog series / relationships / brief suggestions, canonical content writes) - the ONE
 * role source for the server gate and the UI (04/89 2026-11-19: one source, not two lists that drift).
 *
 * DEPENDENCY-FREE: safe to import from BOTH client and server bundles. It imports nothing but ./roleNormalization (itself
 * import-free) - no server code, supabase, next or env. sharedAuthRoleModules.test.ts fails on any other import.
 *
 * DIRECTION: the SERVER is authoritative. This is the server's definition, MOVED here from
 * backend/services/content/contentWriteAuthz.ts (whose CONTENT_WRITE_ROLES now IS this set; the set is the repository's
 * authoring policy, rbacService PERMISSIONS.CREATE_CAMPAIGN), and the UI consumes it. contentAuthoringRolesPin.test.ts
 * pins the set and that the server gate consumes it.
 *
 * The server gate enforceContentWriteRole goes through rbacService enforceRole, which compares getUserRole's NORMALISED
 * role: CONTENT_MANAGER / CONTENT_PLANNER count as CONTENT_CREATOR (allowed), VIEWER / CONTENT_ENGAGER as VIEW_ONLY
 * (refused). "AI spend follows authoring": a POST that can reach the AI gateway (brief-suggestions) needs this role too.
 */
import { normalizeRoleName } from './roleNormalization';

/** Normalised role names that may author content. */
export const CONTENT_AUTHORING_ROLES = Object.freeze([
  'COMPANY_ADMIN',
  'CONTENT_CREATOR',
  'CONTENT_REVIEWER',
  'CONTENT_PUBLISHER',
  'SUPER_ADMIN',
] as const);

/** True when `role` (raw or already normalised) may author blog content; normalised exactly as the server normalises. */
export function canAuthorBlog(role: string | null | undefined): boolean {
  const normalized = normalizeRoleName(role);
  return normalized !== null && (CONTENT_AUTHORING_ROLES as readonly string[]).includes(normalized);
}
