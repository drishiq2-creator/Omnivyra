-- ROLLBACK for 20270222000002_community_ai_actions_status_executing.sql (b3, 2026-11-22).
--
-- Restores the exact old five-status rule:
--   CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'executed'::text, 'failed'::text, 'skipped'::text])))
-- REFUSES while any row holds 'executing' or 'sent_unverified': those records are real outcomes (a send whose delivery
-- is unknown, or an execution in progress) and are never rewritten or discarded by a rollback. An operator resolves
-- them first.
-- Only the exact seven-status rule written by the forward migration is replaced; when the old rule is already in place
-- this is a no-op; any other shape is refused (nothing changed). Re-running is safe.
-- Note: the code on main also writes these statuses, so after a rollback executions fail again exactly as before.

BEGIN;
SET LOCAL lock_timeout = '5s';
-- Block writes while checking and replacing, so no row can take a new status between the check and the swap.
LOCK TABLE public.community_ai_actions IN SHARE ROW EXCLUSIVE MODE;

DO $rollback$
DECLARE
  v_old CONSTANT text := 'CHECK ((status = ANY (ARRAY[''pending''::text, ''approved''::text, ''executed''::text, ''failed''::text, ''skipped''::text])))';
  v_new CONSTANT text := 'CHECK ((status = ANY (ARRAY[''pending''::text, ''approved''::text, ''executing''::text, ''executed''::text, ''sent_unverified''::text, ''failed''::text, ''skipped''::text])))';
  v_def text;
  v_open bigint;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.community_ai_actions'::regclass AND c.conname = 'community_ai_actions_status_check';

  IF v_def = v_old THEN
    RETURN;   -- already rolled back
  END IF;
  IF v_def IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'CAS rollback refused: community_ai_actions_status_check is not the rule this migration wrote (found: %) - nothing changed', coalesce(v_def, '<absent>');
  END IF;

  SELECT count(*) INTO v_open FROM public.community_ai_actions WHERE status IN ('executing', 'sent_unverified');
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'CAS rollback refused: % row(s) hold executing/sent_unverified - resolve them first; nothing changed', v_open;
  END IF;

  ALTER TABLE public.community_ai_actions DROP CONSTRAINT community_ai_actions_status_check;
  ALTER TABLE public.community_ai_actions ADD CONSTRAINT community_ai_actions_status_check
    CHECK (status IN ('pending', 'approved', 'executed', 'failed', 'skipped'));

  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.community_ai_actions'::regclass AND c.conname = 'community_ai_actions_status_check' AND c.convalidated;
  IF v_def IS DISTINCT FROM v_old THEN
    RAISE EXCEPTION 'CAS rollback postcondition: restored rule differs from the old one (found: %)', coalesce(v_def, '<absent>');
  END IF;
END
$rollback$;

COMMIT;
