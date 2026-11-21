-- 20270217000074 salesnav_daily_quota (reserved by cb, registry f8a39c668)
--
-- The Sales Navigator SHARED DAILY CAP (contract v2, owner rulings 2026-11-20/21; c6 owns the contract):
-- every route that reads Sales Navigator - API vendors, our extension, Playwright RPA - consumes this ONE quota per
-- (canonical LinkedIn member, UTC day), so switching transport cannot stack past the cap. The cap protects the
-- customer's own LinkedIn account: anything a route READ counts, duplicates included (consume-on-reserve, no refund).
--
-- RE-KEYED 2026-11-21 (b3 ruling A; edited before any apply, cb confirmed unapplied): the count is keyed on the MEMBER
-- ALONE - organization_id is not in the table. One company per member is enforced by 073's salesnav_member_owner
-- (member_id is its primary key), and the consume function grants 0 unless p_organization_id OWNS p_member_id. So an
-- account moved between companies on the same UTC day carries that day's count, and no member can exceed the cap
-- (<= 200) per day by being connected twice. The ownership check runs under a FOR SHARE lock on the owner row, in the
-- same transaction as the increment: a concurrent ownership transfer (which deletes that row) waits for the consume to
-- commit, and a transfer that committed first leaves no row to lock, so the consume grants 0.
--
-- Cap: per-company setting, DEFAULT 150, HARD MAX 200. The function receives the cap the caller resolved and
-- REFUSES any cap outside 1..200 (22023). Fail-closed rules at the caller (backend/services/salesNav/quota):
--   setting genuinely ABSENT        -> 150 (the default);
--   setting present but MALFORMED   -> 150 (never more reading - resolveDailyCap);
--   setting UNREADABLE (read error) -> REFUSE (granted 0) - never the default.
-- Any error from this function -> granted 0.
--
-- ATOMIC: one INSERT .. ON CONFLICT DO UPDATE .. WHERE consumed + n <= cap RETURNING. No row returned = refused, and
-- nothing was consumed. ALL-OR-NOTHING per call (a RETURNING sees only the new row, so a partial grant cannot be
-- reported atomically); the caller retries ONCE with exactly the returned remaining. No read-then-write.
--
-- member_id is the CANONICAL LinkedIn profile id (contract canonicalMemberId: the ACoAA... id). It is an opaque
-- identifier, enforced by CHECK; no name or profile text is stored.
--
-- This version: never applied anywhere. RLS on, zero client grants, service_role only.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.companies') IS NULL THEN
    RAISE EXCEPTION 'SNQ preflight: public.companies is missing - there is no tenant to scope the quota to';
  END IF;
  IF to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION 'SNQ preflight: auth.role() is missing - the house service_role policy cannot be expressed';
  END IF;
  IF to_regclass('public.salesnav_member_owner') IS NULL THEN
    RAISE EXCEPTION 'SNQ preflight: public.salesnav_member_owner (073) is missing - member ownership cannot be checked';
  END IF;
  -- 7c (slice 1): CREATE TABLE IF NOT EXISTS would silently ACCEPT a table already present in the PRE-re-key shape
  -- (keyed by organization_id), and the re-keyed function would then run against a per-company key - the cap NOT
  -- shared, a member stacking past it by being connected twice: the exact defect the re-key removes, failing open.
  IF to_regclass('public.salesnav_daily_quota') IS NOT NULL AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'salesnav_daily_quota' AND column_name = 'organization_id') THEN
    RAISE EXCEPTION 'SNQ preflight: salesnav_daily_quota exists in the PRE-re-key shape (organization_id); 074 was applied in its first form - the re-key needs its own migration, not IF NOT EXISTS';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.salesnav_daily_quota (
  member_id       text        NOT NULL
    CONSTRAINT salesnav_daily_quota_member_canonical CHECK (member_id ~ '^ACoAA[A-Za-z0-9_-]{10,80}$'),
  usage_day       date        NOT NULL,
  consumed        integer     NOT NULL DEFAULT 0
    CONSTRAINT salesnav_daily_quota_consumed_bounds CHECK (consumed >= 0 AND consumed <= 200),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salesnav_daily_quota_pkey PRIMARY KEY (member_id, usage_day)
);

COMMENT ON TABLE public.salesnav_daily_quota IS
  'Sales Navigator shared daily cap per (canonical LinkedIn member, UTC day), shared by ALL extraction routes and '
  'across any change of owning company. Written ONLY by salesnav_consume_daily_quota (atomic, all-or-nothing, owner '
  'checked under lock). Opaque member id only.';

ALTER TABLE public.salesnav_daily_quota ENABLE ROW LEVEL SECURITY;

DO $snq_rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'salesnav_daily_quota'
              AND policyname = 'salesnav_daily_quota_service_role' AND roles::text[] <> ARRAY['service_role']) THEN
    DROP POLICY salesnav_daily_quota_service_role ON public.salesnav_daily_quota;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'salesnav_daily_quota'
                  AND policyname = 'salesnav_daily_quota_service_role') THEN
    CREATE POLICY salesnav_daily_quota_service_role ON public.salesnav_daily_quota
      FOR ALL TO service_role
      USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END
$snq_rls$;

-- REVOKE ALL (not a list: PG17 adds MAINTAIN), naming every client role.
REVOKE ALL ON TABLE public.salesnav_daily_quota FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.salesnav_daily_quota TO service_role;

CREATE OR REPLACE FUNCTION public.salesnav_consume_daily_quota(
  p_organization_id uuid,
  p_member_id       text,
  p_usage_day       date,
  p_count           integer,
  p_cap             integer
)
RETURNS TABLE (granted integer, consumed integer, remaining integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_consumed integer;
BEGIN
  IF p_organization_id IS NULL OR p_member_id IS NULL OR p_usage_day IS NULL OR p_count IS NULL OR p_cap IS NULL
     OR p_count < 1 OR p_cap < 1 OR p_cap > 200
     OR p_member_id !~ '^ACoAA[A-Za-z0-9_-]{10,80}$' THEN
    RAISE EXCEPTION 'salesnav_consume_daily_quota: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- OWNERSHIP, under lock: only the company that owns the member may consume its cap. FOR SHARE holds the owner row
  -- until this transaction ends, so a transfer (DELETE of that row) cannot interleave with the increment below. No
  -- owner row for this (member, company) -> grant 0 and write NOTHING.
  -- 7c (slice 1): and DISCLOSE nothing - a caller with no claim to the member has no claim to its usage, so the
  -- non-owner answer is (0, 0, 0) and the quota row is not even read (it used to return the member's real consumed).
  PERFORM 1 FROM public.salesnav_member_owner o
   WHERE o.member_id = p_member_id AND o.organization_id = p_organization_id
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;

  -- ONE statement: insert the first consumption of the day, or add to it, only while it stays within the cap.
  INSERT INTO public.salesnav_daily_quota AS q (member_id, usage_day, consumed)
  SELECT p_member_id, p_usage_day, p_count
   WHERE p_count <= p_cap
  ON CONFLICT (member_id, usage_day) DO UPDATE
     SET consumed   = q.consumed + EXCLUDED.consumed,
         updated_at = now()
   WHERE q.consumed::bigint + EXCLUDED.consumed::bigint <= p_cap::bigint
  RETURNING q.consumed INTO v_consumed;

  IF FOUND THEN
    RETURN QUERY SELECT p_count, v_consumed, greatest(0, p_cap - v_consumed);
    RETURN;
  END IF;

  -- Refused: nothing consumed. Report what remains so the caller can retry ONCE with exactly that.
  SELECT d.consumed INTO v_consumed
    FROM public.salesnav_daily_quota d
   WHERE d.member_id = p_member_id AND d.usage_day = p_usage_day;
  RETURN QUERY SELECT 0, coalesce(v_consumed, 0), greatest(0, p_cap - coalesce(v_consumed, 0));
END
$fn$;

COMMENT ON FUNCTION public.salesnav_consume_daily_quota(uuid, text, date, integer, integer) IS
  'Atomically consume p_count of the Sales Navigator daily cap p_cap (1..200) for one canonical member + UTC day, '
  'ALL-OR-NOTHING, only when p_organization_id OWNS the member (salesnav_member_owner, checked under FOR SHARE). '
  'granted = 0 means nothing was consumed; a non-owner gets remaining = 0. The caller fails CLOSED on any error.';

REVOKE ALL ON FUNCTION public.salesnav_consume_daily_quota(uuid, text, date, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salesnav_consume_daily_quota(uuid, text, date, integer, integer) TO service_role;

-- POSTCONDITIONS (each RAISEs; the trip input is named).
DO $verify$
DECLARE
  v_rls boolean; v_force boolean; v_n integer; v_pol_roles text[]; v_priv text[]; v_leaked text[];
  v_fn regprocedure := to_regprocedure('public.salesnav_consume_daily_quota(uuid, text, date, integer, integer)');
  v_secdef boolean; v_config text[]; r text; p text;
BEGIN
  IF to_regclass('public.salesnav_daily_quota') IS NULL THEN
    RAISE EXCEPTION 'SNQ postcondition: the table is missing';
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.salesnav_daily_quota'::regclass AND contype = 'p' AND conname = 'salesnav_daily_quota_pkey'
     AND pg_get_constraintdef(oid) = 'PRIMARY KEY (member_id, usage_day)';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SNQ postcondition: the primary key must be (member_id, usage_day) - the cap is per member'; END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.salesnav_daily_quota'::regclass
              AND attname = 'organization_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'SNQ postcondition: salesnav_daily_quota must not carry organization_id (the count is per member)';
  END IF;
  FOREACH p IN ARRAY ARRAY['salesnav_daily_quota_member_canonical', 'salesnav_daily_quota_consumed_bounds'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.salesnav_daily_quota'::regclass AND conname = p) THEN
      RAISE EXCEPTION 'SNQ postcondition: constraint % is missing', p;
    END IF;
  END LOOP;

  SELECT c.relrowsecurity, c.relforcerowsecurity INTO v_rls, v_force FROM pg_class c WHERE c.oid = 'public.salesnav_daily_quota'::regclass;
  IF NOT v_rls THEN RAISE EXCEPTION 'SNQ postcondition: row level security must be ENABLED'; END IF;
  IF v_force THEN RAISE EXCEPTION 'SNQ postcondition: row level security must NOT be FORCED'; END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'salesnav_daily_quota';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SNQ postcondition: expected exactly 1 policy, found %', v_n; END IF;
  SELECT roles::text[] INTO v_pol_roles FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'salesnav_daily_quota' AND policyname = 'salesnav_daily_quota_service_role';
  IF v_pol_roles IS DISTINCT FROM ARRAY['service_role'] THEN
    RAISE EXCEPTION 'SNQ postcondition: the policy must apply to exactly {service_role}, found %', v_pol_roles;
  END IF;

  -- table ACL: service_role exactly {INSERT,SELECT,UPDATE}; nothing for PUBLIC / anon / authenticated / authenticator.
  SELECT array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type) INTO v_priv
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r2 ON r2.oid = a.grantee
   WHERE c.oid = 'public.salesnav_daily_quota'::regclass AND r2.rolname = 'service_role';
  IF v_priv IS DISTINCT FROM ARRAY['INSERT', 'SELECT', 'UPDATE'] THEN
    RAISE EXCEPTION 'SNQ postcondition: service_role must hold exactly {INSERT,SELECT,UPDATE}, found %', coalesce(v_priv::text, '{}');
  END IF;
  SELECT array_agg(DISTINCT coalesce(r2.rolname, 'PUBLIC') || ':' || a.privilege_type) INTO v_leaked
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles r2 ON r2.oid = a.grantee
   WHERE c.oid = 'public.salesnav_daily_quota'::regclass
     AND (a.grantee = 0 OR r2.rolname IN ('anon', 'authenticated', 'authenticator'));
  IF v_leaked IS NOT NULL THEN RAISE EXCEPTION 'SNQ postcondition: a client role holds a table privilege: %', v_leaked; END IF;
  -- effective privileges, table AND column level, for both client roles (cb checklist).
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.salesnav_daily_quota', p) THEN
        RAISE EXCEPTION 'SNQ postcondition: % holds % on salesnav_daily_quota', r, p;
      END IF;
    END LOOP;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege(r, 'public.salesnav_daily_quota', p) THEN
        RAISE EXCEPTION 'SNQ postcondition: % holds column-level % on salesnav_daily_quota', r, p;
      END IF;
    END LOOP;
  END LOOP;

  -- function: INVOKER, EXACT proconfig, proacl (not has_function_privilege, which is true for the owner).
  IF v_fn IS NULL THEN RAISE EXCEPTION 'SNQ postcondition: salesnav_consume_daily_quota(uuid, text, date, integer, integer) is missing'; END IF;
  SELECT p2.prosecdef, p2.proconfig INTO v_secdef, v_config FROM pg_proc p2 WHERE p2.oid = v_fn;
  IF v_secdef THEN RAISE EXCEPTION 'SNQ postcondition: salesnav_consume_daily_quota must be SECURITY INVOKER'; END IF;
  IF v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] THEN
    RAISE EXCEPTION 'SNQ postcondition: proconfig must be exactly {search_path=pg_catalog, public, pg_temp}, found %', coalesce(v_config::text, '{}');
  END IF;
  SELECT array_agg(DISTINCT coalesce(r2.rolname, 'PUBLIC')) INTO v_leaked
    FROM pg_proc p2 CROSS JOIN LATERAL aclexplode(coalesce(p2.proacl, acldefault('f', p2.proowner))) a
    LEFT JOIN pg_roles r2 ON r2.oid = a.grantee
   WHERE p2.oid = v_fn AND a.privilege_type = 'EXECUTE'
     AND (a.grantee = 0 OR r2.rolname IN ('anon', 'authenticated', 'authenticator'));
  IF v_leaked IS NOT NULL THEN RAISE EXCEPTION 'SNQ postcondition: EXECUTE must not be held by %', v_leaked; END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p2 CROSS JOIN LATERAL aclexplode(p2.proacl) a JOIN pg_roles r2 ON r2.oid = a.grantee
   WHERE p2.oid = v_fn AND a.privilege_type = 'EXECUTE' AND r2.rolname = 'service_role';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SNQ postcondition: service_role must hold EXECUTE on salesnav_consume_daily_quota'; END IF;

  RAISE NOTICE 'SNQ: salesnav_daily_quota verified - PK (member_id, usage_day), no organization_id; canonical member CHECK; RLS enabled, 1 service_role policy; service_role SELECT+INSERT+UPDATE only; salesnav_consume_daily_quota INVOKER, proconfig exact, EXECUTE service_role only.';
END
$verify$;

COMMIT;
