import { ownedDbTable } from '../db/writeOwner';
/**
 * Platform Token Service
 *
 * After the consolidation: `social_accounts` is the SINGLE source of truth for
 * OAuth tokens. `community_ai_platform_tokens` stores ONLY metadata
 * (tenant_id, organization_id, connected_by_user_id, platform, scopes,
 * timestamps) so we can answer "did this org connect platform X via the
 * community-AI flow, and who clicked the button?" without the dual-table
 * drift that previously corrupted X refresh_tokens.
 *
 * All token reads in this module fan out to `tokenStore.getToken(socialAccountId)`
 * after resolving (organization_id, platform) → social_accounts.id. Refresh
 * is handled in tokenStore/tokenRefresh; this module no longer mints,
 * rotates, or persists access tokens.
 */

import { supabase } from '../db/supabaseClient';
import { getToken as getTokenFromStore, isTokenExpiringSoon } from '../auth/tokenStore';
import { refreshPlatformToken } from '../auth/tokenRefresh';
import { normalizePlatform } from '../constants/platforms';
import { PlatformAccountResolutionError } from './platformAccountResolution';

export {
  PlatformAccountResolutionError,
  platformAccountResolutionCode,
  type PlatformAccountResolutionCode,
} from './platformAccountResolution';

type TokenInput = {
  /** Accepted for back-compat with OAuth callbacks but no longer persisted
   *  in this table. The canonical store is social_accounts via setToken. */
  access_token?: string;
  refresh_token?: string | null;
  expires_at?: string | null;
  /** Owner of the connection — drives community-AI disconnect authority. */
  connected_by_user_id?: string | null;
  /** OAuth scopes granted, if the callback knows them. Stored verbatim. */
  scopes?: string[] | null;
};

const PLATFORM_ALIASES: Record<string, string[]> = {
  x: ['x', 'twitter'],
  twitter: ['twitter', 'x'],
};

/**
 * Outcome of resolving the ONE social_accounts row an organization sends
 * through on a platform. Tenant-safe by construction:
 *   - only rows with company_id = the organization (never a company_id NULL
 *     legacy/personal row, never another company's row);
 *   - only rows connected by an active member of that organization;
 *   - more than one matching active row is AMBIGUOUS — never picked by recency;
 *   - a failed read is LOOKUP_FAILED — never rendered as "not connected".
 */
export type SocialAccountResolution =
  | { status: 'resolved'; socialAccountId: string }
  | { status: 'not_connected' }
  | { status: 'ambiguous' }
  | { status: 'lookup_failed'; stage: 'user_company_roles' | 'social_accounts'; message: string };

export async function resolveSocialAccountForOrg(
  organizationId: string,
  platform: string,
): Promise<SocialAccountResolution> {
  const platformsToMatch = PLATFORM_ALIASES[platform] ?? [platform];

  const { data: roleRows, error: roleError } = await ownedDbTable('user_company_roles')
    .select('user_id')
    .eq('company_id', organizationId)
    .eq('status', 'active');
  if (roleError) {
    return { status: 'lookup_failed', stage: 'user_company_roles', message: roleError.message ?? 'read failed' };
  }
  const userIds = (roleRows ?? []).map((r: { user_id: string }) => r.user_id).filter(Boolean);
  if (userIds.length === 0) return { status: 'not_connected' };

  // Only rows that can serve an API token count as an account: a token-less
  // (extension / cookie-backed) row is not a candidate.
  const { data: rows, error: accountError } = await ownedDbTable('social_accounts')
    .select('id, platform_user_id, updated_at')
    .eq('company_id', organizationId)
    .in('user_id', userIds)
    .eq('is_active', true)
    .in('platform', platformsToMatch)
    .not('access_token', 'is', null);
  if (accountError) {
    return { status: 'lookup_failed', stage: 'social_accounts', message: accountError.message ?? 'read failed' };
  }

  // One external account per platform_user_id (the same account stored under
  // both x and twitter is one account; its latest row is used). planning_%
  // placeholders are not accounts. Rows without a platform_user_id each count.
  type CandidateRow = { id: string; platform_user_id?: string | null; updated_at?: string | null };
  const accounts = new Map<string, CandidateRow>();
  for (const row of (rows ?? []) as CandidateRow[]) {
    if (!row?.id) continue;
    const puid = typeof row.platform_user_id === 'string' && row.platform_user_id ? row.platform_user_id : null;
    if (puid && puid.startsWith('planning_')) continue;
    const key = puid ? `puid:${puid}` : `row:${row.id}`;
    const prev = accounts.get(key);
    if (!prev || String(row.updated_at ?? '') > String(prev.updated_at ?? '')) accounts.set(key, row);
  }
  if (accounts.size === 0) return { status: 'not_connected' };
  if (accounts.size > 1) return { status: 'ambiguous' };
  return { status: 'resolved', socialAccountId: Array.from(accounts.values())[0].id };
}

/** Active member user ids of a company; a read error throws LOOKUP_FAILED (never "no members"). */
async function listActiveMemberIdsOrThrow(organizationId: string): Promise<string[]> {
  const { data: roleRows, error } = await ownedDbTable('user_company_roles')
    .select('user_id')
    .eq('company_id', organizationId)
    .eq('status', 'active');
  if (error) {
    throw new PlatformAccountResolutionError(
      'PLATFORM_ACCOUNT_LOOKUP_FAILED',
      `Could not read user_company_roles while listing platforms: ${error.message ?? 'read failed'}`,
    );
  }
  return (roleRows ?? []).map((r: { user_id: string }) => r.user_id).filter(Boolean);
}

/**
 * Persist or update connector metadata for an organization+platform.
 *
 * IMPORTANT: this function NO LONGER stores access_token / refresh_token /
 * expires_at. Those columns have been dropped from community_ai_platform_tokens
 * and tokens live exclusively in social_accounts (written by tokenStore.setToken
 * during the OAuth callback). Token fields on the input are accepted for
 * back-compat with existing callers but ignored.
 */
export const saveToken = async (
  tenant_id: string,
  organization_id: string,
  platform: string,
  tokenData: TokenInput,
) => {
  const normalized = normalizePlatform(platform);
  const payload: Record<string, unknown> = {
    tenant_id,
    organization_id,
    platform: normalized,
    updated_at: new Date().toISOString(),
  };
  if (tokenData.connected_by_user_id != null) {
    payload.connected_by_user_id = tokenData.connected_by_user_id;
  }
  if (tokenData.scopes != null) {
    payload.scopes = tokenData.scopes;
  }

  const { data: existing, error: lookupError } = await ownedDbTable('community_ai_platform_tokens')
    .select('id')
    .eq('tenant_id', tenant_id)
    .eq('organization_id', organization_id)
    .eq('platform', normalized)
    .limit(1);

  if (lookupError) {
    throw new Error(`Failed to lookup connector metadata: ${lookupError.message}`);
  }

  if (existing && existing.length > 0) {
    const { data, error } = await ownedDbTable('community_ai_platform_tokens')
      .update(payload)
      .eq('id', existing[0].id)
      .eq('tenant_id', tenant_id)
      .eq('organization_id', organization_id)
      .select('*')
      .limit(1);
    if (error) {
      throw new Error(`Failed to update connector metadata: ${error.message}`);
    }
    return data?.[0] || null;
  }

  const { data, error } = await ownedDbTable('community_ai_platform_tokens')
    .insert({ ...payload, created_at: new Date().toISOString() })
    .select('*')
    .limit(1);
  if (error) {
    throw new Error(`Failed to insert connector metadata: ${error.message}`);
  }
  return data?.[0] || null;
};

/**
 * Read tokens for an (org, platform) connection. Sources tokens from
 * social_accounts via tokenStore; refreshes in-flight if near expiry. Returns
 * the same shape callers expected from the old dual-table getToken so this
 * change is transparent to communityAiActionExecutor / communityAiScheduler
 * etc.
 */
export const getToken = async (
  tenant_id: string,
  organization_id: string,
  platform: string,
) => {
  const normalized = normalizePlatform(platform);

  const resolution = await resolveSocialAccountForOrg(organization_id, normalized);
  if (resolution.status === 'not_connected') return null;
  if (resolution.status === 'ambiguous') {
    throw new PlatformAccountResolutionError(
      'PLATFORM_ACCOUNT_AMBIGUOUS',
      `More than one active ${normalized} account is connected for this organization; refusing to choose one`,
    );
  }
  if (resolution.status === 'lookup_failed') {
    throw new PlatformAccountResolutionError(
      'PLATFORM_ACCOUNT_LOOKUP_FAILED',
      `Could not read ${resolution.stage} while resolving the ${normalized} account: ${resolution.message}`,
    );
  }
  const accountId = resolution.socialAccountId;

  let tokenObj = await getTokenFromStore(accountId);
  if (!tokenObj?.access_token) return null;

  if (isTokenExpiringSoon(tokenObj, 5)) {
    const refreshed = await refreshPlatformToken(normalized, accountId, tokenObj);
    if (refreshed?.access_token) {
      tokenObj = refreshed;
    }
  }

  return {
    access_token: tokenObj.access_token,
    refresh_token: tokenObj.refresh_token ?? null,
    expires_at: tokenObj.expires_at ?? null,
    tenant_id,
    organization_id,
    platform: normalized,
  };
};

/**
 * List platforms an org has connected. Sources from social_accounts only —
 * the connector metadata table no longer holds tokens, so an authoritative
 * "connected" check has to look where the tokens actually live.
 */
export async function getPlatformsWithTokensForOrg(
  organization_id: string,
): Promise<string[]> {
  const platforms = new Set<string>();

  const userIds = await listActiveMemberIdsOrThrow(organization_id);
  if (userIds.length === 0) return [];

  // Company-only (never a company_id NULL legacy/personal row), matching
  // resolveSocialAccountForOrg. A read error throws LOOKUP_FAILED, never [].
  const { data: saRows, error } = await ownedDbTable('social_accounts')
    .select('platform')
    .eq('company_id', organization_id)
    .in('user_id', userIds)
    .eq('is_active', true)
    .not('access_token', 'is', null);
  if (error) {
    throw new PlatformAccountResolutionError(
      'PLATFORM_ACCOUNT_LOOKUP_FAILED',
      `Could not read social_accounts while listing platforms: ${error.message ?? 'read failed'}`,
    );
  }
  for (const r of saRows ?? []) {
    if (r.platform) platforms.add(normalizePlatform(r.platform));
  }

  return Array.from(platforms).sort();
}

/**
 * List platforms that have an active social_accounts row for users in the org.
 * This intentionally does not require access_token to be present: Company Admin
 * can surface browser-extension or cookie/session backed platforms that do not
 * have a first-party API token available to the engagement center.
 */
export async function getPlatformsWithActiveSocialAccountsForOrg(
  organization_id: string,
): Promise<string[]> {
  const platforms = new Set<string>();

  const userIds = await listActiveMemberIdsOrThrow(organization_id);
  if (userIds.length === 0) return [];

  // Company-only, matching resolveSocialAccountForOrg. A read error throws
  // LOOKUP_FAILED, never [].
  const { data: saRows, error } = await ownedDbTable('social_accounts')
    .select('platform')
    .eq('company_id', organization_id)
    .in('user_id', userIds)
    .eq('is_active', true)
    .not('platform_user_id', 'like', 'planning_%');
  if (error) {
    throw new PlatformAccountResolutionError(
      'PLATFORM_ACCOUNT_LOOKUP_FAILED',
      `Could not read social_accounts while listing platforms: ${error.message ?? 'read failed'}`,
    );
  }

  for (const r of saRows ?? []) {
    if (r.platform) platforms.add(normalizePlatform(r.platform));
  }

  return Array.from(platforms).sort();
}

/**
 * Owner-based disconnect authority — preserved as metadata column on
 * community_ai_platform_tokens.
 */
export async function getConnectorConnectedByUserId(
  tenant_id: string,
  organization_id: string,
  platform: string,
): Promise<string | null> {
  const normalized = normalizePlatform(platform);
  const { data, error } = await ownedDbTable('community_ai_platform_tokens')
    .select('connected_by_user_id')
    .eq('tenant_id', tenant_id)
    .eq('organization_id', organization_id)
    .eq('platform', normalized)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { connected_by_user_id?: string | null }).connected_by_user_id ?? null;
}

/**
 * Disconnect a community-AI connector. Tokens themselves live in
 * social_accounts and are revoked through the standard social-platforms
 * disconnect flow; here we delete the metadata row that records "this org
 * connected this platform via the community-AI flow."
 */
export const revokeToken = async (
  tenant_id: string,
  organization_id: string,
  platform: string,
) => {
  const normalized = normalizePlatform(platform);
  const { data, error } = await ownedDbTable('community_ai_platform_tokens')
    .delete()
    .eq('tenant_id', tenant_id)
    .eq('organization_id', organization_id)
    .eq('platform', normalized)
    .select('*')
    .limit(1);
  if (error) {
    throw new Error(`Failed to delete connector metadata: ${error.message}`);
  }
  return data?.[0] || null;
};
