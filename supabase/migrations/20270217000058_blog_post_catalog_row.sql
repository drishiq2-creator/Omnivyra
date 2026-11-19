-- 20270217000058 - blog_post catalog row (c6, was e1; OWNER ruling 2026-11-18 via b3; version from virality-cb;
-- review: virality-7c).
--
-- THE RULING. A blog is a FIXED 40 credits, rate-independent, on both blog routes (company /api/blogs/generate and
-- super-admin /api/admin/blog/generate), held before any AI call and settled by backend/services/blog/blogBilling.ts
-- (success 40; quality-gate refusal refunded in full; a stopped run min(40, ceil(40 x provider calls / 32))).
--
-- credit_cost_config 'blog_post' = 40: the catalog / preview source (fixed-fee path of resolveActivityCreditRange,
-- read by GET /api/billing/activity-cost-range) and getCreditCost's answer. The routes hold with amountOverride 40.
-- Deliberately NO action_pricing_config row - an active apc row would make resolveActivityCreditRange treat the key as
-- token-priced at the org's rate (the F3 defect); the postcondition pins that absence (so the key is absent from
-- public.v_pricing_catalog - expected; do not "fix" that with an apc row).
-- The existing blog_generation key is untouched: the routes no longer use it, so it can never charge a blog run twice.
--
-- No table is created; no GRANT changes. Rollback: rollbacks/blog_post_catalog_row_rollback.sql.

INSERT INTO public.credit_cost_config (action_type, credits, category, description, smart_dedup_seconds, activity_class)
VALUES ('blog_post', 40, 'heavy', 'Blog post, fixed per blog (20270217000058)', 0, 'LONG_GENERATION')
ON CONFLICT (action_type) DO NOTHING;

DO $m058_post$
BEGIN
  IF (SELECT count(*) FROM public.credit_cost_config
       WHERE action_type = 'blog_post' AND credits = 40 AND category = 'heavy' AND smart_dedup_seconds = 0
         AND activity_class = 'LONG_GENERATION' AND description = 'Blog post, fixed per blog (20270217000058)') <> 1 THEN
    RAISE EXCEPTION '058 postcondition: credit_cost_config blog_post is not exactly the ruled row (40 credits)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.action_pricing_config WHERE action_key = 'blog_post' AND is_active) THEN
    RAISE EXCEPTION '058 postcondition: an active action_pricing_config row for blog_post would make the preview token-priced';
  END IF;
END
$m058_post$;
