/**
 * Extension auth middleware — verify session token + HMAC signature on
 * protected /api/extension/* endpoints.
 *
 * Usage inside a Next.js API route:
 *   const auth = await requireExtensionAuth(req, res);
 *   if (!auth) return; // middleware already wrote the error response
 *   const { session } = auth;
 *
 * Dev bypass: setting DEV_EXTENSION_AUTH_BYPASS=1 skips both session-token
 * and HMAC checks — the request body's `organization_id` becomes the
 * tenant. Only honored when NODE_ENV !== 'production'. Used to unblock
 * local DOM-scraper testing without grinding through the SW HMAC chain.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import {
  verifyExtensionSessionToken,
  verifyExtensionRequestSignature,
} from '@/backend/services/extensionSessionService';
import { supabase } from '@/backend/db/supabaseClient';

function take(h: string | string[] | undefined) { return (Array.isArray(h) ? h[0] : h) || ''; }

/** UNREADABLE is not "no organization" (b3 read-failure rule): a failed read answers 503, never a missing-org 400. */
const ORG_UNREADABLE = Symbol('org-unreadable');

async function inferDevBypassOrgId(req: NextApiRequest): Promise<string | null | typeof ORG_UNREADABLE> {
  const path = (req.url || '').split('?')[0] || '';
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
    commandId?: unknown;
    command_id?: unknown;
  };
  const commandId = String(body.commandId ?? body.command_id ?? req.query.commandId ?? req.query.command_id ?? '').trim();

  if (commandId) {
    try {
      const { data, error } = await supabase
        .from('community_ai_actions')
        .select('organization_id')
        .eq('id', commandId)
        .maybeSingle();
      if (error) return ORG_UNREADABLE;
      return typeof data?.organization_id === 'string' ? data.organization_id : null;
    } catch {
      return ORG_UNREADABLE;
    }
  }

  if (req.method?.toUpperCase() === 'GET' && path === '/api/extension/commands') {
    try {
      const { data, error } = await supabase
        .from('community_ai_actions')
        .select('organization_id')
        .eq('status', 'pending')
        .eq('execution_mode', 'browser')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return ORG_UNREADABLE;
      return typeof data?.organization_id === 'string' ? data.organization_id : null;
    } catch {
      return ORG_UNREADABLE;
    }
  }

  return null;
}

export async function requireExtensionAuth(req: NextApiRequest, res: NextApiResponse) {
  // Dev bypass — short-circuit the entire HMAC/session chain when the
  // operator opts in via env. Refuses to run in production no matter what
  // the env says, so a stray flag in a deployed env can't disable auth.
  const bypassEnabled =
    process.env.NODE_ENV !== 'production'
    && (process.env.DEV_EXTENSION_AUTH_BYPASS === '1'
        || process.env.DEV_EXTENSION_AUTH_BYPASS === 'true');
  if (bypassEnabled) {
    // Accept all three orgId casings — the codebase isn't consistent and
    // refusing one shape silently breaks the dev-bypass redeem chain
    // (authBridge sends `orgId` camelCase from the SW, while events/dms
    // sends `organization_id` snake_case from the scraper).
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      organization_id?: unknown;
      org_id?: unknown;
      orgId?: unknown;
    };
    const orgFromBody = String(body.organization_id ?? body.org_id ?? body.orgId ?? '').trim();
    const orgFromQuery = String(req.query.organization_id ?? req.query.org_id ?? req.query.orgId ?? '').trim();
    const inferred = orgFromBody || orgFromQuery ? null : await inferDevBypassOrgId(req);
    if (inferred === ORG_UNREADABLE) {
      res.setHeader('Retry-After', '5');
      res.status(503).json({ success: false, error: 'BYPASS_ORG_UNREADABLE' });
      return null;
    }
    const orgId = orgFromBody || orgFromQuery || inferred;
    if (!orgId) {
      res.status(400).json({ success: false, error: 'BYPASS_REQUIRES_ORG_ID' });
      return null;
    }
    // Use a deterministic sentinel UUID for the bypass user so downstream
    // writes that need a uuid-typed user_id (e.g. extension_sessions
    // heartbeat) succeed instead of erroring on type mismatch. The string
    // 'dev-bypass-user' was easier to read in logs but blocked uuid columns.
    return {
      session: {
        userId: '00000000-0000-4000-8000-000000000001',
        orgId,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        hmacNonce: 'dev-bypass',
      },
    };
  }

  const authHeader = take(req.headers.authorization);
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
  const session = verifyExtensionSessionToken(bearer);
  if (!session) {
    res.status(401).json({ success: false, error: 'INVALID_SESSION' });
    return null;
  }

  // Reconstruct raw body for signature verification. Next.js has already
  // parsed JSON into req.body; re-serialize with stable formatting. The
  // extension also serializes via JSON.stringify, so this matches for POST.
  // For GET the body is empty.
  const rawBody = req.method && req.method.toUpperCase() !== 'GET'
    ? (req.body ? JSON.stringify(req.body) : '')
    : '';

  const path = (req.url || '').split('?')[0] || '';
  const verify = verifyExtensionRequestSignature({
    method: req.method || 'GET',
    path,
    rawBody,
    timestampHeader: req.headers['x-omnivyra-timestamp'],
    nonceHeader: req.headers['x-omnivyra-nonce'],
    signatureHeader: req.headers['x-omnivyra-signature'],
    session,
  });

  if (!verify.ok) {
    res.status(401).json({ success: false, error: 'SIGNATURE_INVALID', reason: verify.reason });
    return null;
  }

  return { session };
}
