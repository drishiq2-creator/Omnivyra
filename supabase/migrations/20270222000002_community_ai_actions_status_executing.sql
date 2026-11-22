-- 20270222000002 community_ai_actions_status_executing (b3; owner-approved 2026-11-22 for WRITING, TESTING and REVIEW
-- only - applying it to production needs the owner's separate explicit approval)
--
-- WHY: production's community_ai_actions_status_check (read-only catalogue read, 2026-11-22 12:09Z, project
-- klkiseupptzbecbxwrky) is the OLD five-status rule:
--   CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'executed'::text, 'failed'::text, 'skipped'::text])))
-- but the code writes 'executing' (POST /api/community-ai/actions/execute, before every execution) and
-- 'sent_unverified' (POST /api/extension/action-result, a send whose delivery is UNKNOWN). Both writes fail with 23514
-- in production today, so no community-AI action can be executed and an unknown outcome cannot be recorded.
-- 20260522_community_ai_execution_integrity.sql meant to install a wider rule but adds it only IF NOT EXISTS, so the
-- old rule stayed.
--
-- WHAT: exactly two statuses are ADDED; every existing status is kept; no row is read-modified or rewritten.
--   before: pending, approved, executed, failed, skipped
--   after:  pending, approved, executing, executed, sent_unverified, failed, skipped
-- Not added (owner scope): 'blocked' (written by the executor when a plan limit is exceeded), 'dispatched',
-- 'acknowledged', 'scheduled'.
--
-- SAFETY:
--   - The rule is replaced ONLY when it is exactly the old five-status rule above. If it is exactly one of the known
--     rules that already permit both new statuses (this file's seven-status rule, or the wider 20260522 / 20260523
--     rules) nothing is changed - this file never narrows a rule. Any other shape is refused (nothing changed).
--   - Existing data is checked first: every row's status must be NULL or one of the five old statuses (it must be,
--     under the old rule); otherwise refused.
--   - The new rule is added NOT VALID in the same transaction that drops the old one (no moment without a rule; a brief
--     lock), then VALIDATEd in its own transaction (SHARE UPDATE EXCLUSIVE: reads and writes continue).
--   - Re-running after success is a no-op; re-running after a failure in either transaction converges.
-- APPLY: `psql -v ON_ERROR_STOP=1 -f <file>`, or as one query / one Management-API call (no CONCURRENTLY here;
--   measured), or as two calls (transaction 1, transaction 2).
-- ROLLBACK: supabase/migrations/rollbacks/community_ai_actions_status_executing_rollback.sql - restores the exact old
--   rule; refuses while any row holds 'executing' or 'sent_unverified' (those records are never rewritten).
--
-- This version: never applied anywhere.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $widen$
DECLARE
  v_old CONSTANT text := 'CHECK ((status = ANY (ARRAY[''pending''::text, ''approved''::text, ''executed''::text, ''failed''::text, ''skipped''::text])))';
  -- The rules that already permit both new statuses, exactly as PostgreSQL renders them (review F2: an exact match, never
  -- a text search): this migration's seven-status rule, and the wider rules 20260522 / 20260523 would have installed.
  v_known text[] := ARRAY(
    SELECT 'CHECK ((status = ANY (ARRAY[' || (SELECT string_agg(quote_literal(x) || '::text', ', ' ORDER BY o) FROM unnest(l) WITH ORDINALITY AS u(x, o)) || '])))'
      FROM (VALUES
        (ARRAY['pending', 'approved', 'executing', 'executed', 'sent_unverified', 'failed', 'skipped']),
        (ARRAY['pending', 'approved', 'dispatched', 'executing', 'executed', 'sent_unverified', 'failed', 'skipped', 'blocked', 'scheduled']),
        (ARRAY['pending', 'approved', 'dispatched', 'acknowledged', 'executing', 'executed', 'sent_unverified', 'failed', 'skipped', 'blocked', 'scheduled'])
      ) AS k(l));
  v_def text;
  v_bad bigint;
BEGIN
  IF to_regclass('public.community_ai_actions') IS NULL THEN
    RAISE EXCEPTION 'CAS preflight: public.community_ai_actions is missing';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.community_ai_actions'::regclass AND c.conname = 'community_ai_actions_status_check';

  -- Exactly a known rule that already permits both new statuses (validated or not yet): never narrow, change nothing
  -- here (transaction 2 validates a NOT VALID one).
  IF v_def = ANY (v_known) OR regexp_replace(coalesce(v_def, ''), ' NOT VALID$', '') = ANY (v_known) THEN
    RETURN;
  END IF;

  IF v_def IS DISTINCT FROM v_old THEN
    RAISE EXCEPTION 'CAS preflight: community_ai_actions_status_check is not the expected old rule (found: %) - nothing changed', coalesce(v_def, '<absent>');
  END IF;

  -- Existing data: every status must already be one of the old five (or NULL). Nothing is rewritten either way.
  SELECT count(*) INTO v_bad FROM public.community_ai_actions
   WHERE status IS NOT NULL AND status NOT IN ('pending', 'approved', 'executed', 'failed', 'skipped');
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'CAS preflight: % row(s) hold a status outside the old rule - nothing changed', v_bad;
  END IF;

  ALTER TABLE public.community_ai_actions DROP CONSTRAINT community_ai_actions_status_check;
  ALTER TABLE public.community_ai_actions ADD CONSTRAINT community_ai_actions_status_check
    CHECK (status IN ('pending', 'approved', 'executing', 'executed', 'sent_unverified', 'failed', 'skipped')) NOT VALID;
END
$widen$;

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
-- A no-op when the rule is already validated (re-run, or the never-narrow path).
ALTER TABLE public.community_ai_actions VALIDATE CONSTRAINT community_ai_actions_status_check;

DO $postcondition$
DECLARE
  -- The rules that already permit both new statuses, exactly as PostgreSQL renders them (review F2: an exact match, never
  -- a text search): this migration's seven-status rule, and the wider rules 20260522 / 20260523 would have installed.
  v_known text[] := ARRAY(
    SELECT 'CHECK ((status = ANY (ARRAY[' || (SELECT string_agg(quote_literal(x) || '::text', ', ' ORDER BY o) FROM unnest(l) WITH ORDINALITY AS u(x, o)) || '])))'
      FROM (VALUES
        (ARRAY['pending', 'approved', 'executing', 'executed', 'sent_unverified', 'failed', 'skipped']),
        (ARRAY['pending', 'approved', 'dispatched', 'executing', 'executed', 'sent_unverified', 'failed', 'skipped', 'blocked', 'scheduled']),
        (ARRAY['pending', 'approved', 'dispatched', 'acknowledged', 'executing', 'executed', 'sent_unverified', 'failed', 'skipped', 'blocked', 'scheduled'])
      ) AS k(l));
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.community_ai_actions'::regclass AND c.conname = 'community_ai_actions_status_check' AND c.convalidated;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'CAS postcondition: community_ai_actions_status_check missing or not validated';
  END IF;
  IF NOT (v_def = ANY (v_known)) THEN
    RAISE EXCEPTION 'CAS postcondition: community_ai_actions_status_check is not a known rule permitting executing and sent_unverified (found: %)', v_def;
  END IF;
END
$postcondition$;

COMMIT;
