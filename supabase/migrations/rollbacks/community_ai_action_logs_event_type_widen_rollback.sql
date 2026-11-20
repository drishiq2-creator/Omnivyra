-- Rollback for 20270217000071_community_ai_action_logs_event_type_widen.sql (a9).
-- Restores the 6-value event_type CHECK. REFUSES if any row already holds a value 071 added
-- ('skipped_due_to_platform_policy' or 'sent_unverified'): narrowing
-- would then either fail or require deleting audit rows, and a rollback must never destroy them. Re-deciding what to do
-- with such rows is a separate, owner-approved step. Run only with the code that logs the value reverted (the writer
-- tolerates a refused insert: logged COMMUNITY_AI_ACTION_LOG_FAILED and counted).
DO $narrow$
BEGIN
  IF EXISTS (SELECT 1 FROM public.community_ai_action_logs WHERE event_type IN ('skipped_due_to_platform_policy', 'sent_unverified')) THEN
    RAISE EXCEPTION '071 rollback: rows with an event_type added by 071 exist - nothing changed';
  END IF;
  ALTER TABLE public.community_ai_action_logs DROP CONSTRAINT community_ai_action_logs_event_type_check;
  ALTER TABLE public.community_ai_action_logs
    ADD CONSTRAINT community_ai_action_logs_event_type_check CHECK (event_type IN (
      'approved', 'executed', 'failed', 'skipped', 'scheduled', 'auto_executed'
    ));
END
$narrow$;
