import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';

/**
 * POST /api/admin/access-requests/approve
 *
 * Super-admin only (IDENTITY_ADMIN_ASSIGN + step-up; per-route rate limit). Approves an access request
 * (the vetted path, owner ruling 2026-11-19: free mail, or a corporate email whose domain is not the
 * company website's).
 *
 * Body: { requestId, adminNote?, brandName? }
 *   brandName - override for the company name (else request.company_name, else request.name)
 *
 * Steps:
 *  0. Read-only checks: the request is pending (or a STALE claim, below); no OTHER request of the same
 *     email is approved (a second 'approved' row for one email is never written -
 *     idx_access_requests_email_approved_unique); the website (normalised) is not held by a live company.
 *  1. CLAIM (b3, D2), atomically, before creating anything. access_requests.status has a CHECK
 *     (pending/approved/rejected/deleted), so the claim uses the existing columns: status 'approved' with
 *     organization_id NULL and reviewed_at = the claim time (G2 treats an approved row without
 *     organization_id as absent, so a claimed request binds nobody). Two conditional UPDATEs, each atomic:
 *     WHERE status='pending'; else WHERE status='approved' AND organization_id IS NULL AND reviewed_at is
 *     older than CLAIM_STALE_MS (a crashed approval cannot wedge a request). The loser is 409.
 *  2. Create the company through companyWebsiteCreation -> companyIdentityWriter (website + website_domain
 *     written together; admin_email_domain = the corporate email root, or NULL for free mail).
 *  3. Link: organization_id = the company (guarded on THIS claim).
 *     Any failure in 2-3 RELEASES the claim (status back to 'pending', guarded on still being THIS claim)
 *     and removes a company it created, so nothing is left behind.
 *  4. INVITATION (b3, D1) through the EXISTING flow (invitationService.createAndSendInvitation): the
 *     requester's email, the vetted company, COMPANY_ADMIN, idempotency key access-request:<id> (which the
 *     super-admin resend route needs to rebuild the token). Delivery is an email_jobs ENQUEUE (the cron
 *     worker sends it). The approval stands whatever happens here; the outcome is reported.
 *
 * Responses (the admin UI keys on these):
 *   200 { success, requestId, companyId, companyName, invitation: { created, email } }
 *       invitation.email: 'queued' (enqueued for delivery) | 'failed' (the flow could not enqueue: it
 *       revoked the invitation it had just created, so created says whether that row exists).
 *       Re-sending: POST /api/super-admin/invitations/{invitationId}/resend (a non-revoked invitation);
 *       after a 'failed' enqueue, a fresh invite through the existing invite routes.
 *   400 requestId missing. 404 request not found.
 *   409 ACCESS_REQUEST_NOT_PENDING (already approved / rejected / deleted, or another approval holds a
 *       fresh claim - the loser of a concurrent approval); EMAIL_ALREADY_APPROVED (another request of this
 *       email is approved, companyId = its company; or the claim hit the approved-email unique index);
 *       COMPANY_WEBSITE_TAKEN / COMPANY_WEBSITE_AMBIGUOUS. Nothing written.
 *   422 COMPANY_WEBSITE_INVALID. Nothing written.
 *   503 APPROVAL_NOT_APPLIED / COMPANY_WEBSITE_CHECK_FAILED - NOTHING was changed: a failure before the
 *       claim, or after a claim that was cleanly released with no company and no invitation left behind.
 *       Safe to retry.
 *   500 APPROVAL_STATE_UNKNOWN - something may have been written and the release / cleanup failed or its
 *       result is unknown. The UI should say "not sure - refresh"; a stale claim becomes reclaimable after
 *       10 minutes.
 *
 * Credits: NOT auto-granted. Domain: NOT whitelisted - approval is per person: the approved requester who
 * onboards with that VERIFIED email is bound to this company (setup-company / onboarding/complete).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { supabase } from '@/backend/db/supabaseClient';
import { requireCapability } from '../../../../backend/security/requireCapability';
import { requireAdminRateLimit } from '../../../../backend/services/requestAccessService';
import { IDENTITY_ADMIN_ASSIGN } from '../../../../shared/contracts/security';
import { extractDomain, isFreeEmailDomain } from '../../../../backend/services/companyMatchService';
import { checkCompanyWebsite, insertCompanyWithWebsite } from '../../../../backend/services/companyWebsiteCreation';
import { createAndSendInvitation } from '../../../../backend/services/invitationService';
import { normalizeCompanyDomain } from '../../../../lib/shared/domain/companyDomain';

/** A claim older than this is a crashed approval and may be reclaimed. */
const CLAIM_STALE_MS = 10 * 60 * 1000;

const NOT_APPLIED = { code: 'APPROVAL_NOT_APPLIED', error: 'The approval was not applied. Nothing was changed - please try again.' } as const;
const STATE_UNKNOWN = { code: 'APPROVAL_STATE_UNKNOWN', error: 'The approval may be partly applied. Refresh to see the current state.' } as const;
const NOT_PENDING = { code: 'ACCESS_REQUEST_NOT_PENDING', error: 'This request is not pending (already handled, or another approval is in progress).' } as const;

type Claim = { requestId: string; claimedAt: string };

/** Atomically claim a pending request, or reclaim a STALE claim. 'lost' = someone else holds it. */
async function claimRequest(requestId: string, adminUserId: string | null): Promise<{ ok: true; claim: Claim } | { ok: false; reason: 'lost' | 'email_taken' | 'error' }> {
  const claimedAt = new Date().toISOString();
  const claimPatch = { status: 'approved', organization_id: null, reviewed_by: adminUserId, reviewed_at: claimedAt };
  const attempts = [
    () => supabase.from('access_requests').update(claimPatch).eq('id', requestId).eq('status', 'pending').select('id'),
    () => supabase.from('access_requests').update(claimPatch).eq('id', requestId).eq('status', 'approved')
      .is('organization_id', null).lt('reviewed_at', new Date(Date.now() - CLAIM_STALE_MS).toISOString()).select('id'),
  ];
  for (const attempt of attempts) {
    const { data, error } = await attempt();
    if (error) return { ok: false, reason: error.code === '23505' ? 'email_taken' : 'error' };
    if (Array.isArray(data) && data.length === 1) return { ok: true, claim: { requestId, claimedAt } };
  }
  return { ok: false, reason: 'lost' };
}

/** Release THIS claim (only while it is still this claim). true = released; false = not released / unknown. */
async function releaseClaim(claim: Claim): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('access_requests')
      .update({ status: 'pending', organization_id: null, reviewed_by: null, reviewed_at: null })
      .eq('id', claim.requestId)
      .eq('status', 'approved')
      .is('organization_id', null)
      .eq('reviewed_at', claim.claimedAt)
      .select('id');
    return !error && Array.isArray(data) && data.length === 1;
  } catch {
    return false;
  }
}

/** Remove a company THIS approval created and could not link. true = removed. */
async function removeCreatedCompany(companyId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('companies').delete().eq('id', companyId).select('id');
    return !error && Array.isArray(data) && data.length === 1;
  } catch {
    return false;
  }
}

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

  // ── 0. Read-only checks (every refusal here writes nothing) ────────────────
  const { data: request, error: fetchErr } = await supabase
    .from('access_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();

  if (fetchErr || !request) return res.status(404).json({ error: 'Access request not found' });
  // A claimed request (approved, no company yet) passes here; whether its claim is stale is decided
  // atomically by the claim itself (step 1).
  const claimedRequest = request.status === 'approved' && !request.organization_id;
  if (request.status !== 'pending' && !claimedRequest) {
    return res.status(409).json(NOT_PENDING);
  }

  // One approved request per email (idx_access_requests_email_approved_unique). Another request of this
  // email already approved WITH a company: refuse - never write a second 'approved' row. (The old
  // "duplicate" branch did exactly that, which the unique index rejects.)
  const { data: priorApprovals, error: priorErr } = await supabase
    .from('access_requests')
    .select('id, organization_id')
    .eq('email', request.email)
    .eq('status', 'approved')
    .not('organization_id', 'is', null)
    .limit(5);
  if (priorErr) return res.status(503).json(NOT_APPLIED);
  const prior = (Array.isArray(priorApprovals) ? priorApprovals : []).find(
    (r: { id?: unknown; organization_id?: unknown }) => r?.id !== requestId && typeof r?.organization_id === 'string' && r.organization_id !== '',
  ) as { organization_id: string } | undefined;
  if (prior) {
    return res.status(409).json({
      code: 'EMAIL_ALREADY_APPROVED',
      error: 'Another request for this email is already approved.',
      companyId: prior.organization_id,
    });
  }

  // The company's name: the Super Admin's override, else the company name the requester gave
  // (/api/access-request company_name), else the legacy single name field.
  const company = brandName?.trim() || request.company_name?.trim() || request.name?.trim() || request.email.split('@')[0];
  const emailHost = extractDomain(String(request.email ?? '')) ?? '';
  const emailRoot = normalizeCompanyDomain(String(request.email ?? ''));
  const freeMail = !emailHost || isFreeEmailDomain(emailHost) || !emailRoot || isFreeEmailDomain(emailRoot);
  const adminEmailDomain = freeMail ? null : emailRoot;

  const checked = await checkCompanyWebsite(request.website_url, { required: false });
  if (checked.ok !== true) {
    return res.status(checked.status).json({ code: checked.code, error: checked.error });
  }

  // ── 1. Claim ───────────────────────────────────────────────────────────────
  const claimed = await claimRequest(requestId, adminUserId);
  if (claimed.ok !== true) {
    if (claimed.reason === 'lost') return res.status(409).json(NOT_PENDING);
    if (claimed.reason === 'email_taken') {
      return res.status(409).json({ code: 'EMAIL_ALREADY_APPROVED', error: 'Another request for this email is already approved.' });
    }
    return res.status(503).json(NOT_APPLIED);
  }
  const claim = claimed.claim;

  // ── 2. Create the company ──────────────────────────────────────────────────
  const now = new Date().toISOString();
  const createdCompany = await insertCompanyWithWebsite({
    record: { name: company, status: 'active', created_at: now, updated_at: now },
    website: checked.website,
    adminEmailDomain,
  });
  if (createdCompany.ok !== true) {
    // Nothing was created: release the claim. A refusal that means "nothing written" keeps its status
    // (409 TAKEN on a concurrent 23505, 422 invalid); any other failure is 503 - but only once released.
    if (!(await releaseClaim(claim))) return res.status(500).json(STATE_UNKNOWN);
    if (createdCompany.status === 409 || createdCompany.status === 422) {
      return res.status(createdCompany.status).json({ code: createdCompany.code, error: createdCompany.error });
    }
    return res.status(503).json(NOT_APPLIED);
  }
  const companyId = String(createdCompany.row.id);

  // ── 3. Link the company to the request (guarded on THIS claim) ─────────────
  let linked = false;
  try {
    const { data, error } = await supabase
      .from('access_requests')
      .update({ organization_id: companyId, admin_note: adminNote ?? null })
      .eq('id', requestId)
      .eq('status', 'approved')
      .is('organization_id', null)
      .eq('reviewed_at', claim.claimedAt)
      .select('id');
    linked = !error && Array.isArray(data) && data.length === 1;
  } catch {
    linked = false;
  }
  if (!linked) {
    console.error('[access-requests/approve] link failed; removing the company and releasing the claim', { requestId });
    const removed = await removeCreatedCompany(companyId);
    if (!removed || !(await releaseClaim(claim))) return res.status(500).json(STATE_UNKNOWN);
    return res.status(503).json(NOT_APPLIED);
  }

  // ── 4. Invitation through the existing flow (the approval stands either way) ──
  const idempotencyKey = `access-request:${requestId}`;
  let invitation: { created: boolean; email: 'queued' | 'failed' };
  try {
    await createAndSendInvitation({
      email:     String(request.email).trim().toLowerCase(),
      companyId,
      role:      'COMPANY_ADMIN',
      invitedBy: adminUserId,
      idempotencyKey,
    });
    invitation = { created: true, email: 'queued' };
  } catch (err) {
    console.error('[access-requests/approve] invitation not sent:', (err as Error)?.message);
    // The flow revokes an invitation it created when the enqueue fails; report whether the row exists.
    const { data: row } = await supabase.from('invitations').select('id').eq('idempotency_key', idempotencyKey).maybeSingle();
    invitation = { created: !!row, email: 'failed' };
  }

  return res.status(200).json({
    success:     true,
    requestId,
    companyId,
    companyName: company,
    invitation,
  });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/admin/access-requests/approve' });
