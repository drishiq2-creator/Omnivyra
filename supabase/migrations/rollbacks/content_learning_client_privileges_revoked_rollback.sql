-- ROLLBACK for 20270301000010_content_learning_client_privileges_revoked.sql
--
-- RE-OPENS THE EXPOSURE the migration closes. Run only on an explicit owner
-- instruction, and only to restore service after a proven regression.
--
-- Restores production's pre-image as read on 2026-11-27 (read-only, phase-3 D,
-- out/d01_content_tables.json, out/d02_function_and_roles.json):
--   content_performance, content_prediction, learning_intelligence, learning_memory:
--     relacl {postgres=arwdDxtm/postgres, authenticated=arwdxtm/postgres, service_role=arwdDxtm/postgres}
--     -> authenticated gets back exactly a r w d x t m (INSERT SELECT UPDATE DELETE
--        REFERENCES TRIGGER MAINTAIN; NOT TRUNCATE), granted by postgres.
--   public.set_content_updated_at():
--     proacl {postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}, proconfig NULL.
-- PUBLIC, anon and authenticator held nothing before, so nothing is granted to them.
-- Run as postgres (the grantor of the pre-image). One transaction; the
-- postcondition compares the restored ACL with the pre-image as a set.

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE
  public.content_performance, public.content_prediction, public.learning_intelligence, public.learning_memory
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_content_updated_at() TO authenticated;
ALTER FUNCTION public.set_content_updated_at() RESET search_path;

DO $verify$
DECLARE
  t text;
  got text;
BEGIN
  FOREACH t IN ARRAY ARRAY['content_performance', 'content_prediction', 'learning_intelligence', 'learning_memory'] LOOP
    SELECT string_agg(a.grantee::regrole::text || '=' || a.privilege_type || '/' || a.grantor::regrole::text, ','
                      ORDER BY a.grantee::regrole::text, a.privilege_type)
      INTO got
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid = ('public.' || t)::regclass AND a.grantee <> 0
       AND a.grantee::regrole::text IN ('anon', 'authenticated', 'authenticator');
    IF got IS DISTINCT FROM 'authenticated=DELETE/postgres,authenticated=INSERT/postgres,authenticated=MAINTAIN/postgres,'
        || 'authenticated=REFERENCES/postgres,authenticated=SELECT/postgres,authenticated=TRIGGER/postgres,authenticated=UPDATE/postgres' THEN
      RAISE EXCEPTION 'CL-ACL rollback: public.% client ACL is % (expected the 2026-11-27 pre-image)', t, got;
    END IF;
  END LOOP;
  IF (SELECT proconfig FROM pg_proc WHERE oid = 'public.set_content_updated_at()'::regprocedure) IS NOT NULL
     OR NOT has_function_privilege('authenticated', 'public.set_content_updated_at()', 'EXECUTE') THEN
    RAISE EXCEPTION 'CL-ACL rollback: set_content_updated_at() not restored to the pre-image';
  END IF;
END
$verify$;

COMMIT;
