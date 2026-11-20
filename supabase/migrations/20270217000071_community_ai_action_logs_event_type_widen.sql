-- 20270217000071_community_ai_action_logs_event_type_widen (a9, 2026-11-20). Version reserved by cb (rc-attest
-- b761d8b5f); review: 7c. Template: c6's 20270217000064 (7c-reviewed).
--
-- Widens community_ai_action_logs.event_type CHECK with 'skipped_due_to_platform_policy' - the outcome the executor
-- logs when the platform policy refuses an action. The old CHECK refused it, so every such insert failed (PL-108). With
-- the value admitted, the writer stores the TRUE type (no "map to 'skipped' + flag" workaround; b3: one approach).
--
-- PRECONDITION (cb C141, prod read 2026-11-20): the live constraint is VALIDATED and its definition is EXACTLY the
-- 6-value list (approved, executed, failed, skipped, scheduled, auto_executed) - identical to
-- supabase/_schema/baseline.sql, which CI restores. Anything else RAISES and nothing changes: a drifted constraint
-- must be re-read, never overwritten.
-- EXPAND ONLY: every existing value stays allowed, so no existing row can violate the new CHECK (prod had 0 rows).
-- DEPLOY ORDER: DB first. App-first fails visibly, not silently: the policy-refusal insert is refused, and the writer
-- logs COMMUNITY_AI_ACTION_LOG_FAILED and counts community_ai_action_log_failed (f8129a5eb).
-- Table posture (RLS, grants, policy) is unchanged - only the CHECK is replaced.
-- ATOMIC REGARDLESS OF THE RUNNER: the check, the DROP and the ADD are ONE DO statement, so the table is never left
-- without an event_type CHECK.
-- DELIBERATELY PG-VERSION-SENSITIVE: the preflight pins pg_get_constraintdef's normalized text, which agrees on prod
-- (cb C141) and the CI sandbox today; a prod PG major upgrade before apply could make this file refuse. That strictness
-- is intended - re-read and re-pin, never loosen.
-- Rollback: supabase/migrations/rollbacks/community_ai_action_logs_event_type_widen_rollback.sql

DO $widen$
DECLARE
  v_def text;
  v_valid boolean;
BEGIN
  SELECT pg_get_constraintdef(oid), convalidated INTO v_def, v_valid
    FROM pg_constraint
   WHERE conrelid = 'public.community_ai_action_logs'::regclass
     AND conname = 'community_ai_action_logs_event_type_check' AND contype = 'c';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '071 preflight: community_ai_action_logs_event_type_check is missing - nothing changed';
  END IF;
  IF v_def IS DISTINCT FROM 'CHECK ((event_type = ANY (ARRAY[''approved''::text, ''executed''::text, ''failed''::text, ''skipped''::text, ''scheduled''::text, ''auto_executed''::text])))' THEN
    RAISE EXCEPTION '071 preflight: community_ai_action_logs_event_type_check is not the known 6-value list (live: %) - nothing changed', v_def;
  END IF;
  IF NOT v_valid THEN
    RAISE EXCEPTION '071 preflight: community_ai_action_logs_event_type_check is NOT VALID - nothing changed';
  END IF;

  ALTER TABLE public.community_ai_action_logs
    DROP CONSTRAINT community_ai_action_logs_event_type_check;

  ALTER TABLE public.community_ai_action_logs
    ADD CONSTRAINT community_ai_action_logs_event_type_check CHECK (event_type IN (
      'approved', 'executed', 'failed', 'skipped', 'scheduled', 'auto_executed',
      'skipped_due_to_platform_policy'
    ));
END
$widen$;

DO $verify$
DECLARE
  v_def text;
  v_valid boolean;
BEGIN
  SELECT pg_get_constraintdef(oid), convalidated INTO v_def, v_valid
    FROM pg_constraint
   WHERE conrelid = 'public.community_ai_action_logs'::regclass
     AND conname = 'community_ai_action_logs_event_type_check' AND contype = 'c';
  IF v_def IS DISTINCT FROM 'CHECK ((event_type = ANY (ARRAY[''approved''::text, ''executed''::text, ''failed''::text, ''skipped''::text, ''scheduled''::text, ''auto_executed''::text, ''skipped_due_to_platform_policy''::text])))'
     OR NOT v_valid THEN
    RAISE EXCEPTION '071 postcondition: community_ai_action_logs_event_type_check is not the validated 7-value list (live: %)', v_def;
  END IF;
END
$verify$;
