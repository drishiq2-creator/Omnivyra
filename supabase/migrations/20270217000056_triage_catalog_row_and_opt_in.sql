-- 20270217000056 - conversation triage: catalog row + OPT-IN (c6, was e1; OWNER rulings 2026-11-18 via virality-cb;
-- version from virality-cb; review: virality-7c).
--
-- THE RULINGS. (1) Triage is billed at a FIXED 1 credit per classified conversation - rate-independent, so NOT behind
-- the pricing hold. (2) Triage is OPT-IN: default OFF, so no company is charged for something it never chose.
--
-- 1. credit_cost_config 'conversation_triage' = 1. The worker charges through executeWithCredits with amountOverride 1
--    (conversationTriageWorker.ts); the row is the catalog/preview source and getCreditCost's answer. Deliberately NO
--    action_pricing_config row (it would make resolveActivityCreditRange treat the key as token-priced - the F3 defect);
--    the postcondition pins that absence, and the key is therefore absent from public.v_pricing_catalog - expected.
-- 2. engagement_system_controls.triage_engine_enabled: column default true -> FALSE. updateControls upserts only the
--    fields a caller passes, so with a true default a row written for ANY other engagement setting silently opted the
--    company into billed triage. Existing rows are switched OFF as well: a pre-existing true is indistinguishable from
--    the old default, and the ruling is that nobody is charged for something they never chose (C-pack: 0 rows in prod).
--    A company opts in afterwards by setting triage_engine_enabled = true explicitly.
--
-- No table is created; no GRANT changes. Rollback: rollbacks/triage_catalog_row_and_opt_in_rollback.sql.

DO $m056_pre$
DECLARE
  v_default text;
  v_on int;
BEGIN
  SELECT column_default INTO v_default FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'engagement_system_controls' AND column_name = 'triage_engine_enabled';
  IF v_default IS NULL THEN
    RAISE EXCEPTION '056 preflight: engagement_system_controls.triage_engine_enabled not found (or has no default)';
  END IF;
  SELECT count(*) INTO v_on FROM public.engagement_system_controls WHERE triage_engine_enabled;
  RAISE NOTICE '056 preflight: triage_engine_enabled default=%, rows currently ON=% (switched OFF below)', v_default, v_on;
END
$m056_pre$;

ALTER TABLE public.engagement_system_controls ALTER COLUMN triage_engine_enabled SET DEFAULT false;
UPDATE public.engagement_system_controls SET triage_engine_enabled = false, updated_at = now()
 WHERE triage_engine_enabled;

INSERT INTO public.credit_cost_config (action_type, credits, category, description, smart_dedup_seconds, activity_class)
VALUES ('conversation_triage', 1, 'low', 'Conversation triage, per classified conversation (20270217000056)', 0, 'REPLY')
ON CONFLICT (action_type) DO NOTHING;

DO $m056_post$
BEGIN
  IF (SELECT count(*) FROM public.credit_cost_config
       WHERE action_type = 'conversation_triage' AND credits = 1 AND category = 'low' AND smart_dedup_seconds = 0
         AND activity_class = 'REPLY' AND description = 'Conversation triage, per classified conversation (20270217000056)') <> 1 THEN
    RAISE EXCEPTION '056 postcondition: credit_cost_config conversation_triage is not exactly the ruled row (1 credit)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.action_pricing_config WHERE action_key = 'conversation_triage' AND is_active) THEN
    RAISE EXCEPTION '056 postcondition: an active action_pricing_config row for conversation_triage would make the preview token-priced';
  END IF;
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'engagement_system_controls' AND column_name = 'triage_engine_enabled')
     IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION '056 postcondition: triage_engine_enabled default is not false';
  END IF;
  IF EXISTS (SELECT 1 FROM public.engagement_system_controls WHERE triage_engine_enabled) THEN
    RAISE EXCEPTION '056 postcondition: a company is still opted in to triage';
  END IF;
END
$m056_post$;
