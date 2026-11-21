-- ROLLBACK for 20270217000075_consent_records_salesnav_ack.sql
--
-- VALID ONLY BEFORE THE FIRST ACKNOWLEDGEMENT ROW. consent_records is append-only (DELETE blocked by trigger), so a
-- 'salesnav_linkedin_restriction_ack' row can never be removed, and narrowing the check would fail on it. This file
-- therefore REFUSES, with the count, when any such row exists - it never fails mid-way.
-- Restores the exact 8-value check of the 2026-11-21 apply, validated.

BEGIN;

DO $pre$
DECLARE v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.consent_records WHERE capability = 'salesnav_linkedin_restriction_ack';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'salesnav ack rollback REFUSED: % acknowledgement row(s) exist in the append-only ledger; the 9-value check must stay', v_n;
  END IF;
END
$pre$;

ALTER TABLE public.consent_records DROP CONSTRAINT IF EXISTS consent_records_capability_check;
ALTER TABLE public.consent_records ADD CONSTRAINT consent_records_capability_check
  CHECK (capability IN (
    'publish', 'listen', 'monitor_competitors',
    'ingest_dms', 'ingest_comments', 'ingest_mentions', 'ingest_communities',
    'tenant_data_controller_ack'
  )) NOT VALID;
ALTER TABLE public.consent_records VALIDATE CONSTRAINT consent_records_capability_check;

DO $verify$
DECLARE v text[];
BEGIN
  SELECT array_agg(m[1] ORDER BY m[1]) INTO v
    FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.consent_records'::regclass AND c.conname = 'consent_records_capability_check' AND c.convalidated;
  IF v IS DISTINCT FROM ARRAY['ingest_comments','ingest_communities','ingest_dms','ingest_mentions','listen',
                              'monitor_competitors','publish','tenant_data_controller_ack']::text[] THEN
    RAISE EXCEPTION 'salesnav ack rollback postcondition: check is %, expected the 8 values, validated', v;
  END IF;
END
$verify$;

COMMIT;
