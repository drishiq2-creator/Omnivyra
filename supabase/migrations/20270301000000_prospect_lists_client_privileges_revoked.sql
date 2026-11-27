-- ============================================================================
-- SECURITY — prospect_lists / prospect_list_members: no client-role privilege
-- (version 20270301000000) · prepared 2026-11-26 · NOT YET APPLIED ANYWHERE
-- ============================================================================
--
-- WHY. 20261127000000_pi_prospect_lists.sql (PI LISTS-001) creates both tables
-- with RLS on and one `auth.role() = 'service_role'` policy each, but it carries
-- NO GRANT/REVOKE at all, so a database's DEFAULT privileges decide the ACL.
-- The enumerative #23 revoke (20270111000002, 50 tables) protects only the
-- tables it names, and these two are not among them. This file gives them the
-- same end state as the tenant tables 20270111000002 closed (canonical_leads,
-- campaigns, content): nothing for PUBLIC, anon, authenticated or authenticator;
-- service_role and the owner as they are.
--
-- PRODUCTION STATE (read-only, not contacted by this file)
--   2026-11-10 D1 catalogue read (closure-r15 D1-EXECUTION-RECORD.json q16):
--     both tables {postgres=arwdDxtm, authenticated=arwdxtm, service_role=arwdDxtm}
--   2026-11-26 read-only check (phase-2 Agent A):
--     both tables {postgres=arwdDxtm, service_role=arwdDxtm} — the authenticated
--     entry was revoked out of band in between, with no migration recording it.
--   So against production today this file is a NO-OP (every REVOKE removes
--   nothing), and its value is that the repository, a fresh replay and every
--   other environment reach the production end state through a migration.
--   An environment whose default ACL still grants `authenticated` on new tables
--   (production did on 2026-11-10; supabase_admin's defaults grant anon and
--   authenticated everything) is closed by it.
--
-- WHY THIS CANNOT BREAK THE APPLICATION
--   * No code on main reads or writes either table. On the stranded line the
--     only reader/writer is backend/services/prospectLists/store.ts, entirely
--     through ownedDbTable() (backend/db/writeOwner.ts -> the service-role
--     client). The browser has no table access (lib/supabaseBrowser.ts).
--   * service_role is NOT touched: it keeps exactly what it holds (production:
--     arwdDxtm). Narrowing it (C163 class: the code needs SELECT, INSERT, UPDATE
--     only — no delete path, soft removal, archive-not-delete) is a separate
--     owner decision and would NOT be a no-op against production.
--   * FK actions (ON DELETE CASCADE from companies / canonical_leads) and the
--     touch trigger run with the owner's rights, not a client's.
--   * Policies and RLS flags are NOT changed (asserted below). Without a table
--     privilege the `TO public` policies are moot for client roles.
--
-- WHAT THIS DOES
--   REVOKE ALL (not a list: PostgreSQL 17 adds MAINTAIN) on both tables FROM
--   PUBLIC, anon, authenticated, authenticator. Nothing is granted to anyone.
--
-- FAIL CLOSED. A missing table or role refuses the whole file (nothing changed):
--   recording this version where the tables do not exist would leave them to be
--   created later under the default ACL with nothing to close them.
-- IDEMPOTENT. REVOKE is re-runnable; the preflight asserts structure only, never
--   the pre-change ACL, so it passes on a fresh replay, on production and on a
--   second run.
-- POSTCONDITION, both ways: every client role holds NO table or column
--   privilege (MAINTAIN on PG17+), PUBLIC has no ACL entry; service_role still
--   holds SELECT, INSERT, UPDATE (the application's need); the service_role and
--   owner ACL entries, RLS flags and policies are byte-for-byte unchanged.
--
-- APPLY  (after explicit authorization only)
--   *** DO NOT RUN `supabase db push`. *** psql -v ON_ERROR_STOP=1 -f <this file>
--   per docs/migration-discipline.md. Own transaction; catalog-only change.
-- ROLLBACK
--   None, deliberately. Production's pre-image equals its post-image (no client
--   entry on 2026-11-26), so there is nothing to restore; re-granting a client
--   privilege anywhere would re-open the exposure this file closes.
-- ============================================================================

BEGIN;

DO $preflight$
DECLARE
  t text;
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'authenticator', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      RAISE EXCEPTION 'PL-ACL preflight: role % does not exist - nothing changed', r;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['prospect_lists', 'prospect_list_members'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'PL-ACL preflight: public.% does not exist (20261127000000 not applied?) - nothing changed', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'PL-ACL preflight: row level security is not enabled on public.%', t;
    END IF;
    -- Realtime delivers rows to client roles through their SELECT privilege.
    IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE EXCEPTION 'PL-ACL preflight: public.% is in a publication; a realtime consumer would lose access', t;
    END IF;
  END LOOP;

  -- Snapshot for the postcondition: RLS flags, policies, and every ACL entry
  -- that is NOT a client role (service_role, postgres, ...) must be unchanged.
  PERFORM set_config('pl_acl.pre', (
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
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('prospect_lists', 'prospect_list_members')), true);
END
$preflight$;

REVOKE ALL ON TABLE public.prospect_lists        FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON TABLE public.prospect_list_members FROM PUBLIC, anon, authenticated, authenticator;
-- This migration grants nothing to any role.

DO $post$
DECLARE
  t text;
  r text;
  p text;
  v_privs text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_now text;
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    v_privs := array_append(v_privs, 'MAINTAIN');
  END IF;
  FOREACH t IN ARRAY ARRAY['prospect_lists', 'prospect_list_members'] LOOP
    -- ABSENT: no client role holds any table privilege ...
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'authenticator'] LOOP
      FOREACH p IN ARRAY v_privs LOOP
        IF has_table_privilege(r, 'public.' || t, p) THEN
          RAISE EXCEPTION 'PL-ACL postcondition: % still holds % on public.%', r, p, t;
        END IF;
      END LOOP;
      -- ... nor a column privilege, which has_table_privilege cannot see.
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(r, 'public.' || t, p) THEN
          RAISE EXCEPTION 'PL-ACL postcondition: % still holds column-level % on public.%', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                WHERE c.oid = ('public.' || t)::regclass AND a.grantee = 0) THEN
      RAISE EXCEPTION 'PL-ACL postcondition: PUBLIC still holds a privilege on public.%', t;
    END IF;
    -- PRESENT: the application role keeps what the code needs.
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
      IF NOT has_table_privilege('service_role', 'public.' || t, p) THEN
        RAISE EXCEPTION 'PL-ACL postcondition: service_role lacks % on public.%', p, t;
      END IF;
    END LOOP;
  END LOOP;

  -- UNCHANGED: RLS flags, policies, service_role/owner ACL entries.
  SELECT string_agg(c.relname || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text || '|'
      || (SELECT coalesce(string_agg(p2.polname || ':' || p2.polcmd::text || ':' || p2.polpermissive::text || ':'
                 || p2.polroles::text || ':' || coalesce(pg_get_expr(p2.polqual, p2.polrelid), '') || ':'
                 || coalesce(pg_get_expr(p2.polwithcheck, p2.polrelid), ''), ';' ORDER BY p2.polname), '')
            FROM pg_policy p2 WHERE p2.polrelid = c.oid) || '|'
      || (SELECT coalesce(string_agg(a.grantee::regrole::text || '=' || a.privilege_type || '/' || a.grantor::regrole::text,
                 ',' ORDER BY a.grantee::regrole::text, a.privilege_type, a.grantor::regrole::text), '')
            FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
           WHERE a.grantee <> 0 AND a.grantee::regrole::text NOT IN ('anon', 'authenticated', 'authenticator')),
      E'\n' ORDER BY c.relname)
    INTO v_now
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('prospect_lists', 'prospect_list_members');
  IF v_now IS DISTINCT FROM current_setting('pl_acl.pre', true) OR v_now IS NULL THEN
    RAISE EXCEPTION 'PL-ACL postcondition: RLS flags, policies or non-client ACL entries changed (before: %, after: %)',
      current_setting('pl_acl.pre', true), v_now;
  END IF;
  RAISE NOTICE 'PL-ACL: prospect_lists, prospect_list_members verified - no client-role privilege, PUBLIC none, service_role/owner ACL, RLS and policies unchanged';
END
$post$;

COMMIT;
