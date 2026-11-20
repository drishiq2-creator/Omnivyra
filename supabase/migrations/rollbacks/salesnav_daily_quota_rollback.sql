-- ROLLBACK for 20270217000074_salesnav_daily_quota.sql
--
-- Drops the consume function, then the table. LOSSY: today's consumed counts are erased, so a member could read up
-- to a fresh cap again the same day - run it only with every Sales Navigator transport switched OFF (the
-- salesnav_extraction and salesnav_transport_<t> flags) so nothing reads while the cap is absent.

BEGIN;

DROP FUNCTION IF EXISTS public.salesnav_consume_daily_quota(uuid, text, date, integer, integer);
DROP TABLE IF EXISTS public.salesnav_daily_quota;

DO $verify$
BEGIN
  IF to_regclass('public.salesnav_daily_quota') IS NOT NULL THEN
    RAISE EXCEPTION 'SNQ rollback postcondition: salesnav_daily_quota still exists';
  END IF;
  IF to_regprocedure('public.salesnav_consume_daily_quota(uuid, text, date, integer, integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'SNQ rollback postcondition: salesnav_consume_daily_quota still exists';
  END IF;
END
$verify$;

COMMIT;
