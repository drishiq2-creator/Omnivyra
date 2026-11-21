-- 20270217000073 salesnav_extraction_runs (reserved by cb, registry f8a39c668)
--
-- Sales Navigator SHARED CONTRACT v2.2 storage (c6 owns the contract; owner rulings 2026-11-20/21; b3 ruling (A)
-- 2026-11-21). Three objects, written ONLY by the server-side contract implementation (backend/services/salesNav);
-- route owners (extension a9, RPA 89, API vendors c6) CALL the contract and never write these tables.
--
--   salesnav_member_owner     ONE company per LinkedIn member (b3 ruling A: "each company uses its own account").
--                             member_id is the PRIMARY KEY, so connecting the same LinkedIn account in a second
--                             company fails on the key - the server maps that to a clear refusal. This is what makes
--                             the shared daily cap (074, keyed on the member alone) mean "per LinkedIn account".
--   salesnav_member_bindings  which member each USER of a company uses per transport (a9's extension model: one
--                             active member per (company, user, platform); a different member is refused by the
--                             writer, 409 account_binding_conflict). Opaque canonical id only, no name. It can only
--                             name a member the SAME company owns (composite FK to the owner row). Several users of
--                             one company may each bind their own seat.
--   salesnav_extraction_runs  one row per extraction run: list URL (canonical, allowlisted), closed status set with
--                             its closed code set (the (status, code) pairs are a CHECK, mirrored by a unit parity
--                             test against contract.ts), next page, list total, counts, and the SEEN LEAD KEYS (keys
--                             only - never names or profile text) for the page_repeated backstop across resumed days.
--                             At most ONE non-terminal run per member (partial unique index): a paused run blocks a
--                             new one until it is resumed or cancelled, so two runs can never compete for one cap.
--
-- member_id everywhere is the CANONICAL LinkedIn profile id (contract canonicalMemberId: the ACoAA... id), enforced
-- by CHECK. No person data is stored in any of the three tables.
--
-- This version: never applied anywhere. RLS on, zero client grants, service_role only.
-- Apply is its own owner ask, after the LinkedIn legal review clears the transport (PL-170 preconditions).

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.companies') IS NULL THEN
    RAISE EXCEPTION 'SNR preflight: public.companies is missing - there is no tenant to scope runs to';
  END IF;
  IF to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION 'SNR preflight: auth.role() is missing - the house service_role policy cannot be expressed';
  END IF;
  IF to_regprocedure('gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'SNR preflight: gen_random_uuid() is missing';
  END IF;
END
$preflight$;

-- 1. ONE company per LinkedIn member -------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.salesnav_member_owner (
  member_id       text        NOT NULL
    CONSTRAINT salesnav_member_owner_member_canonical CHECK (member_id ~ '^ACoAA[A-Za-z0-9_-]{10,80}$'),
  organization_id uuid        NOT NULL
    CONSTRAINT salesnav_member_owner_org_fk REFERENCES public.companies (id) ON DELETE CASCADE,
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salesnav_member_owner_pkey PRIMARY KEY (member_id),
  -- the composite FK target for bindings (a binding may only name a member its own company owns)
  CONSTRAINT salesnav_member_owner_member_org_key UNIQUE (member_id, organization_id)
);

COMMENT ON TABLE public.salesnav_member_owner IS
  'Sales Navigator: the ONE company that owns each canonical LinkedIn member (b3 ruling A, 2026-11-21). member_id is '
  'the primary key, so a second company cannot claim the same account. Opaque id only.';

-- 2. the company's member per transport ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.salesnav_member_bindings (
  organization_id uuid        NOT NULL
    CONSTRAINT salesnav_member_bindings_org_fk REFERENCES public.companies (id) ON DELETE CASCADE,
  transport       text        NOT NULL
    CONSTRAINT salesnav_member_bindings_transport CHECK (transport IN ('extension', 'unipile', 'vayne', 'rpa')),
  member_id       text        NOT NULL
    CONSTRAINT salesnav_member_bindings_member_canonical CHECK (member_id ~ '^ACoAA[A-Za-z0-9_-]{10,80}$'),
  -- the Omnivyra user who bound it (validated by the writer; no FK into users, like extension_account_bindings)
  user_id         uuid        NOT NULL,
  bound_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salesnav_member_bindings_pkey PRIMARY KEY (organization_id, user_id, transport),
  CONSTRAINT salesnav_member_bindings_owner_fk FOREIGN KEY (member_id, organization_id)
    REFERENCES public.salesnav_member_owner (member_id, organization_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.salesnav_member_bindings IS
  'Sales Navigator: which canonical LinkedIn member each user of a company uses per transport (one per user + '
  'transport). Can only name a member the same company owns (FK to salesnav_member_owner). Opaque id only, no name.';

-- 3. extraction runs -----------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.salesnav_extraction_runs (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid()
    CONSTRAINT salesnav_extraction_runs_pkey PRIMARY KEY,
  organization_id    uuid        NOT NULL
    CONSTRAINT salesnav_extraction_runs_org_fk REFERENCES public.companies (id) ON DELETE CASCADE,
  transport          text        NOT NULL
    CONSTRAINT salesnav_extraction_runs_transport CHECK (transport IN ('extension', 'unipile', 'vayne', 'rpa')),
  -- no FK to the owner row: a disconnect must not delete run history. The CHECK keeps it opaque.
  member_id          text        NOT NULL
    CONSTRAINT salesnav_extraction_runs_member_canonical CHECK (member_id ~ '^ACoAA[A-Za-z0-9_-]{10,80}$'),
  url_kind           text        NOT NULL
    CONSTRAINT salesnav_extraction_runs_url_kind CHECK (url_kind IN ('people_search', 'lead_list', 'saved_search')),
  canonical_url      text        NOT NULL
    CONSTRAINT salesnav_extraction_runs_canonical_url CHECK (
      canonical_url LIKE 'https://www.linkedin.com/sales/%' AND length(canonical_url) <= 4000),
  status             text        NOT NULL DEFAULT 'running',
  status_code        text        NULL,
  -- the contract's closed (status, code) sets - mirrored by salesNavRunsMigrationParity.test.ts against contract.ts
  CONSTRAINT salesnav_extraction_runs_status_code CHECK (
       (status IN ('queued', 'running') AND status_code IS NULL)
    OR (status = 'paused_daily_cap' AND status_code = 'daily_cap')
    OR (status = 'auth_expired'     AND status_code IN ('logged_out', 'checkpoint'))
    OR (status = 'completed'        AND status_code IN ('no_next_page', 'empty_first_page'))
    OR (status = 'rate_limited'     AND status_code IN ('site_rate_limit', 'vendor_rate_limit'))
    OR (status = 'refused'          AND status_code IN ('gate_closed', 'url_not_allowed', 'member_unresolved',
                                                        'member_mismatch', 'quota_unreadable',
                                                        'reader_version_unsupported'))
    OR (status = 'failed'           AND status_code IN ('dom_changed', 'vendor_error', 'transport_error', 'internal_error'))
    OR (status = 'cancelled'        AND status_code = 'user_cancelled')
    OR (status = 'unknown'          AND status_code IN ('page_unconfirmed', 'structure_unrecognised',
                                                        'next_page_unreadable', 'page_position_mismatch',
                                                        'page_repeated', 'run_stale', 'response_lost'))
  ),
  next_page_index    integer     NOT NULL DEFAULT 0
    CONSTRAINT salesnav_extraction_runs_next_page CHECK (next_page_index BETWEEN 0 AND 1000),
  -- API transports (unipile / vayne) page by the vendor's OPAQUE cursor, not by URL: a paused run resumes from it.
  -- Browser transports (extension / rpa) leave it NULL and page by next_page_index (contract pageUrlFor).
  vendor_cursor      text        NULL
    CONSTRAINT salesnav_extraction_runs_vendor_cursor CHECK (
      vendor_cursor IS NULL OR (transport IN ('unipile', 'vayne') AND length(vendor_cursor) <= 2000)),
  -- b3/owner 2026-11-21, the "Omnivyra connector" HANDOFF: the browser route that currently HOLDS the run. The
  -- extension reads while the user's browser is online; Playwright continues from the SAME server-held position
  -- otherwise. API-transport runs have no holder (NULL).
  active_route       text        NULL,
  CONSTRAINT salesnav_extraction_runs_active_route CHECK (
    (transport IN ('extension', 'rpa')) = (active_route IS NOT NULL)
    AND (active_route IS NULL OR active_route IN ('extension', 'rpa'))),
  -- The cap RESERVED (POST /runs/:id/next) for the page the route is about to read: POST /pages ingests at most
  -- pending_granted leads of exactly pending_page_index. Both NULL when no page is outstanding.
  pending_page_index integer     NULL,
  pending_granted    integer     NULL,
  CONSTRAINT salesnav_extraction_runs_pending CHECK (
    (pending_page_index IS NULL) = (pending_granted IS NULL)
    AND (pending_granted IS NULL OR pending_granted BETWEEN 0 AND 25)
    AND (pending_page_index IS NULL OR pending_page_index = next_page_index)),
  list_total         integer     NULL
    CONSTRAINT salesnav_extraction_runs_list_total CHECK (list_total IS NULL OR list_total >= 0),
  total_unreliable   boolean     NOT NULL DEFAULT false,
  last_has_next_page boolean     NULL,
  pages_read         integer     NOT NULL DEFAULT 0,
  leads_read         integer     NOT NULL DEFAULT 0,
  accepted           integer     NOT NULL DEFAULT 0,
  rejected           integer     NOT NULL DEFAULT 0,
  created_count      integer     NOT NULL DEFAULT 0,
  updated_count      integer     NOT NULL DEFAULT 0,
  held_for_review    integer     NOT NULL DEFAULT 0,
  skipped_duplicates integer     NOT NULL DEFAULT 0,
  dropped            integer     NOT NULL DEFAULT 0,
  quota_refused      integer     NOT NULL DEFAULT 0,
  CONSTRAINT salesnav_extraction_runs_counts_nonneg CHECK (
    pages_read >= 0 AND leads_read >= 0 AND accepted >= 0 AND rejected >= 0 AND created_count >= 0
    AND updated_count >= 0 AND held_for_review >= 0 AND skipped_duplicates >= 0 AND dropped >= 0 AND quota_refused >= 0),
  -- KEYS ONLY (member-scoped lead_key), the union across the run incl. resumed days (isRepeatedPage's basis).
  seen_lead_keys     text[]      NOT NULL DEFAULT '{}'
    CONSTRAINT salesnav_extraction_runs_seen_keys_bound CHECK (cardinality(seen_lead_keys) <= 10000),
  retry_after_at     timestamptz NULL,
  initiated_by       uuid        NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  last_activity_at   timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz NULL,
  -- closed_at is set exactly when the status is terminal
  CONSTRAINT salesnav_extraction_runs_closed_at CHECK (
    (status IN ('queued', 'running', 'paused_daily_cap', 'auth_expired')) = (closed_at IS NULL))
);

COMMENT ON TABLE public.salesnav_extraction_runs IS
  'Sales Navigator extraction runs (contract v2.2): one row per run, every transport. Closed (status, code) sets; '
  'seen_lead_keys holds KEYS ONLY. Written only by the server-side contract implementation.';

COMMENT ON COLUMN public.salesnav_extraction_runs.vendor_cursor IS
  'Opaque vendor paging token (unipile / vayne). It may ENCODE the search query and paging state: treat as '
  'sensitive - never log it, never return it to a client, never include it in a run-status payload or diagnostics.';

-- ONE non-terminal run per member (queued, running, or a resumable pause): two runs never compete for one cap.
CREATE UNIQUE INDEX IF NOT EXISTS salesnav_extraction_runs_one_open_per_member
  ON public.salesnav_extraction_runs (member_id)
  WHERE status IN ('queued', 'running', 'paused_daily_cap', 'auth_expired');

CREATE INDEX IF NOT EXISTS salesnav_extraction_runs_org_created
  ON public.salesnav_extraction_runs (organization_id, created_at DESC);

-- RLS + grants (all three tables: RLS on, one service_role policy, zero client grants) ------------------------------
ALTER TABLE public.salesnav_member_owner    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salesnav_member_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salesnav_extraction_runs ENABLE ROW LEVEL SECURITY;

DO $snr_rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['salesnav_member_owner', 'salesnav_member_bindings', 'salesnav_extraction_runs'] LOOP
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
                AND policyname = t || '_service_role' AND roles::text[] <> ARRAY['service_role']) THEN
      EXECUTE format('DROP POLICY %I ON public.%I', t || '_service_role', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
                    AND policyname = t || '_service_role') THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role '
                     'USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')',
                     t || '_service_role', t);
    END IF;
  END LOOP;
END
$snr_rls$;

-- REVOKE ALL (not a list: PG17 adds MAINTAIN), naming every client role.
REVOKE ALL ON TABLE public.salesnav_member_owner    FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON TABLE public.salesnav_member_bindings FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON TABLE public.salesnav_extraction_runs FROM PUBLIC, anon, authenticated, authenticator, service_role;
-- owner + bindings: DELETE is the disconnect. Runs: no DELETE (history).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.salesnav_member_owner    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.salesnav_member_bindings TO service_role;
GRANT SELECT, INSERT, UPDATE         ON TABLE public.salesnav_extraction_runs TO service_role;

-- POSTCONDITIONS (each RAISEs; the trip input is named). -----------------------------------------------------------
DO $verify$
DECLARE
  v_rls boolean; v_force boolean; v_n integer; v_pol_roles text[]; v_priv text[]; v_leaked text[];
  t text; r text; p text; v_expect text[];
BEGIN
  FOREACH t IN ARRAY ARRAY['salesnav_member_owner', 'salesnav_member_bindings', 'salesnav_extraction_runs'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN RAISE EXCEPTION 'SNR postcondition: % is missing', t; END IF;

    SELECT c.relrowsecurity, c.relforcerowsecurity INTO v_rls, v_force FROM pg_class c WHERE c.oid = ('public.' || t)::regclass;
    IF NOT v_rls THEN RAISE EXCEPTION 'SNR postcondition: % row level security must be ENABLED', t; END IF;
    IF v_force THEN RAISE EXCEPTION 'SNR postcondition: % row level security must NOT be FORCED', t; END IF;
    SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = t;
    IF v_n <> 1 THEN RAISE EXCEPTION 'SNR postcondition: % expected exactly 1 policy, found %', t, v_n; END IF;
    SELECT roles::text[] INTO v_pol_roles FROM pg_policies
     WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_service_role';
    IF v_pol_roles IS DISTINCT FROM ARRAY['service_role'] THEN
      RAISE EXCEPTION 'SNR postcondition: % policy must apply to exactly {service_role}, found %', t, v_pol_roles;
    END IF;

    v_expect := CASE WHEN t = 'salesnav_extraction_runs' THEN ARRAY['INSERT', 'SELECT', 'UPDATE']
                     ELSE ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE'] END;
    SELECT array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type) INTO v_priv
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r2 ON r2.oid = a.grantee
     WHERE c.oid = ('public.' || t)::regclass AND r2.rolname = 'service_role';
    IF v_priv IS DISTINCT FROM v_expect THEN
      RAISE EXCEPTION 'SNR postcondition: service_role on % must hold exactly %, found %', t, v_expect, coalesce(v_priv::text, '{}');
    END IF;
    SELECT array_agg(DISTINCT coalesce(r2.rolname, 'PUBLIC') || ':' || a.privilege_type) INTO v_leaked
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles r2 ON r2.oid = a.grantee
     WHERE c.oid = ('public.' || t)::regclass
       AND (a.grantee = 0 OR r2.rolname IN ('anon', 'authenticated', 'authenticator'));
    IF v_leaked IS NOT NULL THEN RAISE EXCEPTION 'SNR postcondition: a client role holds a privilege on %: %', t, v_leaked; END IF;
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(r, 'public.' || t, p) THEN
          RAISE EXCEPTION 'SNR postcondition: % holds % on %', r, p, t;
        END IF;
      END LOOP;
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(r, 'public.' || t, p) THEN
          RAISE EXCEPTION 'SNR postcondition: % holds column-level % on %', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- keys and the constraints that carry the rules
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.salesnav_member_owner'::regclass AND contype = 'p'
     AND pg_get_constraintdef(oid) = 'PRIMARY KEY (member_id)';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SNR postcondition: salesnav_member_owner primary key must be (member_id) - one company per member'; END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.salesnav_member_bindings'::regclass AND contype = 'f'
     AND conname = 'salesnav_member_bindings_owner_fk'
     AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (member_id, organization_id) REFERENCES salesnav_member_owner(member_id, organization_id)%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SNR postcondition: bindings must reference the owner row on (member_id, organization_id)'; END IF;
  FOREACH p IN ARRAY ARRAY['salesnav_extraction_runs_status_code', 'salesnav_extraction_runs_closed_at',
                           'salesnav_extraction_runs_member_canonical', 'salesnav_extraction_runs_canonical_url',
                           'salesnav_extraction_runs_seen_keys_bound', 'salesnav_extraction_runs_counts_nonneg',
                           'salesnav_extraction_runs_vendor_cursor', 'salesnav_extraction_runs_active_route',
                           'salesnav_extraction_runs_pending'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.salesnav_extraction_runs'::regclass AND conname = p) THEN
      RAISE EXCEPTION 'SNR postcondition: constraint % is missing', p;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'salesnav_extraction_runs'
     AND indexname = 'salesnav_extraction_runs_one_open_per_member' AND indexdef LIKE 'CREATE UNIQUE INDEX%(member_id) WHERE%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SNR postcondition: the one-open-run-per-member unique index is missing'; END IF;

  RAISE NOTICE 'SNR: salesnav_member_owner (PK member_id), salesnav_member_bindings (owner FK), salesnav_extraction_runs (closed status/code CHECK, one open run per member) verified - RLS enabled, 1 service_role policy each, no client privileges.';
END
$verify$;

COMMIT;
