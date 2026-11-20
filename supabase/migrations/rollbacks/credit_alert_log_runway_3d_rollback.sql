-- Rollback of 20270217000064_credit_alert_log_runway_3d (c6). Restores the 12-value CHECK of
-- 20260831_credit_alert_velocity_type. Roll the runway code back FIRST (it writes runway_* rows).
-- It REFUSES if any runway_* row exists: narrowing the CHECK would fail on it, and deleting alert history is a separate,
-- owner-approved decision - never a side effect of a rollback.
DO $rollback$
DECLARE
  v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.credit_alert_log WHERE alert_type IN ('runway_3d', 'runway_3d_cleared');
  IF v_rows > 0 THEN
    RAISE EXCEPTION '064 rollback: % runway_* row(s) exist - the CHECK cannot be narrowed; nothing changed (owner decision)', v_rows;
  END IF;
  ALTER TABLE public.credit_alert_log DROP CONSTRAINT credit_alert_log_alert_type_check;
  ALTER TABLE public.credit_alert_log
    ADD CONSTRAINT credit_alert_log_alert_type_check CHECK (alert_type IN (
      'low_20pct', 'low_10pct', 'depleted', 'auto_topup',
      'low_100', 'low_50', 'low_20', 'velocity_200',
      'consumed_80', 'consumed_90', 'consumed_95', 'forecast_insufficient_85'
    ));
END
$rollback$;
