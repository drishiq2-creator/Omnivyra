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
-- The postcondition also ASSERTS the unique index that makes a first classification charge exactly once (7c).
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
  -- b3/7c: the de-opt below is irreversible, so the AFFECTED ORG IDS are captured BEFORE the update - in the D-step
  -- apply record (the apply plan's preflight read P2b, run by virality-cb) and here in the notice. Count measured 0 on
  -- 2026-11-14 (C104 era); cb re-counts at apply.
  RAISE NOTICE '056 preflight: triage_engine_enabled default=%, rows currently ON=% (switched OFF below): %', v_default, v_on,
    (SELECT coalesce(string_agg(organization_id::text, ','), '') FROM public.engagement_system_controls WHERE triage_engine_enabled);
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

-- 3. The UNIQUE index that makes a first classification charge exactly once (7c BLOCKING; b3: create it if absent).
--    Declared IF NOT EXISTS in 20260701000000 and present in the Sept baseline - but an index everyone believed applied
--    has been absent before (C93). If it is ABSENT or INVALID: refuse on any duplicate (thread_id, organization_id) row
--    (a unique index cannot be built over them - those need a decision, not a silent delete), then (re)build it. Plain
--    CREATE UNIQUE INDEX (not CONCURRENTLY - this runs in the migration transaction); the table is small (C105: 124
--    rows), so the brief write lock is acceptable. The postcondition then asserts unique + valid + ready + columns.
DO $m056_idx$
DECLARE
  v_valid boolean;
  v_dups int;
BEGIN
  SELECT i.indisvalid AND i.indisready AND i.indisunique INTO v_valid
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'idx_thread_classification_thread_org'
     AND i.indrelid = 'public.engagement_thread_classification'::regclass;
  IF v_valid IS TRUE THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_dups FROM (
    SELECT thread_id, organization_id FROM public.engagement_thread_classification
     GROUP BY thread_id, organization_id HAVING count(*) > 1) d;
  IF v_dups > 0 THEN
    RAISE EXCEPTION '056: idx_thread_classification_thread_org is missing/invalid and % duplicate (thread_id, organization_id) group(s) exist - resolve them first', v_dups;
  END IF;
  IF v_valid IS NOT NULL THEN
    EXECUTE 'DROP INDEX public.idx_thread_classification_thread_org';   -- present but invalid / not unique
  END IF;
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_classification_thread_org ON public.engagement_thread_classification (thread_id, organization_id)';
  RAISE NOTICE '056: idx_thread_classification_thread_org (re)built';
END
$m056_idx$;

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
  -- 7c (BLOCKING, money): the single charge on a thread's FIRST classification rests on this UNIQUE index - two workers
  -- both INSERT, the loser fails 23505, throws, and its hold is released. It is declared IF NOT EXISTS in 20260701000000
  -- (present in the Sept baseline), but an index everyone believed applied has been absent before (C93), and an INVALID
  -- index enforces nothing while looking healthy. Step 3 (re)built it if it was absent/invalid; this asserts the end state.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_thread_classification_thread_org'
       AND i.indrelid = 'public.engagement_thread_classification'::regclass
       AND i.indisunique AND i.indisvalid AND i.indisready
       AND pg_get_indexdef(i.indexrelid) LIKE '%(thread_id, organization_id)%') THEN
    RAISE EXCEPTION '056 postcondition: idx_thread_classification_thread_org UNIQUE (thread_id, organization_id) is missing or not valid - billed triage would double-charge a first classification under concurrency';
  END IF;
END
$m056_post$;
