/**
 * EXTENSION MEMBERSHIP - the ONE rule for "may this principal hold an extension session for this company?",
 * applied at bootstrap (before a claim code exists), at redeem (before a token is issued) and at validate.
 *
 * Rule (the strict one validate always applied, plus the company state bootstrap always applied):
 *   an ACTIVE user_company_roles row for (user, company) AND the company is active.
 * NO platform-super-admin bypass and NO legacy fallbacks (content-architect cookie principal, invited-admin role):
 * an extension session acts in the company's name on LinkedIn, so it needs a real membership. Before Phase E,
 * bootstrap admitted those principals through enforceCompanyAccess and validate then refused them AFTER the code was
 * redeemed (the extension signed in, then dropped out on its first validate).
 *
 * Implemented with TenantGuard.assertTenantAccess (the canonical membership + company-state read, with its
 * transient-vs-definite error classification), with the super-admin consult and bypass switched off.
 * TENANT_LOOKUP_ERROR is 'unavailable' (callers answer 503), never a denial and never an allow.
 */

import { assertTenantAccess } from '../security/TenantGuard';

export type ExtensionMembershipDecision =
  | { ok: true }
  | { ok: false; outcome: 'denied'; reason: string }
  | { ok: false; outcome: 'unavailable'; reason: 'TENANT_LOOKUP_ERROR' };

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
  return { ok: false, outcome: 'denied', reason };
}
