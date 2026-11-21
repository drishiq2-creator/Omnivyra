-- ROLLBACK for 20270217000073_salesnav_extraction_runs.sql
--
-- 074 (salesnav_daily_quota) depends on salesnav_member_owner: roll 074 back FIRST (its rollback file), then this.
-- LOSSY: run history, member ownership and bindings are erased. Run only with every Sales Navigator transport
-- switched OFF (the salesnav_extraction and salesnav_transport_<t> flags).

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.salesnav_consume_daily_quota(uuid, text, date, integer, integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'SNR rollback precondition: 074 salesnav_consume_daily_quota still exists - roll 074 back first';
  END IF;
END
$pre$;

DROP TABLE IF EXISTS public.salesnav_extraction_runs;
DROP TABLE IF EXISTS public.salesnav_member_bindings;
DROP TABLE IF EXISTS public.salesnav_member_owner;

DO $verify$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['salesnav_extraction_runs', 'salesnav_member_bindings', 'salesnav_member_owner'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      RAISE EXCEPTION 'SNR rollback postcondition: % still exists', t;
    END IF;
  END LOOP;
END
$verify$;

COMMIT;
