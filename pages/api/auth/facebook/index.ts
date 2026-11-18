import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';
import { NextApiRequest, NextApiResponse } from 'next';
import { getBaseUrl } from '../../../../backend/auth/getBaseUrl';
import { encodeOAuthState } from '../../../../backend/auth/oauthState';
import { getOAuthCredentialsForPlatform } from '../../../../backend/auth/oauthCredentialResolver';
import { getSupabaseUserFromRequest } from '../../../../backend/services/supabaseAuthService';
import { logOAuthEvent } from '../../../../backend/auth/oauthTelemetry';
import { enforceCompanyAccess } from '../../../../backend/services/userContextService';

/** A same-origin path, or the default. '//host' (protocol-relative) and '/' + backslash forms are refused. */
function safeLocalPath(value: unknown, fallback = '/social-platforms'): string {
  const v = typeof value === 'string' ? value : '';
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return fallback;
  return v;
}
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ROUTE-AUTH-001: the signed state names the user and company the callback
    // will write the connection for, so only an authenticated session may mint
    // it — for itself, and only for a company it is an active member of. The
    // client-supplied ?userId= is ignored.
    const { user } = await getSupabaseUserFromRequest(req);
    if (!user?.id) {
      return res.status(401).json({ error: 'Login session required — please log in and try again' });
    }
    const companyId = (req.query.companyId as string) || undefined;
    // b3 (11-19): a Meta connection is ALWAYS for a company. A company-less connect stored Meta tokens in an
    // untenanted social_accounts row that publishing never uses (postSocialAccountResolver skips company_id
    // NULL) - a dormant credential and pure liability. With a company selected the UI uses the community-ai
    // connectors; this route is refused without one, before any state is minted.
    if (!companyId) {
      // Reached only by a full-page navigation (useSocialPlatforms), so the user is sent back with the message,
      // as the callbacks do - never a raw JSON body in the browser (7c).
      logOAuthEvent({ event: 'oauth_failure', provider: 'facebook', company_id: null, user_id: user.id, failure_point: 'company_required', failure_detail: 'no company selected' });
      return res.redirect(`${safeLocalPath(req.query.returnTo)}?error=${encodeURIComponent('Choose a company first')}`);
    }
    const access = await enforceCompanyAccess({ req, res, companyId });
    if (!access) return;

    const credentials = await getOAuthCredentialsForPlatform('facebook');
    if (!credentials?.client_id) {
      return res.status(400).json({ error: 'Facebook OAuth not configured — ask your Super Admin to add credentials.' });
    }

    const returnTo = safeLocalPath(req.query.returnTo);
    const state = encodeOAuthState({ companyId, userId: user.id, returnTo });

    const params = new URLSearchParams({
      client_id: credentials.client_id,
      redirect_uri: `${getBaseUrl(req)}/api/auth/facebook/callback`,
      // Facebook-only scopes. Instagram-specific scopes (instagram_basic,
      // instagram_content_publish, instagram_manage_insights, etc.) MUST
      // NOT appear here — Meta rejects the consent dialog with "Invalid
      // Scopes" when Instagram products aren't fully provisioned on the
      // app, and we want clean separation regardless. Instagram is
      // connected through /api/auth/instagram or /api/community-ai/
      // connectors/instagram/auth, each of which requests its own scope set.
      //
      // business_management is required when Pages are owned by a Business
      // Portfolio — without it, /me/accounts returns empty for Business-
      // owned Pages even when the OAuth user is admin.
      scope: 'pages_show_list,pages_read_engagement,pages_manage_posts,pages_manage_engagement,business_management,public_profile',
      response_type: 'code',
      state,
    });

    res.redirect(`https://www.facebook.com/v22.0/dialog/oauth?${params.toString()}`);
  } catch (error: any) {
    console.error('Facebook OAuth initiation error:', error);
    res.status(500).json({ error: error.message });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/auth/facebook' });
