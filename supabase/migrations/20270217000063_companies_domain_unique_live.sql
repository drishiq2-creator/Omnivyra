-- companies: ONE LIVE company per WEBSITE domain, enforced by the database (CI-309 merge precondition).
--
-- RULING (owner, 2026-11-19). A company's identity is its WEBSITE domain (the registrable root). There is
-- ONE live company per registrable website domain. Several companies MAY share an ADMIN EMAIL domain: the
-- owner runs two such companies. Example (synthetic): company A (website alpha.test, admin a@shared.test)
-- and company B (website beta.test, admin b@shared.test) - two live companies whose admin_email_domain is
-- the same shared.test.
-- So admin_email_domain is a stored attribute, never an identity key, and must NEVER carry a UNIQUE index.
--
-- WHY. CI-309 makes onboarding match a company only by the requester's verified email root against the
-- company's website_domain, and treats several live companies on one website domain as unresolvable (409
-- COMPANY_DOMAIN_AMBIGUOUS, support-only exit). It relies on a UNIQUE index to turn two CONCURRENT
-- same-domain signups into one company plus a 23505 (which it answers with a join request); every
-- self-signup insert stamps website_domain (= the email root under the ruling), so the race always reaches
-- this index. Production has NO index of any kind on either column (cb's C120, 2026-11-19): the migrations
-- that declared them, 20260322_domain_credit_hardening and 20260713_auth001_signup_hardening, carry
-- COLLIDED versions and never ran. Without this, a concurrent signup creates a second company and the
-- domain is permanently locked behind the 409.
--
-- THE COLLIDED 20260322 FILE MUST NEVER BE APPLIED. It declares an UNSCOPED unique index on
-- admin_email_domain (idx_companies_admin_email_domain_unique, deleted rows included). Its replay would
-- refuse the second of two companies administered from one email domain (B beside A). This migration
-- guards against it both ways:
--   - it DROPS an index of exactly that name if one exists (C120: absent in prod, so a no-op there);
--   - it REFUSES (raises) if any OTHER unique index on companies covers admin_email_domain (detected by
--     pg_index key columns and indexed expressions, whatever its name): an object this file cannot
--     identify is never dropped blind;
--   - its postcondition asserts that NO unique index on companies covers admin_email_domain.
-- The 20260713 file's website index uses the SAME name as ours (idx_companies_website_domain_unique), so a
-- replay of it after this apply finds the name and does nothing.
--
-- WHAT. One partial UNIQUE index:
--   idx_companies_website_domain_unique ON companies (lower(website_domain))
--   WHERE deleted_at IS NULL AND website_domain IS NOT NULL.
-- `deleted_at IS NULL`: a soft-deleted company no longer holds its domain (31 soft-deleted rows hold one
-- today), so a new customer can use it. CI-309's lookup excludes deleted rows too, so the database and
-- the app agree on what a "live" company is.
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
-- PRECONDITION (refuses, never adopts): the website index name does not exist in any form (valid or not,
-- scoped or not: IF NOT EXISTS would silently accept an unknown definition), no two live companies share
-- a website_domain, and no unique index on companies other than the collided 20260322 name covers
-- admin_email_domain.
-- POSTCONDITION: exactly ONE index of ours exists (unique, valid, ready, on companies, with exactly this
-- expression and predicate), and NO unique index on companies covers admin_email_domain.
-- ROLLBACK (rollbacks/companies_domain_unique_live_rollback.sql) drops only the website index, only when its
-- definition is exactly this one; it never recreates an admin_email_domain index (the ruling forbids one).

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  existing text;
  dup_site integer;
  unknown_admin text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO existing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'idx_companies_website_domain_unique';
  IF existing IS NOT NULL THEN
    RAISE EXCEPTION '20270217000063: index name(s) already exist (%); refusing to adopt an unknown definition', existing;
  END IF;

  SELECT count(*) INTO dup_site FROM (
    SELECT lower(website_domain) FROM public.companies
    WHERE deleted_at IS NULL AND website_domain IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF dup_site > 0 THEN
    RAISE EXCEPTION '20270217000063: % website_domain value(s) are held by 2+ live companies; merge them before applying', dup_site;
  END IF;

  -- A unique index covering admin_email_domain (as a key column or inside an indexed expression), under
  -- any name except the collided 20260322 one this file drops below.
  SELECT string_agg(c.relname, ', ') INTO unknown_admin
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'public.companies'::regclass
    AND i.indisunique
    AND c.relname <> 'idx_companies_admin_email_domain_unique'
    AND (
      EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = i.indrelid AND a.attname = 'admin_email_domain' AND a.attnum = ANY (i.indkey::int2[])
      )
      OR coalesce(pg_get_expr(i.indexprs, i.indrelid), '') ~ '\madmin_email_domain\M'
    );
  IF unknown_admin IS NOT NULL THEN
    RAISE EXCEPTION '20270217000063: unique index(es) % cover admin_email_domain; the ruling forbids one, and this migration will not drop an object it cannot identify', unknown_admin;
  END IF;
END
$pre$;

-- The collided 20260322 declaration (UNIQUE on admin_email_domain): forbidden by the ruling.
DROP INDEX IF EXISTS public.idx_companies_admin_email_domain_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_website_domain_unique
  ON public.companies (lower(website_domain))
  WHERE deleted_at IS NULL AND website_domain IS NOT NULL;

DO $post$
DECLARE
  r record;
  n integer := 0;
  admin_unique text;
BEGIN
  FOR r IN
    SELECT c.relname, i.indisunique, i.indisvalid, i.indisready, i.indrelid::regclass::text AS tbl,
           pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relname = 'idx_companies_website_domain_unique'
  LOOP
    n := n + 1;
    IF NOT (r.indisunique AND r.indisvalid AND r.indisready) OR r.tbl <> 'companies' THEN
      RAISE EXCEPTION '20270217000063: % is not a valid unique index on companies (unique %, valid %, ready %, table %)',
        r.relname, r.indisunique, r.indisvalid, r.indisready, r.tbl;
    END IF;
    IF substring(r.def from ' ON .*$') <> ' ON public.companies USING btree (lower(website_domain)) WHERE ((deleted_at IS NULL) AND (website_domain IS NOT NULL))' THEN
      RAISE EXCEPTION '20270217000063: unexpected definition %', r.def;
    END IF;
  END LOOP;
  IF n <> 1 THEN
    RAISE EXCEPTION '20270217000063: expected 1 index, found %', n;
  END IF;

  SELECT string_agg(c.relname, ', ') INTO admin_unique
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'public.companies'::regclass
    AND i.indisunique
    AND (
      EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = i.indrelid AND a.attname = 'admin_email_domain' AND a.attnum = ANY (i.indkey::int2[])
      )
      OR coalesce(pg_get_expr(i.indexprs, i.indrelid), '') ~ '\madmin_email_domain\M'
    );
  IF admin_unique IS NOT NULL THEN
    RAISE EXCEPTION '20270217000063: unique index(es) % cover admin_email_domain; companies may share an admin email domain', admin_unique;
  END IF;
END
$post$;

COMMIT;
