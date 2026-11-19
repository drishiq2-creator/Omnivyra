-- Rollback for 20270217000063_companies_domain_unique_live.
--
-- The apply's precondition proved BOTH index names were absent before it ran (it refuses otherwise), so
-- an index of that name with exactly the apply's definition was created by the apply and may be dropped.
-- An index of that name with ANY other definition was not created by this migration (e.g. a collided
-- 20260322/20260713 file replayed after a manual drop): it is left alone and the rollback refuses, so it
-- never removes a guard it did not install.
--
-- Effect of rolling back: concurrent same-domain signups can again create two live companies, after which
-- CI-309's lookup answers that domain 409 COMPANY_DOMAIN_AMBIGUOUS. Roll back CI-309 first if the goal is
-- to restore the pre-CI-309 behaviour.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $rb$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relname IN ('idx_companies_admin_email_domain_unique', 'idx_companies_website_domain_unique')
  LOOP
    IF NOT (r.def LIKE 'CREATE UNIQUE %') OR substring(r.def from ' ON .*$') NOT IN (
      ' ON public.companies USING btree (lower(admin_email_domain)) WHERE ((deleted_at IS NULL) AND (admin_email_domain IS NOT NULL))',
      ' ON public.companies USING btree (lower(website_domain)) WHERE ((deleted_at IS NULL) AND (website_domain IS NOT NULL))'
    ) THEN
      RAISE EXCEPTION 'rollback 20270217000063: % has a definition this migration did not create (%); refusing to drop it', r.relname, r.def;
    END IF;
  END LOOP;
END
$rb$;

DROP INDEX IF EXISTS public.idx_companies_admin_email_domain_unique;
DROP INDEX IF EXISTS public.idx_companies_website_domain_unique;

COMMIT;
