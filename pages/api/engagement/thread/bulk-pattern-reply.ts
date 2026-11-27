import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';

/**
 * POST /api/engagement/thread/bulk-pattern-reply
 * Apply response pattern and send AI-generated reply to selected threads.
 * Body: thread_ids, pattern_id, organization_id
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveUserContext, enforceCompanyAccess } from '../../../../backend/services/userContextService';
import { enforceRole } from '../../../../backend/services/rbacService';
import { COMMUNITY_AI_CAPABILITIES } from '../../../../backend/services/rbac/communityAiCapabilities';
import { supabase } from '../../../../backend/db/supabaseClient';
import {
  readBulkReplyEnabled,
  EngagementControlsUnreadableError,
} from '../../../../backend/services/engagementGovernanceService';
import { bulkReplyThreads } from '../../../../backend/services/bulkEngagementService';
import { generateResponse } from '../../../../backend/services/responseGenerationService';
import { SUPPORTED_TAGS } from '../../../../backend/services/taggedResponseInterpreter';

const MAX_BATCH = 20;
const TAG_SET = new Set(SUPPORTED_TAGS.map((t) => t.toLowerCase()));

type Body = {
  thread_ids?: string[];
  pattern_id?: string;
  organization_id?: string;
};

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const user = await resolveUserContext(req);
    const body = (req.body || {}) as Body;
    const rawThreadIds = Array.isArray(body.thread_ids) ? body.thread_ids : [];
    const patternId = body.pattern_id?.trim();
    const organizationId = body.organization_id ?? user?.defaultCompanyId;

    if (!organizationId) {
      return res.status(400).json({ error: 'organization_id required' });
    }
    if (rawThreadIds.length === 0) {
      return res.status(400).json({ error: 'thread_ids required' });
    }
    if (!patternId) {
      return res.status(400).json({ error: 'pattern_id required' });
    }

    const access = await enforceCompanyAccess({ req, res, companyId: organizationId });
    if (!access) return;

    const roleGate = await enforceRole({
      req,
      res,
      companyId: organizationId,
      allowedRoles: [...COMMUNITY_AI_CAPABILITIES.EXECUTE_ACTIONS],
    });
    if (!roleGate) return;

    // FIX-2: the tenant's bulk-reply switch — the same contract bulk-ai-reply
    // enforces. Checked against the access-validated organizationId, AFTER
    // access + role and BEFORE any pattern read, LLM generation or send.
    // F-FU1 (owner 2026-11-27): the switch fails CLOSED. A policy that cannot
    // be read refuses with 503 BULK_REPLY_CONTROLS_UNREADABLE; an absent row
    // keeps the product default (enabled).
    let bulkReplyEnabled: boolean;
    try {
      bulkReplyEnabled = await readBulkReplyEnabled(organizationId);
    } catch (policyErr) {
      if (policyErr instanceof EngagementControlsUnreadableError) {
        console.error(
          JSON.stringify({
            event: 'bulk_pattern_reply_refused',
            code: 'BULK_REPLY_CONTROLS_UNREADABLE',
            organization_id: organizationId,
          })
        );
        return res.status(503).json({
          error: 'Bulk reply policy could not be read',
          code: 'BULK_REPLY_CONTROLS_UNREADABLE',
        });
      }
      throw policyErr;
    }
    if (!bulkReplyEnabled) {
      console.warn(
        JSON.stringify({
          event: 'bulk_pattern_reply_refused',
          code: 'BULK_REPLY_DISABLED',
          organization_id: organizationId,
        })
      );
      return res.status(403).json({
        error: 'Bulk reply is disabled for this organization',
        code: 'BULK_REPLY_DISABLED',
      });
    }

    const { data: pattern } = await supabase
      .from('response_patterns')
      .select('id, pattern_structure, pattern_category')
      .eq('id', patternId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!pattern) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    const structure = (pattern as { pattern_structure?: { blocks?: { type?: string; label?: string }[] } }).pattern_structure;
    const blocks = structure?.blocks ?? [];
    const templateStructure =
      blocks
        .map((b) => {
          const t = (b.type || 'answer').toLowerCase();
          const tag = TAG_SET.has(t) ? t : 'answer';
          const content = (b.label || '').trim() || ' ';
          return `<${tag}>${content}</${tag}>`;
        })
        .join('\n') || '<acknowledgement>Acknowledge the message</acknowledgement>\n<answer>Provide helpful info</answer>';

    const getReplyText = async (
      _threadId: string,
      messageId: string,
      platform: string
    ): Promise<string | null> => {
      const { data: msg } = await supabase
        .from('engagement_messages')
        .select('id, content, thread_id')
        .eq('organization_id', organizationId)
        .eq('id', messageId)
        .maybeSingle();
      if (!msg) return null;
      const result = await generateResponse({
        message_id: messageId,
        thread_id: (msg as { thread_id: string }).thread_id,
        organization_id: organizationId,
        platform,
        original_message: ((msg as { content?: string }).content ?? '').toString(),
        template_structure: templateStructure || 'greeting\nacknowledgement\nhelpful_info',
        tone: 'professional',
      });
      return result.text?.trim() ?? null;
    };

    const { sent, skipped, errors } = await bulkReplyThreads(
      organizationId,
      rawThreadIds.slice(0, MAX_BATCH),
      getReplyText,
      roleGate?.userId
    );

    return res.status(200).json({
      success: true,
      sent,
      skipped,
      errors: errors.slice(0, 5),
    });
  } catch (err) {
    const msg = (err as Error)?.message ?? 'Failed';
    console.error('[engagement/thread/bulk-pattern-reply]', msg);
    return res.status(500).json({ error: msg });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/engagement/thread/bulk-pattern-reply' });
