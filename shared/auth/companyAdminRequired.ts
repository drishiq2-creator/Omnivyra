/**
 * "Only company admins can manage this" — the refusal vocabulary for admin-only pages (owner ruling 2026-11-20, via
 * b3: the website & lead-capture pages are admin-only, enforced SERVER-SIDE).
 *
 * Server: backend/services/companyAdminGate.requireCompanyAdmin answers a non-admin member with
 *   403 { error: 'FORBIDDEN_ROLE', code: COMPANY_ADMIN_REQUIRED, message: COMPANY_ADMIN_REQUIRED_MESSAGE }.
 * Client: isCompanyAdminRequired(status, body) recognises it, and also the older bare { error: 'FORBIDDEN_ROLE' } that
 * the pre-existing admin-only endpoints on these pages still send (the same refusal, without the code).
 *
 * A non-MEMBER (another tenant) is NOT this refusal: enforceCompanyAccess / enforceRole answer it differently
 * (COMPANY_ACCESS_DENIED / COMPANY_SCOPE_VIOLATION), and the UI must not tell them "ask an admin".
 */
export const COMPANY_ADMIN_REQUIRED = 'COMPANY_ADMIN_REQUIRED' as const;
export const COMPANY_ADMIN_REQUIRED_MESSAGE = 'Only company admins can manage this';

export function isCompanyAdminRequired(status: number, body: unknown): boolean {
  if (status !== 403 || !body || typeof body !== 'object') return false;
  const b = body as { code?: unknown; error?: unknown };
  return b.code === COMPANY_ADMIN_REQUIRED || b.error === 'FORBIDDEN_ROLE';
}
