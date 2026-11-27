-- ============================================================================
-- SECURITY — content_performance / content_prediction / learning_intelligence /
-- learning_memory: no client-role privilege; set_content_updated_at() hardened
-- (version 20270301000010) · prepared 2026-11-27 · NOT YET APPLIED ANYWHERE
-- ============================================================================
--
-- WHY. 20260718000003_content_learning_performance.sql (WRITER-EXEC-006 Wave 5)
-- creates the four tables with RLS on and one membership policy each
-- (`<t>_company_rw`, FOR ALL, TO public, company_id IN (SELECT company_id FROM
-- user_company_roles WHERE user_id = auth.uid() AND status = 'active')) but no
-- GRANT/REVOKE, so the database's default privileges decided their ACL.
-- 20270111000002 (SEC-A) listed them as out of scope, and the stranded #23
-- Part 3 revoke (20270205000001, applied to production 2026-11-10) excluded them
-- because their policy shape "admits clients". Both left the grant in place.
--
-- PRODUCTION STATE (read-only, 2026-11-27, phase-3 D, out/d01..d03; not contacted
-- by this file)
--   all four: owner postgres, RLS on (not forced), no column ACL, in no
--     publication, no dependent view,
--     relacl {postgres=arwdDxtm, authenticated=arwdxtm, service_role=arwdDxtm}
--     (anon and authenticator hold nothing);
--   set_content_updated_at(): plpgsql, INVOKER, proconfig NULL,
--     proacl {postgres=X, authenticated=X, service_role=X}, body
--     `BEGIN NEW.updated_at = now(); RETURN NEW; END;`, fires
--     learning_memory_set_updated_at and content_block_set_updated_at;
--   user_company_roles: RLS on, ONE policy (service_role_full_access TO
--     service_role), relacl {postgres, service_role}; authenticated/anon hold no
--     table or column privilege on it; no client-readable view over it and no
--     client-executable SECURITY DEFINER function reading it.
--
-- EXPLOITABLE TODAY? NO, latent. A client request reaches the membership policy,
-- whose sub-select on user_company_roles needs SELECT that no client role has,
-- so every client SELECT/INSERT/UPDATE/DELETE on the four tables is refused.
-- MAINTAIN/REFERENCES/TRIGGER are not reachable through PostgREST. It becomes
-- a direct member read/WRITE path (FOR ALL) the moment anyone adds a routine
-- "members read their own memberships" grant + policy on user_company_roles —
-- the exact class 20270111000002 closed for 20 other membership tables.
--
-- WHY THIS CANNOT BREAK THE APPLICATION (git grep, origin/main and every
-- origin/* branch, 2026-11-27)
--   * The only readers/writers are backend/services/content/{learningEngine,
--     learningMemoryService,performanceIntelligence,performanceService,
--     predictionEngine}.ts, all through backend/db/supabaseClient.ts (the
--     service-role client; SELECT/INSERT/UPDATE/UPSERT, no DELETE), unchanged
--     since a28e56f91 on every branch. The browser client (lib/supabaseBrowser.ts)
--     performs no .from()/.rpc().
--   * service_role is NOT touched (asserted unchanged below); it keeps BYPASSRLS.
--   * Firing a trigger never checks EXECUTE on its function, and PostgREST never
--     exposes trigger-returning functions (re-proved by SEC-B's suite), so the
--     function REVOKE changes no write path.
--   * Policies and RLS flags are NOT changed (asserted below).
--
-- WHAT THIS DOES
--   1. Tables: REVOKE ALL FROM PUBLIC, anon, authenticated, authenticator (ALL,
--      not a list: PostgreSQL 17 adds MAINTAIN). Nothing is granted to anyone.
--   2. public.set_content_updated_at(), SEC-B class T (20270111000003): REVOKE ALL
--      FROM PUBLIC, anon, authenticated, authenticator; owner and service_role keep
--      EXECUTE; search_path pinned to pg_catalog, public (the body's only
--      reference is now(), in pg_catalog; the preflight verifies the body).
--      SEC-B left it out only because it believed no migration creates it.
--
-- REPLAY SHAPE (CI real-schema and the C3 local stack). The four tables are NOT
-- in supabase/_schema/baseline.sql; they are created by the baseline-gap step
-- (supabase/_schema/baseline-gap-migrations.txt -> 20260718000003), which runs
-- AFTER every >ledgerMax migration, this one included (gap order is fixed:
-- 20270111000003's 74-trigger postcondition). So during a replay all four are
-- absent. This file then changes no table and says so with a WARNING:
--   * ALL FOUR ABSENT in every schema -> tables skipped (WARNING);
--   * SOME present, some absent       -> RAISE (a partial 20260718000003 is a
--                                        real problem, never skipped);
--   * ALL FOUR PRESENT                -> revoke + verify both ways.
-- The function is hardened whenever it exists, independently of the tables.
-- The gap-created tables then take the replay's default ACL (CI bootstrap:
-- service_role only, so no client grant; asserted by
-- backend/tests/realschema/cl_client_privileges_revoked.test.ts). The C3 stack's
-- defaults are Supabase's, which this file cannot reach (docs 16, §unresolved).
--
-- IDEMPOTENT. REVOKE/ALTER ... SET are re-runnable; the preflight asserts
-- structure only, never the pre-change ACL.
-- POSTCONDITION, both ways (tables present): every client role holds NO table or
-- column privilege (MAINTAIN on PG17+), PUBLIC has no entry; service_role still
-- holds SELECT, INSERT, UPDATE (the code's need); service_role/owner ACL entries,
-- RLS flags and policies unchanged. Function (present): no client EXECUTE, no
-- PUBLIC entry, search_path pinned, body/definer flag/owner and the non-client
-- ACL entries unchanged, its learning_memory trigger still enabled.
--
-- APPLY (after explicit owner authorization only)
--   *** DO NOT RUN `supabase db push`. *** One Management API call with this
--   file's exact bytes (it carries its own BEGIN/COMMIT: one transaction), per
--   docs/supabase-e2e-retirement/16-production-cutover-plan.md.
-- ROLLBACK (re-opens the exposure; restores production's 2026-11-27 pre-image)
--   supabase/migrations/rollbacks/content_learning_client_privileges_revoked_rollback.sql
-- ============================================================================

BEGIN;

DO $preflight$
DECLARE
  tabs   text[] := ARRAY['content_performance', 'content_prediction', 'learning_intelligence', 'learning_memory'];
  t      text;
  r      text;
  n_pub  integer;
  n_any  integer;
  fn     regprocedure := to_regprocedure('public.set_content_updated_at()');
  bad    text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'authenticator', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      RAISE EXCEPTION 'CL-ACL preflight: role % does not exist - nothing changed', r;
    END IF;
  END LOOP;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'CL-ACL preflight: service_role is not BYPASSRLS; refusing to remove client access';
  END IF;

  SELECT count(*) INTO n_pub FROM pg_class
   WHERE relnamespace = 'public'::regnamespace AND relname = ANY (tabs) AND relkind IN ('r', 'p');
  SELECT count(*) INTO n_any FROM pg_class WHERE relname = ANY (tabs);

  IF n_pub = 0 THEN
    -- Replay shape. Skip ONLY when no relation of these names exists ANYWHERE
    -- (a table moved to another schema, or a same-named view, is not "absent").
    IF n_any <> 0 THEN
      RAISE EXCEPTION 'CL-ACL preflight: none of the four tables is in public, but % relation(s) of those names exist elsewhere: %',
        n_any, (SELECT string_agg(oid::regclass::text || '(' || relkind::text || ')', ',') FROM pg_class WHERE relname = ANY (tabs));
    END IF;
    PERFORM set_config('cl_acl.mode', 'absent', true);
    RAISE WARNING 'CL-ACL: content_performance, content_prediction, learning_intelligence, learning_memory are ALL absent - table REVOKE skipped. Expected ONLY in a baseline replay, where the baseline-gap step (20260718000003) creates them after this migration; anywhere else, stop and investigate.';
  ELSIF n_pub < 4 THEN
    RAISE EXCEPTION 'CL-ACL preflight: only % of the 4 tables exist in public (%): a partial 20260718000003 - nothing changed',
      n_pub, (SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class
               WHERE relnamespace = 'public'::regnamespace AND relname = ANY (tabs) AND relkind IN ('r', 'p'));
  ELSE
    PERFORM set_config('cl_acl.mode', 'present', true);
    FOREACH t IN ARRAY tabs LOOP
      IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
        RAISE EXCEPTION 'CL-ACL preflight: row level security is not enabled on public.%', t;
      END IF;
      -- Realtime delivers rows to client roles through their SELECT privilege.
      IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE schemaname = 'public' AND tablename = t) THEN
        RAISE EXCEPTION 'CL-ACL preflight: public.% is in a publication; a realtime consumer would lose access', t;
      END IF;
    END LOOP;
    -- An owner-rights view readable by clients would stay a client path.
    SELECT string_agg(DISTINCT v.oid::regclass::text || '->' || b.relname, ', ') INTO bad
      FROM pg_class b
      JOIN pg_depend d ON d.refobjid = b.oid AND d.classid = 'pg_rewrite'::regclass
      JOIN pg_rewrite rw ON rw.oid = d.objid
      JOIN pg_class v ON v.oid = rw.ev_class AND v.oid <> b.oid
     WHERE b.relnamespace = 'public'::regnamespace AND b.relname = ANY (tabs)
       AND NOT coalesce(v.relkind = 'v' AND v.reloptions::text[] && ARRAY['security_invoker=true', 'security_invoker=on'], false)
       AND (has_table_privilege('anon', v.oid, 'SELECT') OR has_table_privilege('authenticated', v.oid, 'SELECT'));
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'CL-ACL preflight: owner-rights views readable by clients depend on these tables: %', bad;
    END IF;
    IF fn IS NULL THEN
      RAISE EXCEPTION 'CL-ACL preflight: the four tables exist but public.set_content_updated_at() does not (learning_memory_set_updated_at needs it)';
    END IF;
  END IF;

  -- Function (class T), checked whenever it exists.
  IF fn IS NOT NULL THEN
    IF (SELECT prorettype FROM pg_proc WHERE oid = fn) <> 'trigger'::regtype THEN
      RAISE EXCEPTION 'CL-ACL preflight: public.set_content_updated_at() does not return trigger';
    END IF;
    IF (SELECT prosecdef FROM pg_proc WHERE oid = fn) THEN
      RAISE EXCEPTION 'CL-ACL preflight: public.set_content_updated_at() is SECURITY DEFINER (expected INVOKER)';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_depend WHERE classid = 'pg_proc'::regclass AND objid = fn AND deptype = 'e') THEN
      RAISE EXCEPTION 'CL-ACL preflight: public.set_content_updated_at() is extension-owned';
    END IF;
    IF (SELECT proconfig FROM pg_proc WHERE oid = fn) IS NOT NULL
       AND (SELECT proconfig FROM pg_proc WHERE oid = fn) IS DISTINCT FROM '{"search_path=pg_catalog, public"}'::text[] THEN
      RAISE EXCEPTION 'CL-ACL preflight: public.set_content_updated_at() carries an unexpected proconfig %', (SELECT proconfig FROM pg_proc WHERE oid = fn);
    END IF;
    -- The pin is safe only for the reviewed body (its one reference, now(), is in pg_catalog).
    IF btrim(regexp_replace((SELECT prosrc FROM pg_proc WHERE oid = fn), '\s+', ' ', 'g'))
       IS DISTINCT FROM 'BEGIN NEW.updated_at = now(); RETURN NEW; END;' THEN
      RAISE EXCEPTION 'CL-ACL preflight: public.set_content_updated_at() body differs from the reviewed one; search_path pin not verified';
    END IF;
  END IF;

  -- Snapshot for the postcondition: RLS flags, policies and every NON-client ACL
  -- entry of the tables; the function's definition and non-client ACL entries.
  PERFORM set_config('cl_acl.pre', coalesce((
    SELECT string_agg(c.relname || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text || '|'
      || (SELECT coalesce(string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polpermissive::text || ':'
                 || p.polroles::text || ':' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ':'
                 || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), ';' ORDER BY p.polname), '')
            FROM pg_policy p WHERE p.polrelid = c.oid) || '|'
      || (SELECT coalesce(string_agg(a.grantee::regrole::text || '=' || a.privilege_type || '/' || a.grantor::regrole::text,
                 ',' ORDER BY a.grantee::regrole::text, a.privilege_type, a.grantor::regrole::text), '')
            FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
           WHERE a.grantee <> 0 AND a.grantee::regrole::text NOT IN ('anon', 'authenticated', 'authenticator')),
      E'\n' ORDER BY c.relname)
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (tabs)), '<no tables>'), true);
  PERFORM set_config('cl_acl.fn_pre', coalesce((
    SELECT p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || md5(p.prosrc) || '|'
      || (SELECT coalesce(string_agg(a.grantee::regrole::text || '=' || a.privilege_type || '/' || a.grantor::regrole::text,
                 ',' ORDER BY a.grantee::regrole::text, a.privilege_type, a.grantor::regrole::text), '')
            FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           WHERE a.grantee <> 0 AND a.grantee::regrole::text NOT IN ('anon', 'authenticated', 'authenticator'))
      FROM pg_proc p WHERE p.oid = fn), '<no function>'), true);
END
$preflight$;

-- 1. Tables (only when all four exist; the preflight decided the mode).
DO $revoke$
DECLARE
  t text;
BEGIN
  IF current_setting('cl_acl.mode', true) = 'present' THEN
    FOREACH t IN ARRAY ARRAY['content_performance', 'content_prediction', 'learning_intelligence', 'learning_memory'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, authenticator', t);
    END LOOP;
  ELSIF current_setting('cl_acl.mode', true) IS DISTINCT FROM 'absent' THEN
    RAISE EXCEPTION 'CL-ACL: preflight mode not set (%); refusing', current_setting('cl_acl.mode', true);
  END IF;
END
$revoke$;

-- 2. Function, class T (SEC-B 20270111000003 convention), whenever it exists.
DO $fn$
BEGIN
  IF to_regprocedure('public.set_content_updated_at()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.set_content_updated_at() FROM PUBLIC, anon, authenticated, authenticator';
    EXECUTE 'ALTER FUNCTION public.set_content_updated_at() SET search_path = pg_catalog, public';
  END IF;
END
$fn$;
-- This migration grants nothing to any role.

DO $post$
DECLARE
  tabs text[] := ARRAY['content_performance', 'content_prediction', 'learning_intelligence', 'learning_memory'];
  t text;
  r text;
  p text;
  v_privs text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_mode text := current_setting('cl_acl.mode', true);
  v_now text;
  fn regprocedure := to_regprocedure('public.set_content_updated_at()');
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    v_privs := array_append(v_privs, 'MAINTAIN');
  END IF;
  IF v_mode = 'absent' THEN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = ANY (tabs)) THEN
      RAISE EXCEPTION 'CL-ACL postcondition: mode absent, but a relation of these names now exists';
    END IF;
  ELSIF v_mode = 'present' THEN
    FOREACH t IN ARRAY tabs LOOP
      -- ABSENT: no client role holds any table privilege ...
      FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'authenticator'] LOOP
        FOREACH p IN ARRAY v_privs LOOP
          IF has_table_privilege(r, 'public.' || t, p) THEN
            RAISE EXCEPTION 'CL-ACL postcondition: % still holds % on public.%', r, p, t;
          END IF;
        END LOOP;
        -- ... nor a column privilege, which has_table_privilege cannot see.
        FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
          IF has_any_column_privilege(r, 'public.' || t, p) THEN
            RAISE EXCEPTION 'CL-ACL postcondition: % still holds column-level % on public.%', r, p, t;
          END IF;
        END LOOP;
      END LOOP;
      IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                  WHERE c.oid = ('public.' || t)::regclass AND a.grantee = 0) THEN
        RAISE EXCEPTION 'CL-ACL postcondition: PUBLIC still holds a privilege on public.%', t;
      END IF;
      -- PRESENT: the application role keeps what the code needs.
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
        IF NOT has_table_privilege('service_role', 'public.' || t, p) THEN
          RAISE EXCEPTION 'CL-ACL postcondition: service_role lacks % on public.%', p, t;
        END IF;
      END LOOP;
    END LOOP;
    -- The trigger still fires through the (now client-closed) function.
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.learning_memory'::regclass
                    AND tgname = 'learning_memory_set_updated_at' AND tgfoid = fn AND tgenabled <> 'D') THEN
      RAISE EXCEPTION 'CL-ACL postcondition: learning_memory_set_updated_at is missing, disabled or not on set_content_updated_at()';
    END IF;
  ELSE
    RAISE EXCEPTION 'CL-ACL postcondition: preflight mode not set (%)', v_mode;
  END IF;

  -- UNCHANGED: RLS flags, policies, service_role/owner ACL entries of the tables.
  SELECT coalesce(string_agg(c.relname || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text || '|'
      || (SELECT coalesce(string_agg(p2.polname || ':' || p2.polcmd::text || ':' || p2.polpermissive::text || ':'
                 || p2.polroles::text || ':' || coalesce(pg_get_expr(p2.polqual, p2.polrelid), '') || ':'
                 || coalesce(pg_get_expr(p2.polwithcheck, p2.polrelid), ''), ';' ORDER BY p2.polname), '')
            FROM pg_policy p2 WHERE p2.polrelid = c.oid) || '|'
      || (SELECT coalesce(string_agg(a.grantee::regrole::text || '=' || a.privilege_type || '/' || a.grantor::regrole::text,
                 ',' ORDER BY a.grantee::regrole::text, a.privilege_type, a.grantor::regrole::text), '')
            FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
           WHERE a.grantee <> 0 AND a.grantee::regrole::text NOT IN ('anon', 'authenticated', 'authenticator')),
      E'\n' ORDER BY c.relname), '<no tables>')
    INTO v_now
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (tabs);
  IF v_now IS DISTINCT FROM current_setting('cl_acl.pre', true) THEN
    RAISE EXCEPTION 'CL-ACL postcondition: RLS flags, policies or non-client ACL entries changed (before: %, after: %)',
      current_setting('cl_acl.pre', true), v_now;
  END IF;

  -- Function: closed to clients, pinned, otherwise unchanged.
  IF fn IS NOT NULL THEN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'authenticator'] LOOP
      IF has_function_privilege(r, fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'CL-ACL postcondition: % can still EXECUTE public.set_content_updated_at()', r;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = fn AND a.grantee = 0) THEN
      RAISE EXCEPTION 'CL-ACL postcondition: PUBLIC can still EXECUTE public.set_content_updated_at()';
    END IF;
    IF (SELECT proconfig FROM pg_proc WHERE oid = fn) IS DISTINCT FROM '{"search_path=pg_catalog, public"}'::text[] THEN
      RAISE EXCEPTION 'CL-ACL postcondition: public.set_content_updated_at() search_path not pinned (%)', (SELECT proconfig FROM pg_proc WHERE oid = fn);
    END IF;
  END IF;
  SELECT coalesce((
    SELECT p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || md5(p.prosrc) || '|'
      || (SELECT coalesce(string_agg(a.grantee::regrole::text || '=' || a.privilege_type || '/' || a.grantor::regrole::text,
                 ',' ORDER BY a.grantee::regrole::text, a.privilege_type, a.grantor::regrole::text), '')
            FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           WHERE a.grantee <> 0 AND a.grantee::regrole::text NOT IN ('anon', 'authenticated', 'authenticator'))
      FROM pg_proc p WHERE p.oid = fn), '<no function>')
    INTO v_now;
  IF v_now IS DISTINCT FROM current_setting('cl_acl.fn_pre', true) THEN
    RAISE EXCEPTION 'CL-ACL postcondition: set_content_updated_at() owner, definer flag, body or non-client ACL changed (before: %, after: %)',
      current_setting('cl_acl.fn_pre', true), v_now;
  END IF;

  RAISE NOTICE 'CL-ACL: verified (tables: %) - no client-role privilege, PUBLIC none, service_role/owner ACL, RLS and policies unchanged; set_content_updated_at() %',
    v_mode, CASE WHEN fn IS NULL THEN 'absent' ELSE 'client-closed and pinned' END;
END
$post$;

COMMIT;
