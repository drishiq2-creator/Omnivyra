import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
import { NextApiRequest, NextApiResponse } from 'next';
import { supabase } from '../../../backend/db/supabaseClient';
import {
  ingestComments,
  getCommentsForScheduledPost,
} from '../../../backend/services/engagementIngestionService';
import { bearerAuthorization } from '../../../lib/httpAuthHeaders';
import { getSupabaseUserFromRequest } from '../../../backend/services/supabaseAuthService';
import { enforceCompanyAccess } from '../../../backend/services/userContextService';
import { checkCommunityActionContactGovernance, linkedInCommentIdCandidates } from '../../../backend/services/communityAiContactGovernanceGate';

/**
 * ROUTE-AUTH-001: comment ingestion spends the social account's platform token,
 * so the caller must own that account (social_accounts.user_id) or be an active
 * member of the company it belongs to. Writes the denial and returns false.
 * An unknown account and an unowned one get the same 404.
 * Returns the authorised account (its company is the tenant for contact governance), or null after a denial.
 */
async function authorizeSocialAccount(
  req: NextApiRequest,
  res: NextApiResponse,
  callerUserId: string,
  socialAccountId: unknown,
): Promise<{ company_id: string | null } | null> {
  if (typeof socialAccountId !== 'string' || !socialAccountId) {
    res.status(404).json({ error: 'Social account not found' });
    return null;
  }
  const { data: account, error } = await supabase
    .from('social_accounts')
    .select('id, user_id, company_id')
    .eq('id', socialAccountId)
    .maybeSingle();
  if (error) {
    res.status(503).json({ error: 'Social account lookup failed. Please try again.' });
    return null;
  }
  if (!account) {
    res.status(404).json({ error: 'Social account not found' });
    return null;
  }
  const companyId = account.company_id ? String(account.company_id) : null;
  if (account.user_id && account.user_id === callerUserId) return { company_id: companyId };
  if (companyId) {
    const ctx = await enforceCompanyAccess({ req, res, companyId });
    return ctx ? { company_id: companyId } : null;
  }
  res.status(404).json({ error: 'Social account not found' });
  return null;
}

// Reply helpers left unchanged for now (deprecated later per canonical design).
const replyToLinkedInComment = async (accessToken: string, commentId: string, replyText: string) => {
  const response = await fetch('https://api.linkedin.com/v2/comments', {
    method: 'POST',
    headers: {
      Authorization: bearerAuthorization(accessToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: replyText,
      parentComment: `urn:li:comment:${commentId}`,
    }),
  });
  if (!response.ok) throw new Error(`LinkedIn reply failed: ${response.statusText}`);
  return response.json();
};

const replyToTwitterComment = async (accessToken: string, postId: string, replyText: string) => {
  const response = await fetch('https://api.twitter.com/2/tweets', {
    method: 'POST',
    headers: {
      Authorization: bearerAuthorization(accessToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: replyText,
      reply: { in_reply_to_tweet_id: postId },
    }),
  });
  if (!response.ok) throw new Error(`Twitter reply failed: ${response.statusText}`);
  return response.json();
};

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ROUTE-AUTH-001: authenticate before any lookup or platform call.
    const { user } = await getSupabaseUserFromRequest(req);
    if (!user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { platform, postId, accountId, action, commentId, replyText, scheduled_post_id } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Missing required field: action' });
    }

    if (action === 'fetch') {
      // Resolve scheduled_post_id: from body or by (platform_post_id, social_account_id)
      let resolvedScheduledPostId: string | null = scheduled_post_id ?? null;
      if (!resolvedScheduledPostId && platform && postId && accountId) {
        const { data: row } = await supabase
          .from('scheduled_posts')
          .select('id')
          .eq('platform_post_id', postId)
          .eq('social_account_id', accountId)
          .maybeSingle();
        resolvedScheduledPostId = row?.id ?? null;
      }
      if (!resolvedScheduledPostId) {
        return res.status(400).json({
          error: 'Cannot fetch comments: provide scheduled_post_id or (platform, postId, accountId) for a published post',
        });
      }
      // ROUTE-AUTH-001: bind the post to the caller through the social account
      // whose token ingestion would use.
      const { data: post, error: postError } = await supabase
        .from('scheduled_posts')
        .select('id, social_account_id')
        .eq('id', resolvedScheduledPostId)
        .maybeSingle();
      if (postError) {
        return res.status(503).json({ error: 'Scheduled post lookup failed. Please try again.' });
      }
      if (!post) {
        return res.status(404).json({ error: 'Scheduled post not found' });
      }
      if (!(await authorizeSocialAccount(req, res, user.id, post.social_account_id))) return;
      const ingestResult = await ingestComments(resolvedScheduledPostId);
      const comments = await getCommentsForScheduledPost(resolvedScheduledPostId);
      return res.status(200).json({
        success: true,
        platform,
        action: 'fetch',
        data: comments,
        ingested: ingestResult.ingested,
      });
    }

    if (action === 'reply') {
      if (!platform || !postId || !accountId || !replyText) {
        return res.status(400).json({ error: 'Reply requires platform, postId, accountId, replyText' });
      }
      const account = await authorizeSocialAccount(req, res, user.id, accountId);
      if (!account) return;
      if (platform === 'linkedin' && !commentId) return res.status(400).json({ error: 'Comment ID is required for LinkedIn replies' });
      // Round 26 (review S-4 / GD-3): a direct reply reaches the AUTHOR of the comment (or post) replied to, so the
      // one contact-governance gate is asked BEFORE any platform call. Tenant = the social account's company (never
      // the body). The gate resolves the author from the engagement store; suppressed or unidentifiable → 403 with a
      // reason code; governance unreadable or no tenant → 503. Nothing is sent on any refusal.
      // A user-owned account with no company has no tenant to ask governance for: refuse as unavailable (503).
      if (!account.company_id) {
        return res.status(503).json({ error: 'CONTACT_GOVERNANCE_UNAVAILABLE', code: 'CONTACT_GOVERNANCE_UNAVAILABLE', reason: 'no_tenant_failclosed' });
      }
      // Integration review M-5: a LinkedIn comment id is stored as `123`, `(urn:li:activity:1,123)` or
      // `urn:li:comment:(urn:li:activity:1,123)` depending on the ingester; every form is tried.
      const commentCandidates = platform === 'linkedin'
        ? linkedInCommentIdCandidates(commentId, postId)
        : [String(commentId || postId)];
      const contactGate = await checkCommunityActionContactGovernance({
        organization_id: account.company_id,
        platform,
        action_type: 'reply',
        target_id: commentCandidates[0],
        platform_message_ids: commentCandidates,
        parent_comment_urn: null,
      });
      if (contactGate.allowed === false) {
        const status = contactGate.code === 'CONTACT_GOVERNANCE_UNAVAILABLE' ? 503 : 403;
        return res.status(status).json({ error: contactGate.code, code: contactGate.code, reason: contactGate.reason });
      }
      const mockAccessToken = `mock_token_${accountId}`;
      let result: any;
      if (platform === 'linkedin') {
        if (!commentId) return res.status(400).json({ error: 'Comment ID is required for LinkedIn replies' });
        result = await replyToLinkedInComment(mockAccessToken, commentId, replyText);
      } else if (platform === 'twitter') {
        result = await replyToTwitterComment(mockAccessToken, postId, replyText);
      } else if (platform === 'facebook' || platform === 'instagram') {
        result = { id: `reply_${Date.now()}`, message: 'Reply posted successfully' };
      } else {
        throw new Error(`Unsupported platform: ${platform}`);
      }
      return res.status(200).json({ success: true, platform, action: 'reply', data: result });
    }

    if (action === 'delete') {
      return res.status(200).json({ success: true, platform, action: 'delete', data: { message: 'Comment deleted successfully' } });
    }

    return res.status(400).json({ error: `Unsupported action: ${action}` });
  } catch (error: any) {
    console.error('Comment management error:', error);
    return res.status(500).json({ error: error.message, success: false });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/social/comments' });
