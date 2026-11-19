-- Rollback for 20270217000063_companies_domain_unique_live.
--
-- Drops ONLY the website index, and only when its definition is exactly the apply's. The apply's
-- precondition proved the name was absent before it ran (it refuses otherwise), so an index of that name
-- with exactly that definition was created by the apply. An index of that name with ANY other definition
-- was not (e.g. the collided 20260713 file replayed after a manual drop): it is left alone and the rollback
-- refuses, so it never removes a guard it did not install.
--
-- It NEVER recreates an admin_email_domain index. The apply may have dropped the collided 20260322
-- idx_companies_admin_email_domain_unique (C120: absent in prod, so in practice nothing was dropped);
-- restoring it is forbidden by the owner's ruling (2026-11-19): several companies may share an admin
-- email domain, and a unique index on it would refuse a second company administered from the same email domain.
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
      AND c.relname = 'idx_companies_website_domain_unique'
  LOOP
    IF NOT (r.def LIKE 'CREATE UNIQUE %') OR substring(r.def from ' ON .*$') <>
      ' ON public.companies USING btree (lower(website_domain)) WHERE ((deleted_at IS NULL) AND (website_domain IS NOT NULL))' THEN
      RAISE EXCEPTION 'rollback 20270217000063: % has a definition this migration did not create (%); refusing to drop it', r.relname, r.def;
    END IF;
  END LOOP;
END
$rb$;

DROP INDEX IF EXISTS public.idx_companies_website_domain_unique;

COMMIT;
