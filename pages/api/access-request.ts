import { createApiRoute as __createApiRoute } from '../../lib/platform/routeFactory';

/**
 * POST /api/access-request
 *
 * Public endpoint — no auth required. Allows users with public email domains
 * (Gmail, Yahoo, etc.) to request access to the platform.
 *
 * These users cannot self-serve because their email domain is not eligible
 * for free credits. A super admin reviews and approves/rejects the request.
 *
 * Body:
 *   email       — required
 *   name        — required (person or brand name)
 *   website_url — optional
 *   job_title   — optional
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

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { email, name, website_url, job_title } = (body ?? {}) as {
    email:        string;
    name:         string;
    website_url?: string;
    job_title?:   string;
  };

  if (typeof email !== 'string' || typeof name !== 'string' || !email.trim() || !name.trim()) {
    return res.status(400).json({ error: 'email and name are required' });
  }

  const emailLower = email.toLowerCase().trim();
  const domain     = emailLower.split('@')[1] ?? '';

  if (!domain) return res.status(400).json({ error: 'Invalid email address' });

  const emailRl = await checkRateLimit(emailLower, ACCESS_REQUEST_EMAIL_LIMIT);
  if (!emailRl.allowed) return refuseLimited(res, emailRl);

  // ── Idempotent: an existing pending or approved request is never duplicated ──
  // .limit(1) (not maybeSingle): two existing rows must still read as "exists", never as a failed
  // read that falls through to a duplicate insert. A failed read refuses (writes nothing).
  const { data: existing, error: readErr } = await supabase
    .from('access_requests')
    .select('id')
    .eq('email', emailLower)
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
  const { error } = await supabase
    .from('access_requests')
    .insert({
      email:         emailLower,
      name:          name.trim(),
      website_url:   typeof website_url === 'string' ? website_url.trim() || null : null,
      job_title:     typeof job_title === 'string' ? job_title.trim() || null : null,
      domain,
      domain_status: 'PUBLIC_EMAIL',
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
