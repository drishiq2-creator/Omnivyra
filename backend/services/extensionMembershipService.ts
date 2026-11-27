/**
 * EXTENSION MEMBERSHIP - the ONE rule for "may this principal hold an extension session for this company?",
 * applied at bootstrap (before a claim code exists), at redeem (before a token is issued), at validate, and (item F)
 * on EVERY signed extension request in backend/middleware/extensionAuthMiddleware.ts.
 *
 * Rule (the strict one validate always applied, plus the company state bootstrap always applied):
 *   an ACTIVE user_company_roles row for (user, company) AND the company is active.
 * NO platform-super-admin bypass and NO legacy fallbacks (content-architect cookie principal, invited-admin role):
 * an extension session acts in the company's name on LinkedIn, so it needs a real membership. Before Phase E,
 * bootstrap admitted those principals through enforceCompanyAccess and validate then refused them AFTER the code was
 * redeemed (the extension signed in, then dropped out on its first validate).
 *
 * Item E: a PLATFORM SUPER ADMIN with no active membership in the company is still refused (no bypass - the session
 * would hand the tenant's queued LinkedIn actions to the admin's own browser and could bind the admin's LinkedIn
 * member to the tenant's Sales Navigator quota), but the refusal says so: `platformAdminWithoutMembership: true`, so
 * bootstrap / redeem answer EXTENSION_PLATFORM_ADMIN_NOT_MEMBER and support knows to get a tenant role or have a
 * Company Admin pair. The platform-admin consult runs only AFTER a membership denial and never changes the decision;
 * if it fails the refusal falls back to the generic code (fail-closed either way).
 *
 * Implemented with TenantGuard.assertTenantAccess (the canonical membership + company-state read, with its
 * transient-vs-definite error classification), with the super-admin consult and bypass switched off.
 * TENANT_LOOKUP_ERROR is 'unavailable' (callers answer 503), never a denial and never an allow.
 */

import { assertTenantAccess } from '../security/TenantGuard';
import { isPlatformSuperAdmin } from './rbacService';

export type ExtensionMembershipDecision =
  | { ok: true }
  | { ok: false; outcome: 'denied'; reason: string; platformAdminWithoutMembership?: true }
  | { ok: false; outcome: 'unavailable'; reason: 'TENANT_LOOKUP_ERROR' };

/** Bootstrap / redeem refusal code for a platform super admin with no active role in the company (item E). */
export const EXTENSION_PLATFORM_ADMIN_NOT_MEMBER = 'EXTENSION_PLATFORM_ADMIN_NOT_MEMBER';
export const EXTENSION_PLATFORM_ADMIN_NOT_MEMBER_MESSAGE =
  'Platform administrators cannot pair the browser extension to a company they are not an active member of. '
  + 'A Company Admin of this company must pair, or the administrator needs an active role in this company.';

/** Membership denials where "is this a platform admin?" explains the refusal (not company state). */
const NO_MEMBERSHIP_REASONS = new Set(['NOT_A_MEMBER', 'STALE_MEMBERSHIP']);

async function platformAdminConsult(userId: string): Promise<boolean> {
  try {
    return await isPlatformSuperAdmin(userId);
  } catch {
    return false;
  }
}

export async function checkExtensionMembership(userId: string, organizationId: string): Promise<ExtensionMembershipDecision> {
  const r = await assertTenantAccess({
    userId,
    organizationId,
    consultPlatformSuperAdmin: false,
    options: { noPlatformBypass: true },
  });
  if (r.ok === true) return { ok: true };
  const reason = String((r as { reason?: unknown }).reason ?? 'NOT_A_MEMBER');
  if (reason === 'TENANT_LOOKUP_ERROR') return { ok: false, outcome: 'unavailable', reason: 'TENANT_LOOKUP_ERROR' };
  if (NO_MEMBERSHIP_REASONS.has(reason) && (await platformAdminConsult(userId))) {
    return { ok: false, outcome: 'denied', reason, platformAdminWithoutMembership: true };
  }
  return { ok: false, outcome: 'denied', reason };
}

/** The bootstrap / redeem 403 body for a denied decision (one place, so the two routes cannot drift). */
export function extensionMembershipDeniedBody(decision: { reason: string; platformAdminWithoutMembership?: true }) {
  if (decision.platformAdminWithoutMembership) {
    return { success: false as const, error: EXTENSION_PLATFORM_ADMIN_NOT_MEMBER, message: EXTENSION_PLATFORM_ADMIN_NOT_MEMBER_MESSAGE };
  }
  return {
    success: false as const,
    error: 'EXTENSION_MEMBERSHIP_REQUIRED',
    message: 'The browser extension needs an active membership in this company.',
  };
}
