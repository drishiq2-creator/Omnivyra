/**
 * approvedAccessRequestService.ts - the Super-Admin-vetted company path (owner ruling 2026-11-19).
 *
 * A person who cannot self-sign-up (free mail, or a corporate email whose registrable domain is not the
 * website's) submits POST /api/access-request. A Super Admin vets it (/api/admin/access-requests/approve),
 * which opens the company and stamps access_requests.organization_id. When that person later onboards
 * with a VERIFIED session email equal to the approved request's email, onboarding binds them to THAT
 * company - for ANY email, before any domain matching (setup-company Path B, onboarding/complete).
 *
 * Only the verified SESSION email is ever looked up (callers pass it; never a typed one). An approved
 * request without organization_id is treated as absent. A failed read is NOT "no approval": callers
 * refuse (503) rather than fall through to domain matching, which could send an approved corporate
 * requester's join request to the company that happens to hold their email domain.
 */
import { supabase } from '../db/supabaseClient';

/**
 * The machine field on a self-signup refusal that should send the person to the vetted path
 * (POST /api/access-request). It rides ALONGSIDE the existing `code`; codes and bodies are otherwise
 * unchanged (the UI keys on the codes).
 */
export const ACCESS_REQUEST_NEXT = 'access_request' as const;

/** The one normalisation of an access-request email (stored by /api/access-request, matched here). */
export function normalizeAccessRequestEmail(email: string | null | undefined): string {
  return String(email ?? '').trim().toLowerCase();
}

export type ApprovedAccessLookup = { ok: true; organizationId: string | null } | { ok: false };

/** Rows read per lookup: several approved rows are possible only on legacy data; the first usable one wins. */
const MAX_APPROVED_ROWS = 5;

export async function findApprovedAccessRequestCompany(
  verifiedEmail: string | null | undefined,
): Promise<ApprovedAccessLookup> {
  const email = normalizeAccessRequestEmail(verifiedEmail);
  if (!email.includes('@')) return { ok: true, organizationId: null };
  const { data, error } = await supabase
    .from('access_requests')
    .select('id, organization_id')
    .eq('email', email)
    .eq('status', 'approved')
    .not('organization_id', 'is', null)
    .limit(MAX_APPROVED_ROWS);
  if (error) return { ok: false };
  // Decided in code as well: an approved row without organization_id is absent, whatever the filter did.
  const row = (Array.isArray(data) ? data : []).find(
    (r: { organization_id?: unknown }) => typeof r?.organization_id === 'string' && r.organization_id.trim() !== '',
  ) as { organization_id: string } | undefined;
  return { ok: true, organizationId: row ? row.organization_id : null };
}
