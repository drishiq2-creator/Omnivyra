-- 20270217000060 - guarantee the 'blog_generation' kill-switch row (c6; b3 ruling 2026-11-18 adopting 7c's proposal;
-- version from virality-cb; review: virality-7c).
--
-- WHY. Both blog routes are gated by super-admin activity control 'Blog Create' = intelligence_global_config
-- job_type 'blog_generation' (backend/services/blog/blogBilling.ts blogGenerationRefusal). With this row GUARANTEED,
-- the routes FAIL CLOSED when it is absent - so deleting the row is a usable incident switch, and "absent" can no
-- longer mean "allowed by accident". cb C112: prod has exactly one row (enabled = true), so this inserts nothing there;
-- it is a guarantee (and a postcondition), not a prerequisite. Apply before the blog code deploys.
--
-- Values: the tracked seed (20260328_intelligence_orchestration.sql; re-seeded by 20261024000001). updated_by marks a
-- row THIS migration inserted, so the rollback can remove only that. No table, no GRANT change.
-- Rollback: rollbacks/blog_generation_kill_switch_row_rollback.sql.

INSERT INTO public.intelligence_global_config
  (job_type, label, description, priority, frequency_minutes, enabled, max_concurrent, timeout_seconds, retry_count, updated_by)
VALUES
  ('blog_generation', 'Blog Generation', 'AI-powered blog post generation from strategic theme', 9, 1440, true, 1, 120, 1,
   'migration:20270217000060')
ON CONFLICT (job_type) DO NOTHING;

DO $m060_post$
BEGIN
  IF (SELECT count(*) FROM public.intelligence_global_config WHERE job_type = 'blog_generation') <> 1 THEN
    RAISE EXCEPTION '060 postcondition: intelligence_global_config must have exactly one blog_generation row';
  END IF;
END
$m060_post$;
