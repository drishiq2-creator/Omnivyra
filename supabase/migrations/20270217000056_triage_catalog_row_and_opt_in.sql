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
-- 2. OWNER 2026-11-18 (via b3): inbox AI is OPT-IN - EVERY engagement AI control's column default true -> FALSE
--    (auto_reply, bulk_reply, ai_suggestions, triage_engine, opportunity_detection, response_strategy_learning,
--    digest_generation). updateControls upserts only the fields a caller passes, so with true defaults a row written for
--    ONE setting silently switched the others on. The app's DEFAULTS (no row) are all off in the same change.
--    Existing rows: triage_engine_enabled is switched OFF (billed; a pre-existing true is indistinguishable from the old
--    default); the other columns keep their stored values (b3: no existing org has a row; C-pack: 0 rows).
--    A company opts in afterwards by switching a control on explicitly in settings.
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

ALTER TABLE public.engagement_system_controls ALTER COLUMN auto_reply_enabled SET DEFAULT false;
ALTER TABLE public.engagement_system_controls ALTER COLUMN bulk_reply_enabled SET DEFAULT false;
ALTER TABLE public.engagement_system_controls ALTER COLUMN ai_suggestions_enabled SET DEFAULT false;
ALTER TABLE public.engagement_system_controls ALTER COLUMN triage_engine_enabled SET DEFAULT false;
ALTER TABLE public.engagement_system_controls ALTER COLUMN opportunity_detection_enabled SET DEFAULT false;
ALTER TABLE public.engagement_system_controls ALTER COLUMN response_strategy_learning_enabled SET DEFAULT false;
ALTER TABLE public.engagement_system_controls ALTER COLUMN digest_generation_enabled SET DEFAULT false;
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
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'engagement_system_controls'
                AND column_name IN ('auto_reply_enabled', 'bulk_reply_enabled', 'ai_suggestions_enabled', 'triage_engine_enabled', 'opportunity_detection_enabled', 'response_strategy_learning_enabled', 'digest_generation_enabled')
                AND column_default IS DISTINCT FROM 'false') THEN
    RAISE EXCEPTION '056 postcondition: an engagement AI control does not default to false (opt-in)';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'engagement_system_controls'
         AND column_name IN ('auto_reply_enabled', 'bulk_reply_enabled', 'ai_suggestions_enabled', 'triage_engine_enabled', 'opportunity_detection_enabled', 'response_strategy_learning_enabled', 'digest_generation_enabled')) <> 7 THEN
    RAISE EXCEPTION '056 postcondition: expected the 7 engagement AI control columns';
  END IF;
  IF EXISTS (SELECT 1 FROM public.engagement_system_controls WHERE triage_engine_enabled) THEN
    RAISE EXCEPTION '056 postcondition: a company is still opted in to triage';
  END IF;
END
$m056_post$;
