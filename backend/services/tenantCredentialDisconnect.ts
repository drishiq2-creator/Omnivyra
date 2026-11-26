/**
 * R26 T-4 — what "disconnect" means for a tenant's social OAuth grant, in one place.
 *
 * Before round 26, POST /api/social-accounts/disconnect and DELETE /api/community-ai/connectors/[platform] set
 * `is_active=false` and left the encrypted access/refresh tokens on the row, and nothing anywhere called a provider
 * revoke endpoint. A tenant's "disconnect" left a live, decryptable grant inside Omnivyra.
 *
 * Disconnect is now, per social_accounts row, in this order:
 *   1. READ the decrypted token (tokenStore.getToken) — needed for step 2, and only possible before step 3;
 *   2. REVOKE at the provider where a token-only revoke API exists (Google/YouTube, Meta: Facebook/Instagram/Threads/
 *      WhatsApp). Every other provider is recorded as 'unsupported' (its revoke call needs the platform OAuth app's
 *      client credentials; follow-up). A revoke failure does NOT stop step 3 — local deletion is the part we control;
 *   3. WIPE every token column in ONE update of Production columns only, and PROVE it by reading the updated row
 *      back (see WIPE / tokensProvenDeleted below; integration review H-1);
 *   4. AUDIT one `audit_events` row with the revocation outcome and whether deletion was proven, and return it to
 *      the caller, so a failed, skipped or unsupported revoke — or an unproven wipe — is stated explicitly.
 * Step 2 is skipped (`skipped_shared_grant`) when another active row shares the provider grant (M-4).
 */
import { ownedDbTable } from '../db/writeOwner';
import { getToken } from '../auth/tokenStore';
import { recordAuditEvent } from './auditEventService';

export type ProviderRevocationStatus = 'revoked' | 'failed' | 'unsupported' | 'no_token' | 'skipped_shared_grant';

export interface ProviderRevocationOutcome {
  status: ProviderRevocationStatus;
  /** Provider HTTP status or error class. Never a token. */
  detail?: string;
}

export type RevokeFetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

const REVOKE_TIMEOUT_MS = 10_000;
const GRAPH_API = 'https://graph.facebook.com/v22.0';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';

const GOOGLE_PLATFORMS = new Set(['youtube', 'google', 'google_business', 'gmb']);
const META_PLATFORMS = new Set(['facebook', 'instagram', 'threads', 'whatsapp', 'meta']);

const defaultFetch: RevokeFetch = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS) });

/**
 * Revoke one grant at its provider. Never throws; never puts a token in `detail`.
 * The token travels in the request BODY (Google) or the Authorization header (Meta), never in a URL.
 */
export async function revokeAtProvider(
  platform: string,
  token: { access_token?: string | null; refresh_token?: string | null } | null,
  fetchImpl: RevokeFetch = defaultFetch,
): Promise<ProviderRevocationOutcome> {
  const key = String(platform || '').toLowerCase().trim();
  const isGoogle = GOOGLE_PLATFORMS.has(key);
  const isMeta = META_PLATFORMS.has(key);
  if (!isGoogle && !isMeta) return { status: 'unsupported', detail: `no token-only revoke API for ${key || 'unknown'}` };

  // Google: revoking the refresh token revokes the whole grant; fall back to the access token.
  const value = isGoogle ? (token?.refresh_token || token?.access_token) : token?.access_token;
  if (!value) return { status: 'no_token' };

  try {
    const res = isGoogle
      ? await fetchImpl(GOOGLE_REVOKE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: value }).toString(),
        })
      : await fetchImpl(`${GRAPH_API}/me/permissions`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${value}` },
        });
    return res.ok ? { status: 'revoked', detail: `http_${res.status}` } : { status: 'failed', detail: `http_${res.status}` };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'error';
    return { status: 'failed', detail: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error' };
  }
}

/**
 * Every token-bearing `social_accounts` column in PRODUCTION (CT-verified 2026-11-27; prod schema dump
 * closure-r6/e2e-refresh/prod-public-schema.sql): access_token (NOT NULL), refresh_token, page_access_token,
 * ig_user_token, threads_token, plus the expiry. Production has NO `status` column — writing one fails the whole
 * update (integration review H-1), which is why this is ONE update with Production columns only.
 * `access_token` is NOT NULL, so it becomes '' (tokenStore.getToken reads '' as "no token"); every other token
 * column becomes null. `is_active:false` is in the SAME update: social_accounts_facebook_token_chk only allows a
 * null page_access_token on an inactive (or system-user) row.
 */
export const TOKEN_COLUMNS = ['access_token', 'refresh_token', 'page_access_token', 'ig_user_token', 'threads_token'] as const;

const WIPE = {
  access_token: '',
  refresh_token: null,
  page_access_token: null,
  ig_user_token: null,
  threads_token: null,
  token_expires_at: null,
  is_active: false,
  // The canonical lifecycle value for an explicit revoke (backend/services/integrations/connectionState.ts).
  connection_state: 'DISCONNECTED',
} as const;

/** Re-read shape: the update's `.select()` of the very row it changed. */
const VERIFY_COLUMNS = `id, is_active, ${TOKEN_COLUMNS.join(', ')}`;

/** Proven only when the updated row reads back with every token column empty. */
function tokensProvenDeleted(row: Record<string, unknown> | null | undefined): { ok: boolean; reason?: string } {
  if (!row) return { ok: false, reason: 'row_not_updated' };
  const left = TOKEN_COLUMNS.filter((c) => (c === 'access_token' ? row[c] !== '' && row[c] != null : row[c] != null));
  if (left.length) return { ok: false, reason: `token_columns_not_cleared:${left.join(',')}` };
  if (row.is_active !== false) return { ok: false, reason: 'row_still_active' };
  return { ok: true };
}

/**
 * Meta and Google revoke the WHOLE grant (Meta `DELETE /me/permissions` drops the app for that Meta user; Google
 * revokes the refresh token's grant). One Facebook Page / Instagram / Threads row shares that grant with its
 * siblings. Revoking for one row would silently break the others (integration review M-4), so a provider revoke is
 * attempted only when no OTHER active row of the same user and provider family remains.
 */
const PROVIDER_FAMILY: Record<string, 'meta' | 'google'> = {
  facebook: 'meta', instagram: 'meta', threads: 'meta', whatsapp: 'meta', meta: 'meta',
  youtube: 'google', google: 'google', google_business: 'google', gmb: 'google',
};
const FAMILY_PLATFORMS: Record<'meta' | 'google', string[]> = {
  meta: ['facebook', 'instagram', 'threads', 'whatsapp', 'meta'],
  google: ['youtube', 'google', 'google_business', 'gmb'],
};

async function otherActiveRowsShareGrant(
  row: SocialAccountRow,
  batchIds: Set<string>,
): Promise<{ shared: boolean; detail?: string }> {
  const family = PROVIDER_FAMILY[String(row.platform || '').toLowerCase().trim()];
  if (!family) return { shared: false };
  if (!row.user_id) return { shared: true, detail: 'owner_unknown' }; // cannot prove the grant is exclusive
  try {
    const { data, error } = await ownedDbTable('social_accounts')
      .select('id')
      .eq('user_id', row.user_id)
      .eq('is_active', true)
      .in('platform', FAMILY_PLATFORMS[family]);
    if (error) return { shared: true, detail: 'sibling_check_failed' };
    const others = ((data as Array<{ id?: string }>) ?? []).filter((r) => r.id && r.id !== row.id && !batchIds.has(r.id));
    return others.length ? { shared: true, detail: `active_siblings:${others.length}` } : { shared: false };
  } catch {
    return { shared: true, detail: 'sibling_check_failed' };
  }
}

export interface SocialAccountRow {
  id: string;
  platform: string;
  company_id?: string | null;
  /** The connecting user: rows of the same user + provider family share one provider grant. */
  user_id?: string | null;
}

export interface SocialDisconnectOutcome {
  social_account_id: string;
  platform: string;
  /** True ONLY when the updated row was read back with every token column empty. */
  credentials_deleted: boolean;
  /** Why credentials_deleted is false (never a token). */
  credentials_reason?: string;
  revocation: ProviderRevocationOutcome;
}

/**
 * Disconnect the given social_accounts rows (already selected and authorised by the caller). Never throws for a
 * per-row failure: each outcome states whether the tokens are PROVEN deleted, and every row is audited either way.
 * The caller must not report "disconnected" unless every outcome has credentials_deleted === true.
 */
export async function disconnectSocialAccounts(
  rows: SocialAccountRow[],
  ctx: { actorUserId: string | null; companyId?: string | null; source: string },
  deps: { fetchImpl?: RevokeFetch } = {},
): Promise<SocialDisconnectOutcome[]> {
  const outcomes: SocialDisconnectOutcome[] = [];
  const batchIds = new Set(rows.map((r) => r.id));
  const revokedGrants = new Set<string>();
  for (const row of rows) {
    const token = await getToken(row.id);
    let revocation: ProviderRevocationOutcome;
    if (!token) {
      revocation = { status: 'no_token' };
    } else {
      const family = PROVIDER_FAMILY[String(row.platform || '').toLowerCase().trim()];
      const grantKey = family ? `${family}:${row.user_id ?? row.id}` : null;
      const sharing = await otherActiveRowsShareGrant(row, batchIds);
      if (sharing.shared) {
        revocation = { status: 'skipped_shared_grant', detail: sharing.detail };
      } else if (grantKey && revokedGrants.has(grantKey)) {
        revocation = { status: 'revoked', detail: 'grant_already_revoked_in_this_disconnect' };
      } else {
        revocation = await revokeAtProvider(row.platform, token, deps.fetchImpl);
        if (grantKey && revocation.status === 'revoked') revokedGrants.add(grantKey);
      }
    }

    let credentialsDeleted = false;
    let credentialsReason: string | undefined;
    try {
      const { data, error } = await ownedDbTable('social_accounts')
        .update({ ...WIPE, updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .select(VERIFY_COLUMNS)
        .maybeSingle();
      if (error) {
        credentialsReason = `update_failed:${String(error.message ?? 'error').slice(0, 120)}`;
      } else {
        const proof = tokensProvenDeleted(data as unknown as Record<string, unknown> | null);
        credentialsDeleted = proof.ok;
        credentialsReason = proof.reason;
      }
    } catch (err) {
      credentialsReason = `update_threw:${err instanceof Error ? err.message.slice(0, 120) : 'error'}`;
    }

    outcomes.push({
      social_account_id: row.id,
      platform: row.platform,
      credentials_deleted: credentialsDeleted,
      ...(credentialsReason ? { credentials_reason: credentialsReason } : {}),
      revocation,
    });

    if (revocation.status === 'failed') {
      console.warn('[tenant_credential.disconnect] provider revoke failed', { social_account_id: row.id, platform: row.platform, detail: revocation.detail });
    }
    if (!credentialsDeleted) {
      console.error('[tenant_credential.disconnect] stored tokens NOT proven deleted', { social_account_id: row.id, platform: row.platform, reason: credentialsReason });
    }
    await recordAuditEvent({
      companyId: row.company_id ?? ctx.companyId ?? null,
      actorUserId: ctx.actorUserId,
      actorType: ctx.actorUserId ? 'user' : 'system',
      action: 'tenant_credential.social_disconnected',
      resourceType: 'social_account',
      resourceId: row.id,
      severity: !credentialsDeleted ? 'critical' : revocation.status === 'failed' ? 'warning' : 'info',
      metadata: {
        source: ctx.source,
        platform: row.platform,
        credentials_deleted: credentialsDeleted,
        credentials_reason: credentialsReason ?? null,
        provider_revocation: revocation.status,
        provider_revocation_detail: revocation.detail ?? null,
      },
    });
  }
  return outcomes;
}
