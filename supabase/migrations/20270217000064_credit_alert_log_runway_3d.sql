-- 20270217000064_credit_alert_log_runway_3d (c6, 2026-11-20). Version reserved by cb (rc-attest 6600c3488); review: 7c.
--
-- Widens credit_alert_log.alert_type CHECK with the 3-day runway warning types (owner promise 2026-11-14):
--   'runway_3d'         - "your credits will run out in about N days" (creditAlertService, dedup row);
--   'runway_3d_cleared' - the RE-ARM marker, written when the runway recovers so the next drop warns again.
--
-- PRECONDITION (cb C127, prod read 2026-11-20): the live constraint is VALIDATED and its definition is EXACTLY the
-- 12-value list of 20260831_credit_alert_velocity_type (same order; also what supabase/_schema/baseline.sql restores
-- in CI). Anything else RAISES and nothing changes: a drifted constraint must be re-read, never overwritten.
-- EXPAND ONLY: every existing value stays allowed, so no existing row can violate the new CHECK (prod had 0 rows).
-- DEPLOY ORDER: DB first. App-first fails closed: the runway insert is refused and creditAlertService reports the
-- unwritten dedup row as an alertable event (3117944e9), it never drops it silently.
-- Table posture (RLS, grants) is unchanged - only the CHECK is replaced.
-- Rollback: supabase/migrations/rollbacks/credit_alert_log_runway_3d_rollback.sql

DO $preflight$
DECLARE
  v_def text;
  v_valid boolean;
BEGIN
  SELECT pg_get_constraintdef(oid), convalidated INTO v_def, v_valid
    FROM pg_constraint
   WHERE conrelid = 'public.credit_alert_log'::regclass AND conname = 'credit_alert_log_alert_type_check' AND contype = 'c';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '064 preflight: credit_alert_log_alert_type_check is missing - nothing changed';
  END IF;
  IF v_def IS DISTINCT FROM 'CHECK ((alert_type = ANY (ARRAY[''low_20pct''::text, ''low_10pct''::text, ''depleted''::text, ''auto_topup''::text, ''low_100''::text, ''low_50''::text, ''low_20''::text, ''velocity_200''::text, ''consumed_80''::text, ''consumed_90''::text, ''consumed_95''::text, ''forecast_insufficient_85''::text])))' THEN
    RAISE EXCEPTION '064 preflight: credit_alert_log_alert_type_check is not the known 12-value list (live: %) - nothing changed', v_def;
  END IF;
  IF NOT v_valid THEN
    RAISE EXCEPTION '064 preflight: credit_alert_log_alert_type_check is NOT VALID - nothing changed';
  END IF;
END
$preflight$;

ALTER TABLE public.credit_alert_log
  DROP CONSTRAINT credit_alert_log_alert_type_check;

ALTER TABLE public.credit_alert_log
  ADD CONSTRAINT credit_alert_log_alert_type_check CHECK (alert_type IN (
    'low_20pct', 'low_10pct', 'depleted', 'auto_topup',
    'low_100', 'low_50', 'low_20', 'velocity_200',
    'consumed_80', 'consumed_90', 'consumed_95', 'forecast_insufficient_85',
    'runway_3d', 'runway_3d_cleared'
  ));

DO $verify$
DECLARE
  v_def text;
  v_valid boolean;
BEGIN
  SELECT pg_get_constraintdef(oid), convalidated INTO v_def, v_valid
    FROM pg_constraint
   WHERE conrelid = 'public.credit_alert_log'::regclass AND conname = 'credit_alert_log_alert_type_check' AND contype = 'c';
  IF v_def IS DISTINCT FROM 'CHECK ((alert_type = ANY (ARRAY[''low_20pct''::text, ''low_10pct''::text, ''depleted''::text, ''auto_topup''::text, ''low_100''::text, ''low_50''::text, ''low_20''::text, ''velocity_200''::text, ''consumed_80''::text, ''consumed_90''::text, ''consumed_95''::text, ''forecast_insufficient_85''::text, ''runway_3d''::text, ''runway_3d_cleared''::text])))'
     OR NOT v_valid THEN
    RAISE EXCEPTION '064 postcondition: credit_alert_log_alert_type_check is not the validated 14-value list (live: %)', v_def;
  END IF;
END
$verify$;
