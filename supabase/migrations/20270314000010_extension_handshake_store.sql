-- 20270314000010 extension_handshake_store (Phase E: extension handshake corrections)
--
-- The extension handshake kept two pieces of security state in PROCESS MEMORY (a Map on globalThis):
--   1. claim codes (backend/services/extensionClaimCodeService.ts): POST /api/extension/bootstrap minted a 60 s,
--      single-use code; POST /api/extension/redeem looked it up. On Vercel the two calls can land on different
--      instances, so a valid code was answered INVALID_OR_EXPIRED_CLAIM_CODE, and "single use" held per instance only;
--   2. request nonces (backend/services/extensionSessionService.ts): the HMAC replay guard remembered nonces per
--      instance, so a captured signed request could be replayed once against every other instance inside the
--      +-5 min timestamp window.
-- Both move to Postgres, the one store every Vercel API route already reaches (service_role via PostgREST).
--
-- WHAT IS STORED: only SHA-256 hex digests. extension_claim_codes.code_hash = sha256(claim code); a stolen row cannot
-- be redeemed. extension_request_nonces.nonce_key = sha256(<session hmac nonce> ':' <request nonce>): scoped per
-- extension session, no request content.
--
-- ATOMIC, DATABASE CLOCK:
--   extension_claim_code_issue   INSERT with expires_at = now() + ttl (1..600 s; the app passes 60).
--   extension_claim_code_peek    READ ONLY: the (user, organization) of an unredeemed, unexpired code. Lets
--                                POST /api/extension/redeem check membership and the signing secret BEFORE the code
--                                is consumed (review S-4); it never marks anything redeemed.
--   extension_claim_code_redeem  ONE statement: UPDATE .. SET redeemed_at = now() WHERE code_hash = $1 AND
--                                redeemed_at IS NULL AND expires_at > now() RETURNING user_id, organization_id.
--                                Two concurrent redeems of one code: the second waits on the row lock, re-checks
--                                the WHERE against the committed row (redeemed_at set) and returns nothing.
--   extension_request_nonce_record  INSERT .. ON CONFLICT DO UPDATE .. WHERE the old row has EXPIRED .. RETURNING.
--                                true = first use (recorded), false = replay. Concurrent first uses of one key:
--                                exactly one true (the unique index serialises them).
--
-- RETENTION WITHOUT A CRON JOB: each issue call deletes up to 100 claim codes that expired more than 1 hour ago, and
-- each nonce record deletes up to 50 expired nonces (FOR UPDATE SKIP LOCKED: concurrent callers never wait on each
-- other's purge). Both tables therefore stay bounded by their traffic over the retention window with no scheduler
-- entry (a new cron job never fires unless it is listed in ALWAYS_RUN_JOBS).
--
-- ACCESS: RLS on, one service_role policy, zero client grants; the functions are SECURITY INVOKER, search_path pinned,
-- EXECUTE for service_role only. The caller (Next.js API routes) fails CLOSED (503) on any error from these functions.
--
-- DEPLOY ORDER (review S-3; docs/runbooks/phase-c-browser-execution-deploy.md): apply this file BEFORE the web
-- deploy that ships the Postgres-backed handshake. Without it every extension route (bootstrap, redeem and every
-- signed request) answers 503 - fail closed, but a full extension outage until it is applied.
--
-- This version: never applied anywhere.
-- Rollback: supabase/migrations/rollbacks/extension_handshake_store_rollback.sql

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION 'EHS preflight: auth.role() is missing - the house service_role policy cannot be expressed';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------------- claim codes
CREATE TABLE IF NOT EXISTS public.extension_claim_codes (
  code_hash        text        NOT NULL
    CONSTRAINT extension_claim_codes_hash_sha256 CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  user_id          uuid        NOT NULL,
  organization_id  uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  redeemed_at      timestamptz,
  CONSTRAINT extension_claim_codes_pkey PRIMARY KEY (code_hash),
  CONSTRAINT extension_claim_codes_ttl_bounds
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);

CREATE INDEX IF NOT EXISTS extension_claim_codes_expires_at_idx
  ON public.extension_claim_codes (expires_at);

COMMENT ON TABLE public.extension_claim_codes IS
  'One-time extension claim codes (POST /api/extension/bootstrap -> /redeem). Stores sha256(code) only. Written ONLY '
  'by extension_claim_code_issue / extension_claim_code_redeem (atomic single use, database clock).';

ALTER TABLE public.extension_claim_codes ENABLE ROW LEVEL SECURITY;

DO $ecc_rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'extension_claim_codes'
              AND policyname = 'extension_claim_codes_service_role' AND roles::text[] <> ARRAY['service_role']) THEN
    DROP POLICY extension_claim_codes_service_role ON public.extension_claim_codes;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'extension_claim_codes'
                  AND policyname = 'extension_claim_codes_service_role') THEN
    CREATE POLICY extension_claim_codes_service_role ON public.extension_claim_codes
      FOR ALL TO service_role
      USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END
$ecc_rls$;

-- REVOKE ALL (not a list: PG17 adds MAINTAIN), naming every client role.
REVOKE ALL ON TABLE public.extension_claim_codes FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.extension_claim_codes TO service_role;

-- ------------------------------------------------------------------------------------------------- request nonces
CREATE TABLE IF NOT EXISTS public.extension_request_nonces (
  nonce_key      text        NOT NULL
    CONSTRAINT extension_request_nonces_key_sha256 CHECK (nonce_key ~ '^[0-9a-f]{64}$'),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  CONSTRAINT extension_request_nonces_pkey PRIMARY KEY (nonce_key),
  CONSTRAINT extension_request_nonces_ttl_bounds
    CHECK (expires_at > first_seen_at AND expires_at <= first_seen_at + interval '1 hour')
);

CREATE INDEX IF NOT EXISTS extension_request_nonces_expires_at_idx
  ON public.extension_request_nonces (expires_at);

COMMENT ON TABLE public.extension_request_nonces IS
  'Extension request-signature replay guard: sha256(session hmac nonce : request nonce), kept past the +-5 min '
  'timestamp window. Written ONLY by extension_request_nonce_record (atomic first-use, database clock).';

ALTER TABLE public.extension_request_nonces ENABLE ROW LEVEL SECURITY;

DO $ern_rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'extension_request_nonces'
              AND policyname = 'extension_request_nonces_service_role' AND roles::text[] <> ARRAY['service_role']) THEN
    DROP POLICY extension_request_nonces_service_role ON public.extension_request_nonces;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'extension_request_nonces'
                  AND policyname = 'extension_request_nonces_service_role') THEN
    CREATE POLICY extension_request_nonces_service_role ON public.extension_request_nonces
      FOR ALL TO service_role
      USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END
$ern_rls$;

REVOKE ALL ON TABLE public.extension_request_nonces FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.extension_request_nonces TO service_role;

-- ------------------------------------------------------------------------------------------------------ functions
CREATE OR REPLACE FUNCTION public.extension_claim_code_issue(
  p_code_hash        text,
  p_user_id          uuid,
  p_organization_id  uuid,
  p_ttl_seconds      integer
)
RETURNS TABLE (issued_at timestamptz, valid_until timestamptz)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' OR p_user_id IS NULL OR p_organization_id IS NULL
     OR p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 600 THEN
    RAISE EXCEPTION 'extension_claim_code_issue: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- bounded retention: codes that expired over an hour ago (redeemed or not) are no longer evidence of anything
  DELETE FROM public.extension_claim_codes d
   WHERE d.code_hash IN (SELECT o.code_hash FROM public.extension_claim_codes o
                          WHERE o.expires_at < now() - interval '1 hour'
                          ORDER BY o.expires_at
                          LIMIT 100
                          FOR UPDATE SKIP LOCKED);

  RETURN QUERY
  INSERT INTO public.extension_claim_codes AS c (code_hash, user_id, organization_id, created_at, expires_at)
  VALUES (p_code_hash, p_user_id, p_organization_id, now(), now() + make_interval(secs => p_ttl_seconds))
  RETURNING c.created_at, c.expires_at;
END
$fn$;

COMMENT ON FUNCTION public.extension_claim_code_issue(text, uuid, uuid, integer) IS
  'Store one claim code (sha256 hex) bound to (user, organization), valid for p_ttl_seconds (1..600) by the database '
  'clock. A duplicate hash raises 23505 (never overwrites). Purges up to 100 codes expired > 1 h.';

REVOKE ALL ON FUNCTION public.extension_claim_code_issue(text, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extension_claim_code_issue(text, uuid, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.extension_claim_code_peek(p_code_hash text)
RETURNS TABLE (peek_user_id uuid, peek_organization_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  -- Read only: no row lock, nothing written. The binding (user, organization) of a code never changes, so what
  -- this returns is what a later successful redeem of the same code returns.
  RETURN QUERY
  SELECT c.user_id, c.organization_id
    FROM public.extension_claim_codes c
   WHERE c.code_hash = p_code_hash
     AND c.redeemed_at IS NULL
     AND c.expires_at > now();
END
$fn$;

COMMENT ON FUNCTION public.extension_claim_code_peek(text) IS
  'Look up an unredeemed, unexpired claim code''s (user, organization) WITHOUT redeeming it, so the redeem route can '
  'refuse a principal (membership, signing secret) before the single-use code is consumed. No row = invalid, expired '
  'or already redeemed.';

REVOKE ALL ON FUNCTION public.extension_claim_code_peek(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extension_claim_code_peek(text) TO service_role;

CREATE OR REPLACE FUNCTION public.extension_claim_code_redeem(p_code_hash text)
RETURNS TABLE (redeemed_user_id uuid, redeemed_organization_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;  -- malformed = not a code we issued; nothing to redeem, nothing written
  END IF;
  -- ONE statement; single use under concurrency (see header).
  RETURN QUERY
  UPDATE public.extension_claim_codes AS c
     SET redeemed_at = now()
   WHERE c.code_hash = p_code_hash
     AND c.redeemed_at IS NULL
     AND c.expires_at > now()
  RETURNING c.user_id, c.organization_id;
END
$fn$;

COMMENT ON FUNCTION public.extension_claim_code_redeem(text) IS
  'Redeem a claim code ONCE: returns its (user, organization) only if unredeemed and unexpired (database clock), '
  'marking it redeemed in the same statement. No row = invalid, expired or already redeemed.';

REVOKE ALL ON FUNCTION public.extension_claim_code_redeem(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extension_claim_code_redeem(text) TO service_role;

CREATE OR REPLACE FUNCTION public.extension_request_nonce_record(p_nonce_key text, p_ttl_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_recorded boolean;
BEGIN
  IF p_nonce_key IS NULL OR p_nonce_key !~ '^[0-9a-f]{64}$'
     OR p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'extension_request_nonce_record: invalid arguments' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.extension_request_nonces d
   WHERE d.nonce_key IN (SELECT o.nonce_key FROM public.extension_request_nonces o
                          WHERE o.expires_at < now()
                          ORDER BY o.expires_at
                          LIMIT 50
                          FOR UPDATE SKIP LOCKED);

  INSERT INTO public.extension_request_nonces AS n (nonce_key, first_seen_at, expires_at)
  VALUES (p_nonce_key, now(), now() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (nonce_key) DO UPDATE
     SET first_seen_at = EXCLUDED.first_seen_at,
         expires_at    = EXCLUDED.expires_at
   WHERE n.expires_at <= now()
  RETURNING true INTO v_recorded;

  RETURN coalesce(v_recorded, false);
END
$fn$;

COMMENT ON FUNCTION public.extension_request_nonce_record(text, integer) IS
  'Record a signed request''s nonce key (sha256 hex) for p_ttl_seconds (60..3600). true = first use; false = seen '
  'and not yet expired (a replay). Purges up to 50 expired keys.';

REVOKE ALL ON FUNCTION public.extension_request_nonce_record(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extension_request_nonce_record(text, integer) TO service_role;

-- POSTCONDITIONS (each RAISEs; the trip input is named).
DO $verify$
DECLARE
  v_rls boolean; v_force boolean; v_n integer; v_pol_roles text[]; v_priv text[]; v_leaked text[];
  v_secdef boolean; v_config text[]; t text; r text; p text; f regprocedure;
BEGIN
  FOREACH t IN ARRAY ARRAY['extension_claim_codes', 'extension_request_nonces'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN RAISE EXCEPTION 'EHS postcondition: table % is missing', t; END IF;
    SELECT c.relrowsecurity, c.relforcerowsecurity INTO v_rls, v_force FROM pg_class c WHERE c.oid = ('public.' || t)::regclass;
    IF NOT v_rls THEN RAISE EXCEPTION 'EHS postcondition: % row level security must be ENABLED', t; END IF;
    IF v_force THEN RAISE EXCEPTION 'EHS postcondition: % row level security must NOT be FORCED', t; END IF;
    SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = t;
    IF v_n <> 1 THEN RAISE EXCEPTION 'EHS postcondition: % expected exactly 1 policy, found %', t, v_n; END IF;
    SELECT roles::text[] INTO v_pol_roles FROM pg_policies WHERE schemaname = 'public' AND tablename = t;
    IF v_pol_roles IS DISTINCT FROM ARRAY['service_role'] THEN
      RAISE EXCEPTION 'EHS postcondition: % policy must apply to exactly {service_role}, found %', t, v_pol_roles;
    END IF;
    SELECT array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type) INTO v_priv
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r2 ON r2.oid = a.grantee
     WHERE c.oid = ('public.' || t)::regclass AND r2.rolname = 'service_role';
    IF v_priv IS DISTINCT FROM ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE'] THEN
      RAISE EXCEPTION 'EHS postcondition: service_role must hold exactly {DELETE,INSERT,SELECT,UPDATE} on %, found %', t, coalesce(v_priv::text, '{}');
    END IF;
    SELECT array_agg(DISTINCT coalesce(r2.rolname, 'PUBLIC') || ':' || a.privilege_type) INTO v_leaked
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles r2 ON r2.oid = a.grantee
     WHERE c.oid = ('public.' || t)::regclass
       AND (a.grantee = 0 OR r2.rolname IN ('anon', 'authenticated', 'authenticator'));
    IF v_leaked IS NOT NULL THEN RAISE EXCEPTION 'EHS postcondition: a client role holds a privilege on %: %', t, v_leaked; END IF;
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(r, 'public.' || t, p) THEN
          RAISE EXCEPTION 'EHS postcondition: % holds % on %', r, p, t;
        END IF;
      END LOOP;
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(r, 'public.' || t, p) THEN
          RAISE EXCEPTION 'EHS postcondition: % holds column-level % on %', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.extension_claim_codes'::regclass AND contype = 'p'
     AND pg_get_constraintdef(oid) = 'PRIMARY KEY (code_hash)';
  IF v_n <> 1 THEN RAISE EXCEPTION 'EHS postcondition: extension_claim_codes primary key must be (code_hash)'; END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.extension_request_nonces'::regclass AND contype = 'p'
     AND pg_get_constraintdef(oid) = 'PRIMARY KEY (nonce_key)';
  IF v_n <> 1 THEN RAISE EXCEPTION 'EHS postcondition: extension_request_nonces primary key must be (nonce_key)'; END IF;
  FOREACH p IN ARRAY ARRAY['extension_claim_codes_hash_sha256', 'extension_claim_codes_ttl_bounds',
                           'extension_request_nonces_key_sha256', 'extension_request_nonces_ttl_bounds'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = p) THEN
      RAISE EXCEPTION 'EHS postcondition: constraint % is missing', p;
    END IF;
  END LOOP;

  -- functions: INVOKER, EXACT proconfig, proacl (not has_function_privilege, which is true for the owner).
  FOREACH p IN ARRAY ARRAY['public.extension_claim_code_issue(text, uuid, uuid, integer)',
                           'public.extension_claim_code_peek(text)',
                           'public.extension_claim_code_redeem(text)',
                           'public.extension_request_nonce_record(text, integer)'] LOOP
    f := to_regprocedure(p);
    IF f IS NULL THEN RAISE EXCEPTION 'EHS postcondition: % is missing', p; END IF;
    SELECT p2.prosecdef, p2.proconfig INTO v_secdef, v_config FROM pg_proc p2 WHERE p2.oid = f;
    IF v_secdef THEN RAISE EXCEPTION 'EHS postcondition: % must be SECURITY INVOKER', p; END IF;
    IF v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] THEN
      RAISE EXCEPTION 'EHS postcondition: % proconfig must be exactly {search_path=pg_catalog, public, pg_temp}, found %', p, coalesce(v_config::text, '{}');
    END IF;
    SELECT array_agg(DISTINCT coalesce(r2.rolname, 'PUBLIC')) INTO v_leaked
      FROM pg_proc p2 CROSS JOIN LATERAL aclexplode(coalesce(p2.proacl, acldefault('f', p2.proowner))) a
      LEFT JOIN pg_roles r2 ON r2.oid = a.grantee
     WHERE p2.oid = f AND a.privilege_type = 'EXECUTE'
       AND (a.grantee = 0 OR r2.rolname IN ('anon', 'authenticated', 'authenticator'));
    IF v_leaked IS NOT NULL THEN RAISE EXCEPTION 'EHS postcondition: EXECUTE on % must not be held by %', p, v_leaked; END IF;
    SELECT count(*) INTO v_n
      FROM pg_proc p2 CROSS JOIN LATERAL aclexplode(p2.proacl) a JOIN pg_roles r2 ON r2.oid = a.grantee
     WHERE p2.oid = f AND a.privilege_type = 'EXECUTE' AND r2.rolname = 'service_role';
    IF v_n <> 1 THEN RAISE EXCEPTION 'EHS postcondition: service_role must hold EXECUTE on %', p; END IF;
  END LOOP;

  RAISE NOTICE 'EHS: extension_claim_codes + extension_request_nonces verified - RLS on, 1 service_role policy each, service_role S/I/U/D only, no client privilege; issue/peek/redeem/nonce_record INVOKER, proconfig exact, EXECUTE service_role only.';
END
$verify$;

COMMIT;
