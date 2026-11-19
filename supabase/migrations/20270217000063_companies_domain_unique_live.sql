-- companies: ONE LIVE company per domain, enforced by the database (CI-309 merge precondition).
--
-- WHY. The owner's rule is one company per registrable domain. CI-309 makes onboarding match a company
-- only by the requester's verified email domain and treats several live companies on one domain as
-- unresolvable (409 COMPANY_DOMAIN_AMBIGUOUS, support-only exit). It relies on a UNIQUE index to turn two
-- CONCURRENT same-domain signups into one company plus a 23505 (which it answers with a join request).
-- Production has NO index of any kind on either column (cb's C120, 2026-11-19): the migrations that
-- declared them, 20260322_domain_credit_hardening and 20260713_auth001_signup_hardening, carry COLLIDED
-- versions and never ran. Without this, a concurrent signup creates a second company and the domain is
-- permanently locked behind the 409.
--
-- WHAT. Two partial UNIQUE indexes:
--   idx_companies_admin_email_domain_unique  ON companies (lower(admin_email_domain))
--   idx_companies_website_domain_unique      ON companies (lower(website_domain))
--   both WHERE deleted_at IS NULL AND <col> IS NOT NULL.
-- `deleted_at IS NULL`: a soft-deleted company no longer holds its domain (31 soft-deleted rows hold one
-- today), so a new customer can use it. CI-309's lookup excludes deleted rows too, so the database and
-- the app agree on what a "live" company is.
-- The NAMES are deliberately the ones the collided files declare: if either is ever replayed, its
-- `CREATE UNIQUE INDEX IF NOT EXISTS` finds this index and does nothing, so it can never install its
-- unscoped (deleted rows included) definition.
--
-- DESIGN LIMIT (recorded, not a defect). The database cannot evaluate the Public Suffix List, so it
-- enforces uniqueness on the STORED value. CI-309 makes every write store normalizeCompanyDomain()'s
-- registrable root (lower-case, no www., no subdomain), so two new companies on one domain store the same
-- value and collide here. A LEGACY row stored under a host ('mail.acme.com') would not collide with a
-- root ('acme.com'); the app's root-vs-root lookup sees both and answers 409. C120: 0 live values have
-- more than two labels, start with www., or carry upper case or a trailing dot, so no such row exists today.
-- lower() keeps the index honest against a mixed-case value written by any path outside the app's writer.
--
-- APPLY. A plain CREATE inside this file's transaction, not CONCURRENTLY (which cannot run in a
-- transaction): 9 live rows, so the lock is momentary.
--
-- PRECONDITION (refuses, never adopts): neither index name exists in any form, and no two live companies
-- share either value. A pre-existing index of that name, valid or not, scoped or not, is refused rather
-- than accepted by IF NOT EXISTS (an INVALID or unscoped index would pass a name check silently).
-- POSTCONDITION: both indexes exist, unique, valid, ready, on companies, with exactly this expression and
-- predicate.
-- ROLLBACK (rollbacks/companies_domain_unique_live_rollback.sql) drops only an index whose definition is
-- exactly this one: the precondition proved both names were absent before this apply.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  existing text;
  dup_admin integer;
  dup_site integer;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO existing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('idx_companies_admin_email_domain_unique', 'idx_companies_website_domain_unique');
  IF existing IS NOT NULL THEN
    RAISE EXCEPTION '20270217000063: index name(s) already exist (%); refusing to adopt an unknown definition', existing;
  END IF;

  SELECT count(*) INTO dup_admin FROM (
    SELECT lower(admin_email_domain) FROM public.companies
    WHERE deleted_at IS NULL AND admin_email_domain IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO dup_site FROM (
    SELECT lower(website_domain) FROM public.companies
    WHERE deleted_at IS NULL AND website_domain IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF dup_admin > 0 OR dup_site > 0 THEN
    RAISE EXCEPTION '20270217000063: % admin_email_domain and % website_domain value(s) are held by 2+ live companies; merge them before applying', dup_admin, dup_site;
  END IF;
END
$pre$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_admin_email_domain_unique
  ON public.companies (lower(admin_email_domain))
  WHERE deleted_at IS NULL AND admin_email_domain IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_website_domain_unique
  ON public.companies (lower(website_domain))
  WHERE deleted_at IS NULL AND website_domain IS NOT NULL;

DO $post$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname, i.indisunique, i.indisvalid, i.indisready, i.indrelid::regclass::text AS tbl,
           pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relname IN ('idx_companies_admin_email_domain_unique', 'idx_companies_website_domain_unique')
  LOOP
    n := n + 1;
    IF NOT (r.indisunique AND r.indisvalid AND r.indisready) OR r.tbl <> 'companies' THEN
      RAISE EXCEPTION '20270217000063: % is not a valid unique index on companies (unique %, valid %, ready %, table %)',
        r.relname, r.indisunique, r.indisvalid, r.indisready, r.tbl;
    END IF;
    IF r.relname = 'idx_companies_admin_email_domain_unique'
       AND substring(r.def from ' ON .*$') <> ' ON public.companies USING btree (lower(admin_email_domain)) WHERE ((deleted_at IS NULL) AND (admin_email_domain IS NOT NULL))' THEN
      RAISE EXCEPTION '20270217000063: unexpected definition %', r.def;
    END IF;
    IF r.relname = 'idx_companies_website_domain_unique'
       AND substring(r.def from ' ON .*$') <> ' ON public.companies USING btree (lower(website_domain)) WHERE ((deleted_at IS NULL) AND (website_domain IS NOT NULL))' THEN
      RAISE EXCEPTION '20270217000063: unexpected definition %', r.def;
    END IF;
  END LOOP;
  IF n <> 2 THEN
    RAISE EXCEPTION '20270217000063: expected 2 indexes, found %', n;
  END IF;
END
$post$;

COMMIT;
