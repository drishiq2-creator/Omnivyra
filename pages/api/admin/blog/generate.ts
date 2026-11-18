import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';
/**
 * POST /api/admin/blog/generate
 *
 * Super Admin blog generation (public_blogs table).
 *
 * This route is responsible for:
 *   1. Auth: SUPER_ADMIN role only
 *   2. Calling runUnifiedLongFormGeneration()
 *   3. Returning the result
 *
 * ALL generation logic lives in lib/blog/runBlogGeneration.ts.
 * Zero generation logic is permitted in this file.
 *
 * Company Admin uses /api/blogs/generate (blogs table, COMPANY_ADMIN role).
 *
 * Body:
 * {
 *   company_id:       string,
 *   mode?:            'angles' | 'full',
 *   topic:            string,
 *   cluster?:         string,
 *   intent?:          string,
 *   related_blogs?:   string[],
 *   series_blog_ids?: string[],
 *   series_context?:  string,
 *   answers?:         Record<string, string>,
 *   selected_angle?:  BlogAngle,
 *   tone?:            string,
 *   goal_type?:       string,
 * }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { enforceCompanyAccess } from '../../../../backend/services/userContextService';
import { enforceRole, Role } from '../../../../backend/services/rbacService';
import type { BlogGenerationRequest } from '../../../../lib/blog/runBlogGeneration';
import { runUnifiedLongFormGeneration } from '../../../../lib/content/unifiedLongFormEngine';
import type { BlogAngle } from '../../../../lib/blog/blogGenerationEngine';
import { buildContentContext } from '../../../../lib/content/buildContentContext';
import { isValidBlogFormat } from '../../../../lib/blog/blogStructureTemplates';
import { blogBillingOf, blogReferenceId, holdBlog, isBlogHoldRefusal, runBlogWithBilling } from '../../../../backend/services/blog/blogBilling';
import { ThoughtLeadershipQualityGateError } from '../../../../backend/services/longForm/thoughtLeadershipQualityGate';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    company_id,
    mode,
    topic,
    cluster,
    intent,
    related_blogs,
    series_blog_ids,
    series_context,
    answers,
    selected_angle,
    tone,
    goal_type,
    format_type,
  } = req.body ?? {};

  if (!company_id || typeof company_id !== 'string')
    return res.status(400).json({ error: 'company_id required' });
  if (!topic || typeof topic !== 'string' || !topic.trim())
    return res.status(400).json({ error: 'topic required' });

  // ── 1. Auth ─────────────────────────────────────────────────────────────────
  const access = await enforceCompanyAccess({ req, res, companyId: company_id });
  if (!access) return;

  const roleGate = await enforceRole({
    req, res, companyId: company_id,
    allowedRoles: [Role.SUPER_ADMIN],
    // Company Admin uses /api/blogs/generate — not this route.
  });
  if (!roleGate) return;

  const generationRequest: BlogGenerationRequest = {
    company_id,
    mode:             mode === 'angles' ? 'angles' : 'full',
    topic:            String(topic).trim(),
    cluster:          typeof cluster        === 'string' ? cluster.trim()        : undefined,
    intent:           typeof intent         === 'string' ? intent.trim()         : undefined,
    related_blogs:    Array.isArray(related_blogs)
      ? related_blogs.filter((b: unknown) => typeof b === 'string')
      : undefined,
    series_blog_ids:  Array.isArray(series_blog_ids)
      ? series_blog_ids.filter((id: unknown) => typeof id === 'string')
      : undefined,
    series_context:   typeof series_context === 'string' ? series_context.trim() : undefined,
    answers:          answers && typeof answers === 'object' ? answers as Record<string, string> : undefined,
    selected_angle:   selected_angle as BlogAngle | undefined,
    tone:             typeof tone      === 'string' ? tone.trim()      : undefined,
    goal_type:        typeof goal_type === 'string' ? goal_type.trim() : undefined,
    blogTable:        'public_blogs',  // Super Admin always uses public_blogs
    formatType:       isValidBlogFormat(format_type) ? format_type : 'standard',
  };

  try {
    generationRequest.companyContext = (await buildContentContext(company_id)).companyContext;
  } catch {
    // Profile context enrichment is best-effort and must not block generation.
  }

  // ── 2. Generate - OWNER 2026-11-18: a blog is a FIXED 40 credits (backend/services/blog/blogBilling) ─────────────
  // Replaces the former phase-2 route wiring for blog_generation: ONE blog = ONE hold, so the blog_generation pricing row can never
  // charge the same run a second time. Held BEFORE any AI call; a refusal writes nothing. 'angles' is not a blog and is
  // not billed as one. Every AI call carries the blog's reference id (b3: measure the real cost per blog).
  const runGeneration = (correlation?: { referenceType: string; referenceId: string; parentActivityId: null }) =>
    runUnifiedLongFormGeneration({
      ...generationRequest,
      contentType: 'blog',
      formatType: typeof generationRequest.formatType === 'string' ? generationRequest.formatType : undefined,
      templateBlocks: generationRequest.template_blocks,
      targetWordCount: generationRequest.answers?.target_word_count
        ? Number.parseInt(String(generationRequest.answers.target_word_count), 10) || undefined
        : generationRequest.target_words,
      ...(correlation ? { correlation } : {}),
    });

  try {
    if (generationRequest.mode === 'angles') {
      return res.status(200).json(await runGeneration());
    }
    const referenceId = blogReferenceId(req.headers['idempotency-key']);
    const hold = await holdBlog({ orgId: company_id, userId: roleGate.userId, referenceId, validateMembership: false });
    if (isBlogHoldRefusal(hold)) {
      const { status, ...refusal } = hold;
      return res.status(status).json(refusal);
    }
    const { result, billing } = await runBlogWithBilling({
      reservation: hold.reservation,
      run: () => runGeneration({ referenceType: 'blog_post', referenceId, parentActivityId: null }),
      isQualityGateRefusal: (e) => e instanceof ThoughtLeadershipQualityGateError,
    });
    return res.status(200).json({ ...(result as object), billing });
  } catch (err) {
    // Enterprise quality gate: failed blog drafts are blocked instead of
    // being returned as usable generation output (owner: refunded in full).
    if (err instanceof ThoughtLeadershipQualityGateError) {
      return res.status(422).json({
        error: err.message,
        quality_passed: false,
        thought_leadership_quality: err.report,
        ...(blogBillingOf(err) ? { billing: blogBillingOf(err) } : {}),
      });
    }
    throw err;
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/admin/blog/generate' });
