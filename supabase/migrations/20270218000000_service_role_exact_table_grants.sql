-- service_role holds EXACTLY the table privileges its code paths need on five applied tables
-- (version 20270218000000, proposed by virality-a9 2026-11-21 for cb's registry; stage-0 line).
--
-- WHY. Supabase's default ACL grants service_role ALL on every new table. Five migrations applied
-- with EXPAND-35 (2026-11-21) revoked from the client roles and then GRANTed a narrow set to
-- service_role, but never revoked from service_role, so the GRANT narrowed nothing. C163 (cb, live
-- ACL, 2026-11-21) confirms service_role holds DELETE and TRUNCATE on all five today. Found by
-- CI-842 (the realschema harness now emulates the default ACL). Applied files are immutable, so
-- this forward migration does the narrowing.
--
-- INTENDED SETS (rulings: 89 for its four tables, b3 for extension_account_bindings - grant only
-- what code needs, the C163 lesson):
--   extension_account_bindings            SELECT, INSERT          (a9; extension15/index.ts:70 select,
--                                                                  :90 insert; never updated or deleted -
--                                                                  20270207000000:12,64)
--   contact_opt_out_reviews               SELECT, INSERT, UPDATE  (89; optOutReview.ts)
--   contact_opt_out_review_activity_days  SELECT, INSERT, UPDATE  (89; optOutReview.ts)
--   contact_opt_out_review_reanchors      SELECT                  (89; written only by the SECURITY
--                                                                  DEFINER g11_reanchor_pending_opt_out_reviews,
--                                                                  which runs as the owner)
--   execution_journey_decisions           SELECT, INSERT          (89; append-only by a row trigger, and
--                                                                  TRUNCATE bypasses row triggers)
-- Unaffected: SECURITY DEFINER writers and FK actions (CASCADE / SET NULL) run with the table
-- OWNER's rights, not service_role's; RLS policies are untouched; client roles are untouched.
--
-- FAIL CLOSED. A missing table refuses the whole file (nothing changed). The postcondition checks
-- every table privilege BOTH ways: present exactly for the intended set, absent otherwise
-- (including MAINTAIN on PostgreSQL 17+).

BEGIN;

DO $preflight$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['extension_account_bindings', 'contact_opt_out_reviews',
                           'contact_opt_out_review_activity_days', 'contact_opt_out_review_reanchors',
                           'execution_journey_decisions'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'service_role exact grants preflight: public.% does not exist - nothing changed', t;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'service_role exact grants preflight: role service_role does not exist - nothing changed';
  END IF;
END
$preflight$;

REVOKE ALL ON TABLE public.extension_account_bindings FROM service_role;
GRANT SELECT, INSERT ON TABLE public.extension_account_bindings TO service_role;

REVOKE ALL ON TABLE public.contact_opt_out_reviews FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.contact_opt_out_reviews TO service_role;

REVOKE ALL ON TABLE public.contact_opt_out_review_activity_days FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.contact_opt_out_review_activity_days TO service_role;

REVOKE ALL ON TABLE public.contact_opt_out_review_reanchors FROM service_role;
GRANT SELECT ON TABLE public.contact_opt_out_review_reanchors TO service_role;

REVOKE ALL ON TABLE public.execution_journey_decisions FROM service_role;
GRANT SELECT, INSERT ON TABLE public.execution_journey_decisions TO service_role;

DO $postcondition$
DECLARE
  v_privs text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_bad   text[] := ARRAY[]::text[];
  r       record;
  p       text;
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    v_privs := array_append(v_privs, 'MAINTAIN');
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('extension_account_bindings',           ARRAY['SELECT', 'INSERT']),
      ('contact_opt_out_reviews',              ARRAY['SELECT', 'INSERT', 'UPDATE']),
      ('contact_opt_out_review_activity_days', ARRAY['SELECT', 'INSERT', 'UPDATE']),
      ('contact_opt_out_review_reanchors',     ARRAY['SELECT']),
      ('execution_journey_decisions',          ARRAY['SELECT', 'INSERT'])
    ) AS x(tbl, granted) LOOP
    FOREACH p IN ARRAY v_privs LOOP
      IF has_table_privilege('service_role', 'public.' || r.tbl, p) IS DISTINCT FROM (p = ANY (r.granted)) THEN
        v_bad := v_bad || format('%s %s %s', r.tbl, p,
                                 CASE WHEN p = ANY (r.granted) THEN 'missing' ELSE 'still held' END);
      END IF;
    END LOOP;
  END LOOP;
  IF array_length(v_bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'service_role exact grants postcondition: %', array_to_string(v_bad, '; ');
  END IF;
END
$postcondition$;

COMMIT;
