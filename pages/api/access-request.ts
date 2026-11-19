import { createApiRoute as __createApiRoute } from '../../lib/platform/routeFactory';

/**
 * POST /api/access-request  (PUBLIC - no auth; the ONE access-request endpoint)
 *
 * The vetted path (owner ruling 2026-11-19). A person who cannot self-sign-up - free mail (Gmail, Yahoo,
 * ...) or a corporate email whose registrable domain is not their company website's - submits their
 * details here. A Super Admin vets the request (/admin/access-requests) and opens the account; the
 * requester then signs up with the SAME email and lands in that company.
 *
 * Body (JSON) -> access_requests column:
 *   email         string, REQUIRED, <= 254, an address          -> email (trimmed, lower-cased);
 *                                                                   domain (its host)
 *   name          string, REQUIRED, <= 120 (the contact's name)  -> name
 *   company_name  string, REQUIRED, <= 160                       -> company_name
 *   website       string, <= 2048, REQUIRED for a corporate email, optional for free mail; a public
 *                 website (validatePublicWebsite), stored normalised as https://<host>
 *                 (normalizePublicWebsite). `website_url` is accepted as a legacy alias.
 *                                                               -> website_url
 *   reason        string, optional, <= 1000                      -> use_case
 *   (job_title    string, optional, <= 120 - legacy, kept       -> job_title)
 * Server-set: domain_status (PUBLIC_EMAIL for free mail; DOMAIN_MISMATCH when the website's root is not
 * the email's; CORPORATE_EMAIL when they match), status 'pending', created_at.
 *
 * Responses:
 *   202 ACCEPTED_BODY - every accepted submission (see below);
 *   400 { error, fields: { <field>: 'required' | 'too_long' | 'invalid' } } - validation only: field
 *       errors, never anything about existence;
 *   429 limited; 503 limiter down or the existence read failed - ONLY ever before any write;
 *   500 the insert failed.
 *
 * NO EXISTENCE ORACLE (b3, 2026-11-19). Every accepted submission - new, duplicate of a pending or
 * approved request, or after a rejection - gets the SAME 202 and the SAME body (ACCEPTED_BODY): no
 * request id, no status, nothing about whether an email, request, company or domain exists. (It used to
 * answer 200 { requestId, status } for an existing request vs 201 for a new one, so anyone could learn
 * whether an email had applied and whether it was approved.)
 * Idempotent server-side: a pending or approved request for the email is never duplicated.
 *
 * Rate-limited per trusted client IP AND per normalised email, FAIL-CLOSED (onRedisFailure 'closed';
 * owner: no CAPTCHA, anonymous anti-bot paths fail closed): over a limit -> 429, limiter outage -> 503,
 * each with a constant body, before anything is read or written.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { supabase } from '../../backend/db/supabaseClient';
import { checkRateLimit, type RateLimitConfig, type RateLimitResult } from '../../lib/auth/rateLimit';
import { getTrustedClientIp } from '../../lib/security/clientIp';
import { extractDomain, isFreeEmailDomain, normalizePublicWebsite } from '../../backend/services/companyMatchService';
import { normalizeAccessRequestEmail } from '../../backend/services/approvedAccessRequestService';
import { normalizeCompanyDomain } from '../../lib/shared/domain/companyDomain';

const ACCESS_REQUEST_IP_LIMIT: RateLimitConfig = {
  keyPrefix: 'rl:public:access-request:ip', limit: 5, windowSecs: 3600, onRedisFailure: 'closed',
};
const ACCESS_REQUEST_EMAIL_LIMIT: RateLimitConfig = {
  keyPrefix: 'rl:public:access-request:email', limit: 3, windowSecs: 86400, onRedisFailure: 'closed',
};

const ACCEPTED_BODY = Object.freeze({
  status:  'received',
  message: 'Thanks — we will review your request and email you.',
});

/** Field limits (characters, after trimming). */
const LIMITS = { email: 254, name: 120, company_name: 160, website: 2048, reason: 1000, job_title: 120 } as const;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FieldError = 'required' | 'too_long' | 'invalid';
type Accepted = {
  email: string; domain: string; name: string; company_name: string;
  website_url: string | null; use_case: string | null; job_title: string | null; domain_status: string;
};

/** Pure validation + normalisation of the body. Field errors only - never anything read from the database. */
function validateAccessRequestBody(body: unknown): { ok: true; value: Accepted } | { ok: false; fields: Record<string, FieldError> } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const fields: Record<string, FieldError> = {};
  const text = (key: keyof typeof LIMITS, raw: unknown, required: boolean): string | null => {
    if (raw !== undefined && raw !== null && typeof raw !== 'string') { fields[key] = 'invalid'; return null; }
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v) { if (required) fields[key] = 'required'; return null; }
    if (v.length > LIMITS[key]) { fields[key] = 'too_long'; return null; }
    return v;
  };

  const rawEmail = text('email', b.email, true);
  const email = rawEmail ? normalizeAccessRequestEmail(rawEmail) : null;
  if (email && !EMAIL_SHAPE.test(email)) fields.email = 'invalid';
  const name = text('name', b.name, true);
  const companyName = text('company_name', b.company_name, true);
  const reason = text('reason', b.reason, false);
  const jobTitle = text('job_title', b.job_title, false);

  const host = email && !fields.email ? (extractDomain(email) ?? '') : '';
  const emailRoot = host ? normalizeCompanyDomain(email) : '';
  const freeMail = !host || isFreeEmailDomain(host) || !emailRoot || isFreeEmailDomain(emailRoot);
  const websiteRaw = b.website !== undefined ? b.website : b.website_url;
  const websiteText = text('website', websiteRaw, !!host && !freeMail);
  let website: string | null = null;
  if (websiteText) {
    website = normalizePublicWebsite(websiteText);
    if (!website) fields.website = 'invalid';
  }

  if (Object.keys(fields).length > 0 || !email || !name || !companyName) return { ok: false, fields };

  const domainStatus = freeMail
    ? 'PUBLIC_EMAIL'
    : website && normalizeCompanyDomain(website) !== emailRoot ? 'DOMAIN_MISMATCH' : 'CORPORATE_EMAIL';
  return {
    ok: true,
    value: {
      email, domain: host, name, company_name: companyName,
      website_url: website, use_case: reason, job_title: jobTitle, domain_status: domainStatus,
    },
  };
}

/** A refused limiter answer: 503 when the limiter itself is down (fail-closed), else 429. Constant bodies. */
function refuseLimited(res: NextApiResponse, rl: RateLimitResult) {
  if (rl.bypassed) {
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again later.' });
  }
  return res.status(429).json({ error: 'Too many requests. Please try again later.' });
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const ipRl = await checkRateLimit(getTrustedClientIp(req), ACCESS_REQUEST_IP_LIMIT);
  if (!ipRl.allowed) return refuseLimited(res, ipRl);

  let body: unknown;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid request', fields: { body: 'invalid' } });
  }
  const parsed = validateAccessRequestBody(body);
  if (parsed.ok !== true) return res.status(400).json({ error: 'Invalid request', fields: parsed.fields });
  const request = parsed.value;

  const emailRl = await checkRateLimit(request.email, ACCESS_REQUEST_EMAIL_LIMIT);
  if (!emailRl.allowed) return refuseLimited(res, emailRl);

  // ── Idempotent: an existing pending or approved request is never duplicated ──
  // .limit(1) (not maybeSingle): two existing rows must still read as "exists", never as a failed
  // read that falls through to a duplicate insert. A failed read refuses (writes nothing).
  const { data: existing, error: readErr } = await supabase
    .from('access_requests')
    .select('id')
    .eq('email', request.email)
    .in('status', ['pending', 'approved'])
    .limit(1);

  if (readErr) {
    console.error('[access-request] existence read failed:', readErr.message);
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again later.' });
  }

  if (Array.isArray(existing) && existing.length > 0) {
    return res.status(202).json(ACCEPTED_BODY);
  }

  // ── Insert new request ─────────────────────────────────────────────────────
  // Nothing after this point answers 503: a 503 only ever means "nothing was written".
  const { error } = await supabase
    .from('access_requests')
    .insert({
      email:         request.email,
      name:          request.name,
      company_name:  request.company_name,
      website_url:   request.website_url,
      use_case:      request.use_case,
      job_title:     request.job_title,
      domain:        request.domain,
      domain_status: request.domain_status,
      status:        'pending',
      created_at:    new Date().toISOString(),
    })
    .select('id')
    .single();

  // 23505 = a concurrent submission for the same email won: the request exists, so the reply is the
  // same accepted one (anything else would be an existence signal).
  if (error && error.code !== '23505') {
    console.error('[access-request] insert failed:', error.message);
    return res.status(500).json({ error: 'Failed to submit access request' });
  }

  return res.status(202).json(ACCEPTED_BODY);
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/access-request' });
