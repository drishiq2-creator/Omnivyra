import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
/**
 * POST /api/provider-accounts         — create account for an API
 * GET  /api/provider-accounts?api_source_id=  — list accounts for a provider
 *
 * SUPER_ADMIN only. No tenant access.
 */

import { NextApiRequest, NextApiResponse } from 'next';
import { getSupabaseUserFromRequest } from '../../../backend/services/supabaseAuthService';
import { getLegacySuperAdminSession } from '../../../backend/services/superAdminSession';
import { isPlatformSuperAdmin, isSuperAdmin } from '../../../backend/services/rbacService';
import {
  buildCredentialEnvelope,
  createProviderAccount,
  listAccountsForApi,
} from '../../../backend/services/providerAccountService';
// Round 26: one guard module validates credential input, hardens the stored envelope and
// serialises rows without credential material (shape-only `credential_state`).
import {
  checkPlatformOwnedSource,
  checkProviderAccountCredentialsInput,
  hardenCredentialEnvelope,
  toSafeProviderAccount,
} from '../../../backend/security/superAdminCredentialWriteGuards';
import { requireCapability } from '../../../backend/security/requireCapability';
import { requireAdminRateLimit } from '../../../backend/services/requestAccessService';
import { enforcePlatformWriteAuthority } from '../../../backend/security/platformWriteAuthority';
import { INTEGRATION_PLATFORM_OAUTH_MANAGE } from '../../../shared/contracts/security';

// ── Auth guards ────────────────────────────────────────────────────────────────
//
// READ guard: bridge accepted via centralized helper (signature-validated +
// dry-run-aware). Mutations gate on `requireCapability` below.

async function requireSuperAdminRead(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<{ userId: string } | null> {
  const legacy = getLegacySuperAdminSession(req);
  if (legacy) return { userId: legacy.userId };

  const { user, error } = await getSupabaseUserFromRequest(req);
  if (error || !user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return null;
  }
  if ((await isPlatformSuperAdmin(user.id)) || (await isSuperAdmin(user.id))) {
    return { userId: user.id };
  }
  res.status(403).json({ error: 'SUPER_ADMIN_ONLY' });
  return null;
}

// ── Handler ────────────────────────────────────────────────────────────────────

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Closure-014 (D): per-route write rate limit (before authorization and any business work).
  if (req.method !== 'GET' && !(await requireAdminRateLimit(req, res, 'rl:provider-accounts:create', 20, 60, { sensitive: true }))) return;

  // ── GET: list accounts for a provider ──────────────────────────────────────
  if (req.method === 'GET') {
    const session = await requireSuperAdminRead(req, res);
    if (!session) return;

    const { api_source_id } = req.query;
    if (!api_source_id || typeof api_source_id !== 'string') {
      return res.status(400).json({ error: 'api_source_id required' });
    }

    const accounts = await listAccountsForApi(api_source_id);
    // Never expose credential material: credential-bearing columns are dropped by name and
    // replaced by a shape-only state (encrypted / plaintext / invalid reference), so the
    // Super Admin can see which accounts need a re-save without any value leaving the server.
    const safe = accounts.map((a) => toSafeProviderAccount(a as unknown as Record<string, unknown>));
    return res.status(200).json({ accounts: safe });
  }

  // ── POST: create account ────────────────────────────────────────────────────
  if (req.method === 'POST') {
    // Phase 2 mutation gate. Provider-account creation writes encrypted
    // OAuth credentials to api_provider_accounts — same blast radius as
    // platform-OAuth-configs writes. Bridge principals are explicitly
    // rejected; canonical SUPER_ADMIN with phishing-resistant +
    // trusted-device step-up is required.
    const guard = await requireCapability(req, res, {
      capability: INTEGRATION_PLATFORM_OAUTH_MANAGE,
      reason: 'provider-account credential creation',
    });
    if (guard.ok !== true) return;
    // Closure-013 (D-3): platform credential writes also need an active platform SUPER_ADMIN.
    if (!(await enforcePlatformWriteAuthority(req, res, guard.principal, INTEGRATION_PLATFORM_OAUTH_MANAGE, 'provider_accounts.create'))) return;
    const session = { userId: guard.principal.userId };

    const {
      api_source_id,
      account_name,
      credentials,          // plain object — we serialize + optionally encrypt
      rate_limit_per_min,
      rate_limit_per_day,
      priority,
    } = req.body ?? {};

    if (!api_source_id || typeof api_source_id !== 'string') {
      return res.status(400).json({ error: 'api_source_id required' });
    }
    if (!account_name || typeof account_name !== 'string' || !account_name.trim()) {
      return res.status(400).json({ error: 'account_name required' });
    }
    if (!credentials || typeof credentials !== 'object') {
      return res.status(400).json({ error: 'credentials object required' });
    }

    // Validate shape — must have at least one usable field
    const hasApiKey =
      (typeof credentials.api_key_env_name === 'string' && credentials.api_key_env_name.trim()) ||
      (typeof credentials.api_key_value === 'string' && credentials.api_key_value.trim());
    const hasOauth =
      (typeof credentials.oauth_client_id === 'string' && credentials.oauth_client_id.trim()) ||
      (typeof credentials.oauth_client_id_ref === 'string' && credentials.oauth_client_id_ref.trim());
    if (!hasApiKey && !hasOauth && Object.keys(credentials).length > 0 === false) {
      return res.status(400).json({ error: 'credentials must contain at least one credential field' });
    }

    // Server-side credential input validation — the client is not the security boundary.
    // Refuses a secret in the env-var-NAME field (the exact path by which live provider keys
    // reached a readable column), unknown fields, non-strings and plaintext `*_ref` values.
    // Rejections describe the field and shape; they never echo the submitted value.
    const checked = checkProviderAccountCredentialsInput(credentials, { allowClearEnvName: false });
    if (checked.ok !== true) return res.status(checked.status).json(checked.body);

    // Platform credentials belong to platform rows only (S-3): refuse a tenant-owned source.
    const owner = await checkPlatformOwnedSource(api_source_id);
    if (owner.ok !== true) return res.status(owner.status).json(owner.body);

    // The shared envelope builder encrypts `api_key_value` with `encryptCredential`; the
    // hardening pass guarantees nothing unencrypted or secret-shaped is persisted.
    let credentialsEncrypted: string;
    try {
      credentialsEncrypted = hardenCredentialEnvelope(
        buildCredentialEnvelope({ existing: null, supplied: checked.supplied }),
        { suppliedKeys: checked.suppliedKeys },
      );
    } catch {
      // Fail CLOSED — never fall back to storing plaintext.
      return res.status(500).json({ error: 'Failed to encrypt credentials' });
    }

    try {
      const account = await createProviderAccount({
        api_source_id,
        account_name: account_name.trim(),
        credentials_encrypted: credentialsEncrypted,
        rate_limit_per_min: typeof rate_limit_per_min === 'number' ? rate_limit_per_min : null,
        rate_limit_per_day: typeof rate_limit_per_day === 'number' ? rate_limit_per_day : null,
        priority: typeof priority === 'number' ? priority : 1,
      });

      return res.status(201).json({ account: toSafeProviderAccount(account as unknown as Record<string, unknown>) });
    } catch (err: any) {
      console.error('createProviderAccount failed', err?.message);
      // A fixed message: a database error can quote the row being written.
      return res.status(500).json({ error: 'Failed to create account' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/provider-accounts' });
