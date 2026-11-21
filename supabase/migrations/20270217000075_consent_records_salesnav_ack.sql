-- 20270217000075 consent_records_salesnav_ack (reserved by cb, registry eaadf8fd9)
--
-- b3 ruling (1), 2026-11-21: the Sales Navigator LINKEDIN-RESTRICTION ACKNOWLEDGEMENT is recorded in the EXISTING
-- append-only consent ledger (consent_records: only revoked_at/revoked_by may change after insert, DELETE blocked),
-- following the tenant-data-controller precedent (20270209000002). The evidence survives a disconnect.
-- One row per acknowledgement, in existing columns only (no new column):
--   capability      'salesnav_linkedin_restriction_ack'
--   platform        'salesnav:<transport>'   (extension | unipile | vayne | rpa) - the existing
--                   (organization_id, platform, capability, granted_at DESC) index serves the gate's read
--   consent_version the ack TEXT version; the gate requires a re-ack when it changes
--   granted_by / granted_at / organization_id   the user, the time, the company
--   metadata        { text_sha256, wording_status }
-- The ack TEXT is a PLACEHOLDER until counsel (wording_status 'placeholder'); recorded in the register.
-- Reader/writer: backend/services/salesNav/restrictionAck.ts. The gate fails CLOSED when the ledger is unreadable.
--
-- WHAT THIS DOES: replaces consent_records_capability_check with the SAME name and exactly one more value.
-- PRE-IMAGE (cb C160, read-only, after the 2026-11-21 ~01:49 UTC apply): production's check is EXACTLY the 8 values
-- below and convalidated. Any other value set, or an unvalidated check, REFUSES (drift: stop and reconcile - never
-- "just add a value").
--
-- LOCKING: the new CHECK is added NOT VALID and VALIDATED in this transaction. It is a strict superset of the
-- validated 8-value check it replaces, so every existing row satisfies it; the scan holds the ACCESS EXCLUSIVE lock
-- taken by the replace for its duration (consent_records is a low-volume ledger - cb to confirm the row count before
-- the apply ask; if it is large, the VALIDATE moves to its own file like 20270209000003).
--
-- ROLLBACK (rollbacks/consent_records_salesnav_ack_rollback.sql) is valid ONLY before the first acknowledgement
-- row: narrowing the check back to 8 would fail on such a row, and the ledger is append-only, so it cannot be
-- deleted. The rollback REFUSES with the row count when any exists.
--
-- APPLIED STATUS: this version has never been applied anywhere.

BEGIN;

CREATE TEMP TABLE _snack_trigger_preimage ON COMMIT DROP AS
  SELECT t.tgname::text AS tgname, t.tgenabled::text AS tgenabled, t.tgtype::int AS tgtype,
         p.oid::regprocedure::text AS fn, md5(replace(p.prosrc, E'\r', '')) AS body_md5
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgrelid = to_regclass('public.consent_records')
     AND t.tgname IN ('consent_records_append_only', 'consent_records_no_delete');

DO $pre$
DECLARE
  v text[]; v_valid boolean; v_n integer;
BEGIN
  IF to_regclass('public.consent_records') IS NULL THEN
    RAISE EXCEPTION 'salesnav ack precondition: public.consent_records does not exist';
  END IF;
  SELECT array_agg(m[1] ORDER BY m[1]), bool_and(c.convalidated) INTO v, v_valid
    FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.consent_records'::regclass
     AND c.conname = 'consent_records_capability_check';
  IF v IS DISTINCT FROM ARRAY['ingest_comments','ingest_communities','ingest_dms','ingest_mentions','listen',
                              'monitor_competitors','publish','tenant_data_controller_ack']::text[] THEN
    RAISE EXCEPTION 'salesnav ack precondition: consent_records_capability_check is %, expected EXACTLY the 8 values of the 2026-11-21 apply (drift: stop and reconcile)', v;
  END IF;
  IF v_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'salesnav ack precondition: consent_records_capability_check is NOT VALIDATED (20270209000003 not applied?) - stop';
  END IF;
  SELECT count(*) INTO v_n FROM _snack_trigger_preimage;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'salesnav ack precondition: expected both append-only triggers on consent_records, found %', v_n;
  END IF;
END
$pre$;

ALTER TABLE public.consent_records DROP CONSTRAINT IF EXISTS consent_records_capability_check;
ALTER TABLE public.consent_records ADD CONSTRAINT consent_records_capability_check
  CHECK (capability IN (
    'publish', 'listen', 'monitor_competitors',
    'ingest_dms', 'ingest_comments', 'ingest_mentions', 'ingest_communities',
    'tenant_data_controller_ack',
    'salesnav_linkedin_restriction_ack'
  )) NOT VALID;
ALTER TABLE public.consent_records VALIDATE CONSTRAINT consent_records_capability_check;

DO $post$
DECLARE
  v text[]; v_valid boolean; v_drift text;
BEGIN
  -- EXACTLY 9 values (set equality, not containment), validated.
  SELECT array_agg(m[1] ORDER BY m[1]), bool_and(c.convalidated) INTO v, v_valid
    FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.consent_records'::regclass
     AND c.conname = 'consent_records_capability_check';
  IF v IS DISTINCT FROM ARRAY['ingest_comments','ingest_communities','ingest_dms','ingest_mentions','listen',
                              'monitor_competitors','publish','salesnav_linkedin_restriction_ack',
                              'tenant_data_controller_ack']::text[] THEN
    RAISE EXCEPTION 'salesnav ack postcondition: consent_records_capability_check is %, expected EXACTLY the 9 values', v;
  END IF;
  IF v_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'salesnav ack postcondition: consent_records_capability_check is not validated';
  END IF;

  -- The append-only premise is UNCHANGED by this migration: same triggers, same enabled state and type, same function,
  -- same body (md5 of prosrc, CR-stripped) as the pre-image taken at the top of this transaction - and still enabled
  -- for ordinary writes ('O' origin / 'A' always).
  SELECT string_agg(coalesce(a.tgname, b.tgname), ', ') INTO v_drift
    FROM _snack_trigger_preimage a
    FULL JOIN (
      SELECT t.tgname::text AS tgname, t.tgenabled::text AS tgenabled, t.tgtype::int AS tgtype,
             p.oid::regprocedure::text AS fn, md5(replace(p.prosrc, E'\r', '')) AS body_md5
        FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'public.consent_records'::regclass
         AND t.tgname IN ('consent_records_append_only', 'consent_records_no_delete')
    ) b ON a.tgname = b.tgname
   WHERE a.tgname IS NULL OR b.tgname IS NULL OR a.tgenabled <> b.tgenabled OR a.tgtype <> b.tgtype
      OR a.fn <> b.fn OR a.body_md5 <> b.body_md5;
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'salesnav ack postcondition: append-only trigger(s) changed during this migration: %', v_drift;
  END IF;
  IF EXISTS (SELECT 1 FROM _snack_trigger_preimage WHERE tgenabled NOT IN ('O', 'A')) THEN
    RAISE EXCEPTION 'salesnav ack postcondition: an append-only trigger is not enabled for ordinary writes';
  END IF;

  RAISE NOTICE 'salesnav ack: consent_records_capability_check is exactly 9 values, validated; both append-only triggers unchanged (enabled, type, function, body md5).';
END
$post$;

COMMIT;
