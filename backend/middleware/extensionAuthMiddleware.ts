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
  type ExtensionSessionPayload,
} from '@/backend/services/extensionSessionService';
import { supabase } from '@/backend/db/supabaseClient';
import { capturedRawBody } from './extensionRawBody';
import { checkExtensionMembership } from '@/backend/services/extensionMembershipService';

/** validate's 403 body text; core/authBridge.js VALIDATE_DEAD_403 maps exactly this string to ORG_ACCESS_REVOKED. */
export const EXTENSION_ACCESS_DENIED_ERROR = 'Access denied to organization';

function take(h: string | string[] | undefined) { return (Array.isArray(h) ? h[0] : h) || ''; }

/** The bytes to hash for the signature, or null when they cannot be known exactly. */
function signedBodyBytes(req: NextApiRequest): Buffer | null {
  const raw = capturedRawBody(req);
  if (raw) return raw;
  // No capture. A GET/HEAD carries no body (fetch forbids one; the extension signs ''): hash the empty string, as
  // before. Anything else would need a re-serialisation - refuse.
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return Buffer.alloc(0);
  return null;
}

async function inferDevBypassOrgId(req: NextApiRequest): Promise<string | null> {
  const path = (req.url || '').split('?')[0] || '';
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
    commandId?: unknown;
    command_id?: unknown;
  };
  const commandId = String(body.commandId ?? body.command_id ?? req.query.commandId ?? req.query.command_id ?? '').trim();

  if (commandId) {
    const { data } = await supabase
      .from('community_ai_actions')
      .select('organization_id')
      .eq('id', commandId)
      .maybeSingle();
    return typeof data?.organization_id === 'string' ? data.organization_id : null;
  }

  if (req.method?.toUpperCase() === 'GET' && path === '/api/extension/commands') {
    const { data } = await supabase
      .from('community_ai_actions')
      .select('organization_id')
      .eq('status', 'pending')
      .eq('execution_mode', 'browser')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return typeof data?.organization_id === 'string' ? data.organization_id : null;
  }

  return null;
}

export async function requireExtensionAuth(req: NextApiRequest, res: NextApiResponse): Promise<{ session: ExtensionSessionPayload } | null> {
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
    const orgId = orgFromBody || orgFromQuery || await inferDevBypassOrgId(req);
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

  // The signature covers the EXACT bytes received (see withExtensionRawBody above).
  // A request that cannot be signed at all (no signature headers, or a session without an HMAC nonce) is refused
  // 401 by the verifier before any body is hashed; only a request that WOULD be hashed needs the captured bytes.
  let rawBody = signedBodyBytes(req);
  if (!rawBody) {
    const signable = Boolean(take(req.headers['x-omnivyra-timestamp']) && take(req.headers['x-omnivyra-nonce'])
      && take(req.headers['x-omnivyra-signature']) && session.hmacNonce);
    if (signable) {
      console.error('[extensionAuth] raw request body was not captured - route is missing withExtensionRawBody / bodyParser:false', req.url);
      res.status(500).json({ success: false, error: 'RAW_BODY_UNAVAILABLE' });
      return null;
    }
    rawBody = Buffer.alloc(0); // never hashed: the verifier refuses on the missing header / nonce first
  }

  // PATH = pathname only. The extension signs the endpoint path; its service worker appends ?organization_id= to
  // GETs after signing. The query string is therefore unauthenticated: routes take the tenant from the session.
  const path = (req.url || '').split('?')[0] || '';
  const verify = await verifyExtensionRequestSignature({
    method: req.method || 'GET',
    path,
    rawBody,
    timestampHeader: req.headers['x-omnivyra-timestamp'],
    nonceHeader: req.headers['x-omnivyra-nonce'],
    signatureHeader: req.headers['x-omnivyra-signature'],
    session,
  });

  if (!verify.ok) {
    if ((verify as { status?: number }).status === 503) {
      // The shared replay store could not answer: a transient service condition, never a signature verdict (the
      // extension keeps its session on a 503; a 401 SIGNATURE_INVALID would sign it out).
      res.status(503).json({ success: false, error: 'REPLAY_STORE_UNAVAILABLE', retryable: true });
      return null;
    }
    res.status(401).json({ success: false, error: 'SIGNATURE_INVALID', reason: (verify as { reason?: string }).reason });
    return null;
  }

  // Item F: the token proves who paired and for which company AT REDEEM; it does not prove the membership still
  // holds. Every signed route therefore re-applies the ONE extension membership rule (active role row AND active
  // company - backend/services/extensionMembershipService.ts) for the session's pinned (user, org), after the
  // signature (so an unsigned caller learns nothing about membership). Before this, only /validate re-checked:
  // a suspended company's or a removed member's live session kept receiving commands, renewing leases, posting
  // results, ingesting and driving Sales Navigator runs until the 12 h token expired.
  // No cache: one membership + company read per signed request (the extension polls ~1/min).
  let membership: Awaited<ReturnType<typeof checkExtensionMembership>>;
  try {
    membership = await checkExtensionMembership(session.userId, session.orgId);
  } catch (error) {
    console.error('[extensionAuth] membership check threw', (error as Error)?.message);
    membership = { ok: false, outcome: 'unavailable', reason: 'TENANT_LOOKUP_ERROR' };
  }
  if (membership.ok === false) {
    if ((membership as { outcome: string }).outcome === 'unavailable') {
      // Fail CLOSED (no access) but transient: a 503 keeps the extension's session (core/authBridge.js
      // sessionInvalidationReason signs out only on 401 INVALID_SESSION / SIGNATURE_INVALID+definite reasons and
      // on validate's 403 'Access denied to organization' / 'Extension session organization mismatch').
      res.status(503).json({ success: false, error: 'TENANT_LOOKUP_ERROR', retryable: true });
      return null;
    }
    // Definite. The error text is validate's load-bearing body: on /validate the extension maps it to
    // ORG_ACCESS_REVOKED and signs out; on any other route a 403 is not a sign-out signal, the request is simply
    // refused and the next validate (<= 60 s) signs the extension out. `code` / `reason` are for logs and support.
    res.status(403).json({
      success: false,
      error: EXTENSION_ACCESS_DENIED_ERROR,
      code: 'EXTENSION_MEMBERSHIP_INACTIVE',
      reason: (membership as { reason: string }).reason,
    });
    return null;
  }

  return { session };
}
