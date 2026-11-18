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
