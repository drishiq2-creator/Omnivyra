import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';

/**
 * POST /api/social-accounts/disconnect
 * Disconnects the current user's social_accounts rows for one platform: provider revoke where supported, stored
 * tokens deleted, audited (R26 T-4).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { supabase } from '@/backend/db/supabaseClient';
import { getSupabaseUserFromRequest } from '@/backend/services/supabaseAuthService';
import { disconnectSocialAccounts, type SocialAccountRow, type SocialDisconnectOutcome } from '@/backend/services/tenantCredentialDisconnect';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { user, error } = await getSupabaseUserFromRequest(req);
  if (error || !user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = user.id;

  const { platform } = req.body || {};
  if (!platform) return res.status(400).json({ error: 'platform required' });
  const normalizedPlatform = String(platform).toLowerCase().trim();
  const platformAliases = normalizedPlatform === 'x' || normalizedPlatform === 'twitter'
    ? ['x', 'twitter']
    : [normalizedPlatform];

  // R26 T-4: select the caller's active rows, then disconnect them through the one disconnect seam
  // (backend/services/tenantCredentialDisconnect.ts): provider revoke where possible, stored tokens wiped,
  // one audit row each. The old code only set is_active=false and kept the encrypted tokens.
  const { data: rows, error: readErr } = await supabase
    .from('social_accounts')
    .select('id, platform, company_id, user_id')
    .eq('user_id', userId)
    .in('platform', platformAliases)
    .eq('is_active', true)
    .not('platform_user_id', 'like', 'planning_%');

  if (readErr) {
    console.error('[social-accounts/disconnect]', readErr);
    return res.status(500).json({ error: readErr.message });
  }

  const targets = (rows ?? []) as SocialAccountRow[];
  if (targets.length === 0) {
    // Surface the silent-no-op so the UI can show the user the truth instead
    // of a false success toast. The most common cause is a row owned by a
    // different users.id (duplicate users rows for the same human).
    return res.status(404).json({
      error:
        `No active ${normalizedPlatform} account found for your user. ` +
        `The connection may belong to a different login — check the users table for duplicates.`,
      disconnected: 0,
    });
  }

  let outcomes: SocialDisconnectOutcome[];
  try {
    outcomes = await disconnectSocialAccounts(targets, { actorUserId: userId, source: 'social-accounts/disconnect' });
  } catch (err) {
    console.error('[social-accounts/disconnect]', err);
    return res.status(500).json({ error: 'Disconnect failed: the stored credentials could not be deleted. Try again.' });
  }

  // Integration review H-1: "disconnected" only when every row's tokens were PROVEN deleted (read back empty).
  const unproven = outcomes.filter((o) => !o.credentials_deleted);
  if (unproven.length) {
    return res.status(500).json({
      error: 'Disconnect incomplete: stored credentials could not be confirmed deleted. Try again.',
      code: 'CREDENTIALS_NOT_DELETED',
      credentials_deleted: false,
      failures: unproven.map((o) => ({ platform: o.platform, reason: o.credentials_reason ?? 'unknown' })),
      provider_revocation: outcomes.map((o) => ({ platform: o.platform, status: o.revocation.status })),
    });
  }

  return res.status(200).json({
    success: true,
    disconnected: outcomes.length,
    credentials_deleted: true,
    // Stated, never implied: 'failed' / 'unsupported' mean the grant may still be live at the provider.
    provider_revocation: outcomes.map((o) => ({ platform: o.platform, status: o.revocation.status })),
  });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/social-accounts/disconnect' });
