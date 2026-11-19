import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';

/**
 * POST /api/admin/access-requests/approve
 *
 * Super-admin only. Approves an access request (the vetted path, owner ruling 2026-11-19: free mail,
 * or a corporate email whose domain is not the company website's).
 *
 * On approval (Option A):
 *  1. Creates a company for the approved user through companyWebsiteCreation -> companyIdentityWriter
 *     (name = brandName, else request.company_name, else request.name):
 *     website + website_domain = the request's website (normalised; the root decides uniqueness),
 *     admin_email_domain = the corporate email root, or NULL for free mail (no domain claim).
 *     A website domain a LIVE company already holds -> 409 COMPANY_WEBSITE_TAKEN, nothing written
 *     (also on a concurrent 23505); an unusable website -> 422 COMPANY_WEBSITE_INVALID;
 *     a public-suffix website -> 409 COMPANY_WEBSITE_AMBIGUOUS; a failed check -> 503.
 *  2. Stores the new company's ID in access_requests.organization_id
 *  3. Marks the request as 'approved'
 * The approved requester who later onboards with that VERIFIED email is bound to this company
 * (setup-company / onboarding/complete), whatever their email domain.
 *
 * Credits: NOT auto-granted. Admin can issue credits manually via
 *   POST /api/super-admin/purchases/complete or manual_credit_grants.
 *
 * Domain: NOT whitelisted. Approval is per-user, not per-domain.
 *   The user bypasses domain eligibility by holding an approved request,
 *   checked at onboarding time by email match.
 *
 * Body: { requestId, adminNote?, brandName? }
 *   brandName — override for company name (defaults to request.name)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { supabase } from '@/backend/db/supabaseClient';
import { requireCapability } from '../../../../backend/security/requireCapability';
import { requireAdminRateLimit } from '../../../../backend/services/requestAccessService';
import { IDENTITY_ADMIN_ASSIGN } from '../../../../shared/contracts/security';
import { extractDomain, isFreeEmailDomain } from '../../../../backend/services/companyMatchService';
import { checkCompanyWebsite, insertCompanyWithWebsite } from '../../../../backend/services/companyWebsiteCreation';
import { normalizeCompanyDomain } from '../../../../lib/shared/domain/companyDomain';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Closure-014 (D): per-route write rate limit (before authorization and any business work).
  if (!(await requireAdminRateLimit(req, res, 'rl:admin:access-requests:approve', 20, 60, { sensitive: true }))) return;

  // Approving access requests grants org membership — IDENTITY_ADMIN_ASSIGN
  // gates this with phishing-resistant step-up. Bridge principal cannot
  // satisfy step-up so this surface is canonical-session-only post-Phase-2.
  const guard = await requireCapability(req, res, {
    capability: IDENTITY_ADMIN_ASSIGN,
    reason: 'access request approve',
  });
  if (guard.ok !== true) return;
  const adminUserId: string | null = guard.principal.userId;

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { requestId, adminNote, brandName } = body as {
    requestId:  string;
    adminNote?: string;
    brandName?: string;
  };

  if (!requestId) return res.status(400).json({ error: 'requestId is required' });

  // ── Fetch the access request ───────────────────────────────────────────────
  const { data: request, error: fetchErr } = await supabase
    .from('access_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();

  if (fetchErr || !request) return res.status(404).json({ error: 'Access request not found' });
  if (request.status !== 'pending') {
    return res.status(409).json({ error: `Request is already ${request.status}` });
  }

  const now     = new Date().toISOString();
  // The company's name: the Super Admin's override, else the company name the requester gave
  // (/api/access-request company_name), else the legacy single name field.
  const company = brandName?.trim() || request.company_name?.trim() || request.name?.trim() || request.email.split('@')[0];

  // ── Guard: one organization per email ─────────────────────────────────────
  // Another request for this email may already have been approved (duplicate
  // submission, re-application after rejection, etc.). Reuse the existing org
  // rather than creating a second company for the same person.
  const { data: priorApproval } = await supabase
    .from('access_requests')
    .select('id, organization_id')
    .eq('email', request.email)
    .eq('status', 'approved')
    .not('organization_id', 'is', null)
    .limit(1)
    .maybeSingle();

  if (priorApproval) {
    // Mark this duplicate request as approved and point it at the existing org —
    // do NOT create a second company.
    await supabase
      .from('access_requests')
      .update({
        status:          'approved',
        organization_id: priorApproval.organization_id,
        reviewed_by:     adminUserId ?? null,
        reviewed_at:     now,
        admin_note:      adminNote ?? 'Duplicate — linked to existing organization',
      })
      .eq('id', requestId);

    return res.status(200).json({
      success:      true,
      requestId,
      companyId:    priorApproval.organization_id,
      deduplicated: true,
    });
  }

  // ── 1. Create company for the approved user ────────────────────────────────
  // Through the canonical identity writer (companyIdentityWriter.createCompanyIdentity), so the identity
  // invariants A/B/D hold: website and website_domain are written together, both normalised.
  //  - website / website_domain: the website the Super Admin approved (the request's website_url),
  //    normalised (normalizePublicWebsite) and reduced to its registrable root by the writer. None ->
  //    both NULL (a free-mail requester may have no website).
  //  - admin_email_domain: the normalised root of a CORPORATE requester's email (several companies may
  //    share one - owner ruling 2026-11-19); NULL for free mail, as before (no domain claim).
  // One LIVE company per website domain: a website domain a live company already holds is refused
  // (409 COMPANY_WEBSITE_TAKEN) before anything is written; a concurrent create that wins
  // idx_companies_website_domain_unique (23505) is refused the same way.
  const emailHost = extractDomain(String(request.email ?? '')) ?? '';
  const emailRoot = normalizeCompanyDomain(String(request.email ?? ''));
  const freeMail = !emailHost || isFreeEmailDomain(emailHost) || !emailRoot || isFreeEmailDomain(emailRoot);
  const adminEmailDomain = freeMail ? null : emailRoot;

  const checked = await checkCompanyWebsite(request.website_url, { required: false });
  if (checked.ok !== true) {
    return res.status(checked.status).json({ code: checked.code, error: checked.error });
  }
  const createdCompany = await insertCompanyWithWebsite({
    record: { name: company, status: 'active', created_at: now, updated_at: now },
    website: checked.website,
    adminEmailDomain,
  });
  if (createdCompany.ok !== true) {
    return res.status(createdCompany.status).json({ code: createdCompany.code, error: createdCompany.error });
  }
  const newCompany = { id: String(createdCompany.row.id) };

  // ── 2. Update access_requests: status + link organization_id ──────────────
  // organization_id is stored so onboarding can find the pre-created company
  // by doing: SELECT * FROM access_requests WHERE email=$email AND status='approved'
  const { error: updateErr } = await supabase
    .from('access_requests')
    .update({
      status:          'approved',
      organization_id: newCompany.id,
      reviewed_by:     adminUserId ?? null,
      reviewed_at:     now,
      admin_note:      adminNote ?? null,
    })
    .eq('id', requestId);

  if (updateErr) {
    console.error('[access-requests/approve] status update failed:', updateErr.message);
    return res.status(500).json({ error: 'Failed to update request status' });
  }

  return res.status(200).json({
    success:    true,
    requestId,
    companyId:  newCompany.id,
    companyName: company,
  });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/admin/access-requests/approve' });
