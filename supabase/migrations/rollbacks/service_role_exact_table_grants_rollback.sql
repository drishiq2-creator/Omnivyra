-- Rollback for 20270218000000_service_role_exact_table_grants.sql.
--
-- Restores the PRODUCTION PRE-IMAGE (C163, 2026-11-21): service_role held ALL on these five tables
-- through Supabase's default ACL. A rollback restores what was applied, never something narrower or
-- different. Restoring it re-opens DELETE and TRUNCATE for service_role, which is the defect the
-- forward migration closed: run this only to undo a forward apply that broke a code path, and say so.

BEGIN;

GRANT ALL ON TABLE public.extension_account_bindings TO service_role;
GRANT ALL ON TABLE public.contact_opt_out_reviews TO service_role;
GRANT ALL ON TABLE public.contact_opt_out_review_activity_days TO service_role;
GRANT ALL ON TABLE public.contact_opt_out_review_reanchors TO service_role;
GRANT ALL ON TABLE public.execution_journey_decisions TO service_role;

COMMIT;
