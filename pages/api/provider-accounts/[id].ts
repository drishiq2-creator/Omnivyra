import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
/**
 * PUT    /api/provider-accounts/[id]  — update credentials, limits, priority
 * DELETE /api/provider-accounts/[id]  — soft delete (is_active = false)
 *
 * SUPER_ADMIN only. No tenant access.
 */

import { NextApiRequest, NextApiResponse } from 'next';
import {
  buildCredentialEnvelope,
  updateProviderAccount,
  deactivateProviderAccount,
} from '../../../backend/services/providerAccountService';
// Round 26: credential input validation, envelope hardening and safe serialisation.
import {
  checkPlatformOwnedSource,
  checkProviderAccountCredentialsInput,
  hardenCredentialEnvelope,
  toSafeProviderAccount,
} from '../../../backend/security/superAdminCredentialWriteGuards';
import { supabase } from '../../../backend/db/supabaseClient';
import { requireCapability } from '../../../backend/security/requireCapability';
import { requireAdminRateLimit } from '../../../backend/services/requestAccessService';
import { enforcePlatformWriteAuthority } from '../../../backend/security/platformWriteAuthority';
import { INTEGRATION_PLATFORM_OAUTH_MANAGE } from '../../../shared/contracts/security';

// ── Handler ────────────────────────────────────────────────────────────────────

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Closure-014 (D): per-route write rate limit (before authorization and any business work).
  // One rate-limit call whose arguments depend on the method (same keys, limits and
  // options as before), so no method branch precedes the authorization below.
  const isDelete = req.method === 'DELETE';
  const rl = await requireAdminRateLimit(
    req, res,
    isDelete ? 'rl:provider-accounts:delete' : 'rl:provider-accounts:update',
    isDelete ? 10 : 20,
    60,
    { sensitive: true },
  );
  if (!rl) return;

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Account ID required' });
  }

  // Phase 2 mutation gate. PUT/DELETE on provider-accounts mutates
  // encrypted OAuth credentials → same blast radius as platform OAuth.
  // Bridge principals receive 403 CAPABILITY_NOT_HELD.
  const guard = await requireCapability(req, res, {
    capability: INTEGRATION_PLATFORM_OAUTH_MANAGE,
    reason: `provider-account ${req.method} for ${id}`,
    resourceId: id,
  });
  if (guard.ok !== true) return;
  // Closure-013 (D-3): this route only mutates (PUT/DELETE); platform authority
  // is checked before the account lookup so a refused caller learns nothing.
  if (!(await enforcePlatformWriteAuthority(req, res, guard.principal, INTEGRATION_PLATFORM_OAUTH_MANAGE, 'provider_accounts.update'))) return;
  const session = { userId: guard.principal.userId };
  void session; // reserved for future audit linkage

  // Verify account exists
  const { data: existing, error: fetchError } = await supabase
    .from('api_provider_accounts')
    .select('id, api_source_id, account_name')
    .eq('id', id)
    .maybeSingle();

  if (fetchError) {
    return res.status(500).json({ error: fetchError.message });
  }
  if (!existing) {
    return res.status(404).json({ error: 'Account not found' });
  }

  // ── DELETE (soft) ──────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      await deactivateProviderAccount(id);
      return res.status(200).json({ success: true, id });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'Failed to deactivate account' });
    }
  }

  // ── PUT: update ────────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    const {
      account_name,
      credentials,
      rate_limit_per_min,
      rate_limit_per_day,
      priority,
      is_active,
    } = req.body ?? {};

    // Platform credentials belong to platform rows only (S-3). An account on a TENANT-owned
    // source (e.g. a seeded "default") may still be renamed, re-prioritised or deactivated,
    // but it can never receive credentials or be (re)activated.
    if ((credentials !== undefined && credentials !== null) || is_active === true) {
      const owner = await checkPlatformOwnedSource(String((existing as { api_source_id?: unknown }).api_source_id ?? ''));
      if (owner.ok !== true) return res.status(owner.status).json(owner.body);
    }

    const patch: Record<string, unknown> = {};

    if (typeof account_name === 'string' && account_name.trim()) {
      patch.account_name = account_name.trim();
    }
    if (typeof rate_limit_per_min === 'number') patch.rate_limit_per_min = rate_limit_per_min;
    if (rate_limit_per_min === null)             patch.rate_limit_per_min = null;
    if (typeof rate_limit_per_day === 'number')  patch.rate_limit_per_day = rate_limit_per_day;
    if (rate_limit_per_day === null)              patch.rate_limit_per_day = null;
    if (typeof priority === 'number')            patch.priority = priority;
    if (typeof is_active === 'boolean')          patch.is_active = is_active;

    // ── Credential update — MERGE, never replace ──────────────────────────────
    //
    // REMEDIATION (two defects fixed here):
    //
    //  1. DESTRUCTIVE REPLACE. This previously built a fresh object and assigned
    //     `credentials_encrypted = JSON.stringify(credToStore)`. Editing an account and
    //     submitting only `api_key_env_name` silently DESTROYED the stored secret, with no
    //     warning and no way to recover it. `buildCredentialEnvelope` now merges onto the
    //     existing envelope, so only fields the caller actually supplied change.
    //  2. PLAINTEXT. `api_key_value` was stored verbatim; it is now encrypted by the same
    //     shared builder used on create.
    //  3. LEGACY CARRY-FORWARD (round 26). The builder carries every stored field forward, so
    //     a re-save kept a raw key sitting in `api_key_env_name` and a legacy PLAINTEXT
    //     `api_key_value`. `hardenCredentialEnvelope` drops a non-env-name reference and
    //     encrypts a plaintext value on EVERY credential save. `api_key_env_name: null`
    //     clears the reference explicitly (empty strings still mean "unchanged").
    if (credentials !== undefined && credentials !== null) {
      // Server-side validation — the client is not the security boundary. Never echoes a value.
      const checked = checkProviderAccountCredentialsInput(credentials, { allowClearEnvName: true });
      if (checked.ok !== true) return res.status(checked.status).json(checked.body);

      // Read the CURRENT envelope so unsupplied fields survive the update.
      const { data: current, error: currentError } = await supabase
        .from('api_provider_accounts')
        .select('credentials_encrypted')
        .eq('id', id)
        .maybeSingle();
      if (currentError) {
        // Fail closed: merging onto an unread envelope would silently drop the stored key.
        return res.status(500).json({ error: 'Failed to read the current credentials' });
      }
      const existing = (current as { credentials_encrypted?: string } | null)?.credentials_encrypted ?? null;

      try {
        const merged = hardenCredentialEnvelope(
          buildCredentialEnvelope({ existing, supplied: checked.supplied }),
          { clearEnvName: checked.clearEnvName, suppliedKeys: checked.suppliedKeys },
        );
        // Write whenever the stored envelope changes — including a clear down to '{}'.
        if (merged !== (existing ?? '{}')) patch.credentials_encrypted = merged;
      } catch {
        // Fail CLOSED — never downgrade to storing plaintext.
        return res.status(500).json({ error: 'Failed to encrypt credentials' });
      }
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    try {
      const updated = await updateProviderAccount(
        id,
        patch as Parameters<typeof updateProviderAccount>[1],
      );
      return res.status(200).json({ account: toSafeProviderAccount(updated as unknown as Record<string, unknown>) });
    } catch {
      // A fixed message: a database error can quote the row being written.
      return res.status(500).json({ error: 'Failed to update account' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/provider-accounts/:id' });
