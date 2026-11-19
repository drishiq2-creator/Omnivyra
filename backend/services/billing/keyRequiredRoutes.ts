/**
 * The routes (and, where a route multiplexes, the request values) that REQUIRE the client's Idempotency-Key - the
 * server-side SOURCE OF TRUTH for the double-charge contract (b3 2026-11-18; 04's client contract test derives its
 * route list from here, never from a hand-typed list).
 *
 * It cannot drift: every server site that refuses a missing key names its surface FROM this registry
 * (KEY_REQUIRED_SURFACE.*), and pin tests on the implementing branches assert (a) every registry surface is used by a
 * refusing site and (b) every refusing site uses a registry surface.
 *
 * Not listed (by design): the wirePhase2Route routes and the assist routes - they ACCEPT a key (and replay with it)
 * but fall back to a per-request / content-derived identity, so a call without one is not refused.
 */
export const KEY_REQUIRED_SURFACE = {
  generateMaster:   'activity-workspace.generate_master',
  generateVariants: 'activity-workspace.generate_variants',
  refineVariant:    'activity-workspace.refine_variant',
  companyBlog:      'blogs.generate',
  platformBlog:     'admin.blog.generate',
} as const;

export type KeyRequiredSurface = (typeof KEY_REQUIRED_SURFACE)[keyof typeof KEY_REQUIRED_SURFACE];

/**
 * Route -> the request field that selects the billed action, and the values of it that require the key.
 * `values: '*except'` lists the values that do NOT require it (everything else does).
 */
export const KEY_REQUIRED_ROUTES: ReadonlyArray<{
  route: string;
  field: 'action' | 'mode';
  values: readonly string[] | { except: readonly string[] };
  surfaces: readonly KeyRequiredSurface[];
}> = [
  // refine_variant requires it on its BILLED path (isRefineVariantBillingEnabled); clients send it always.
  { route: '/api/activity-workspace/content', field: 'action', values: ['generate_master', 'generate_variants', 'refine_variant'],
    surfaces: [KEY_REQUIRED_SURFACE.generateMaster, KEY_REQUIRED_SURFACE.generateVariants, KEY_REQUIRED_SURFACE.refineVariant] },
  // Company blog: mode 'full' is billed (40, key required); 'angles' is free; any other mode is 400 BLOG_MODE_REQUIRED.
  { route: '/api/blogs/generate', field: 'mode', values: ['full'], surfaces: [KEY_REQUIRED_SURFACE.companyBlog] },
  // Omnivyra's own public blog: platform spend, but the key still dedups (b3 4a); every mode except 'angles'.
  { route: '/api/admin/blog/generate', field: 'mode', values: { except: ['angles'] }, surfaces: [KEY_REQUIRED_SURFACE.platformBlog] },
];

/**
 * Routes that ACCEPT the client's Idempotency-Key (and replay a lost response with it) but do NOT require it - without
 * a key they fall back to a per-request id (wirePhase2Route: a retry is a NEW request and a new charge) or a content
 * hash (the assist routes: an identical re-ask replays). For these, lost-response protection exists ONLY if the client
 * sends a key, so "accepted but unsent" is the residual exposure 04 tracks from this list (7c 2026-11-18).
 * Exact-set pinned on the engagement-replies branch against the code (the wirePhase2Route callers + the assist routes
 * that opt out with requireClientKey: false).
 */
export const KEY_ACCEPTED_ROUTES: ReadonlyArray<{ route: string; fallback: 'per-request' | 'content-hash' }> = [
  // wirePhase2Route callers (fallback: the per-request id)
  { route: '/api/admin/blog/brief-suggestions', fallback: 'per-request' },
  { route: '/api/admin/blog/rewrite-hook', fallback: 'per-request' },
  { route: '/api/ai/content-suggestions', fallback: 'per-request' },
  { route: '/api/blogs/[id]/repurpose', fallback: 'per-request' },
  { route: '/api/bolt/campaign-chat', fallback: 'per-request' },
  { route: '/api/campaigns/planner/suggest-update', fallback: 'per-request' },
  { route: '/api/campaigns/run-preplanning', fallback: 'per-request' },
  { route: '/api/campaigns/suggest-duration', fallback: 'per-request' },
  { route: '/api/campaigns/[id]/virality/assess', fallback: 'per-request' },
  { route: '/api/company/blog/brief-suggestions', fallback: 'per-request' },
  { route: '/api/content/quick-platform-adapt', fallback: 'per-request' },
  { route: '/api/engagement/refine-suggestion', fallback: 'per-request' },
  { route: '/api/engagement/suggestions', fallback: 'per-request' },
  { route: '/api/engagement/thread/bulk-ai-reply', fallback: 'per-request' },
  { route: '/api/planner/chat-themes', fallback: 'per-request' },
  { route: '/api/planner/skeleton-command', fallback: 'per-request' },
  { route: '/api/recommendations/detected-opportunities', fallback: 'per-request' },
  { route: '/api/recommendations/generate', fallback: 'per-request' },
  { route: '/api/recommendations/group-preview', fallback: 'per-request' },
  { route: '/api/recommendations/[id]/preview-strategy', fallback: 'per-request' },
  // the assist routes (runBilledAiCompletion recovery, requireClientKey: false; fallback: the request's content hash)
  { route: '/api/campaign-content/assist', fallback: 'content-hash' },
  { route: '/api/creator-templates/field-assist', fallback: 'content-hash' },
  { route: '/api/creator-templates/chat-brief', fallback: 'content-hash' },
];
