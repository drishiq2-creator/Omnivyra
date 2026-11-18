-- 20270217000061 - billed result recovery: owed refunds + durable replay-failure counts (c6; b3 rulings 2026-11-18,
-- BLOCKING for billing; criteria from virality-7c; version from virality-cb; review: virality-7c).
--
-- WHY. Billed generate-and-return work is persisted (api_idempotency_keys, backend/services/billing/billedResultStore)
-- BEFORE its charge is confirmed, and a retry with the same key replays it. Two gaps remained:
--   1. A charged result that can no longer be returned is refunded - but the refund was completed only if the USER
--      retried. b3: "auto-refund" means the system pays without the user acting. billing_owed_refunds records the debt
--      durably; the grant-only job 'billing-owed-refund-complete' pays it. ONE row per ORIGINAL confirm transaction:
--      the UNIQUE index is what enforces "once" (a concurrent completer and a user retry: the loser gets 23505).
--   2. A replay whose stored result cannot be read answered "try again" forever. billed_result_replay_failures counts
--      failed re-reads per (scope, caller, key) DURABLY (not in the client or a process), so after 3 failures or 24h
--      from the FIRST failure the replay turns terminal and goes to the refund path.
--
-- Both tables are service-role only: REVOKE ALL from anon / authenticated, explicit GRANT to service_role, RLS on with
-- no client policy. No view, no matview. Rollback: rollbacks/billed_result_recovery_rollback.sql.

CREATE TABLE IF NOT EXISTS public.billing_owed_refunds (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid        NOT NULL,
  original_confirm_txn_id  uuid        NOT NULL,
  free_credits             numeric     NOT NULL DEFAULT 0 CHECK (free_credits >= 0),
  paid_credits             numeric     NOT NULL DEFAULT 0 CHECK (paid_credits >= 0),
  incentive_credits        numeric     NOT NULL DEFAULT 0 CHECK (incentive_credits >= 0),
  reason                   text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 100),
  grant_key_prefix         text        NOT NULL CHECK (length(grant_key_prefix) BETWEEN 1 AND 60),
  performed_by             uuid        NOT NULL,
  reference_id             text,
  status                   text        NOT NULL DEFAULT 'owed' CHECK (status IN ('owed', 'granted')),
  attempts                 integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error               text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  granted_at               timestamptz,
  CHECK (free_credits + paid_credits + incentive_credits > 0),
  CHECK ((status = 'granted') = (granted_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_owed_refunds_original_confirm_uidx
  ON public.billing_owed_refunds (original_confirm_txn_id);
CREATE INDEX IF NOT EXISTS billing_owed_refunds_owed_idx
  ON public.billing_owed_refunds (created_at) WHERE status = 'owed';

CREATE TABLE IF NOT EXISTS public.billed_result_replay_failures (
  scope            text        NOT NULL CHECK (length(scope) BETWEEN 1 AND 200),
  caller_id        text        NOT NULL CHECK (length(caller_id) BETWEEN 1 AND 200),
  idempotency_key  text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 400),
  failures         integer     NOT NULL DEFAULT 1 CHECK (failures >= 1),
  first_failed_at  timestamptz NOT NULL DEFAULT now(),
  last_failed_at   timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  PRIMARY KEY (scope, caller_id, idempotency_key)
);

-- Atomic increment: one statement, so two concurrent failed re-reads both count (never a lost update), and the FIRST
-- failure time is kept, never recomputed per attempt (7c).
CREATE OR REPLACE FUNCTION public.record_billed_result_replay_failure(
  p_scope text, p_caller_id text, p_key text, p_error text
) RETURNS TABLE (failures integer, first_failed_at timestamptz)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  INSERT INTO public.billed_result_replay_failures AS f (scope, caller_id, idempotency_key, last_error)
  VALUES (p_scope, p_caller_id, p_key, left(p_error, 500))
  ON CONFLICT (scope, caller_id, idempotency_key)
  DO UPDATE SET failures = f.failures + 1, last_failed_at = now(), last_error = left(EXCLUDED.last_error, 500)
  RETURNING f.failures, f.first_failed_at;
$fn$;

ALTER TABLE public.billing_owed_refunds          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billed_result_replay_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_owed_refunds          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.billed_result_replay_failures FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.billing_owed_refunds          TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.billed_result_replay_failures TO service_role;
REVOKE ALL ON FUNCTION public.record_billed_result_replay_failure(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_billed_result_replay_failure(text, text, text, text) TO service_role;

DO $m061_post$
DECLARE
  v_valid boolean;
  v_unique boolean;
  v_cols text;
BEGIN
  -- 7c: an INVALID unique index enforces nothing and looks healthy - assert valid, unique, and on the right column.
  SELECT i.indisvalid, i.indisunique,
         (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
            FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
    INTO v_valid, v_unique, v_cols
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'billing_owed_refunds_original_confirm_uidx' AND c.relnamespace = 'public'::regnamespace;
  IF v_valid IS DISTINCT FROM true OR v_unique IS DISTINCT FROM true OR v_cols IS DISTINCT FROM 'original_confirm_txn_id' THEN
    RAISE EXCEPTION '061 postcondition: billing_owed_refunds_original_confirm_uidx is not a valid UNIQUE index on original_confirm_txn_id (valid=%, unique=%, cols=%)', v_valid, v_unique, v_cols;
  END IF;
  IF has_table_privilege('anon', 'public.billing_owed_refunds', 'SELECT')
     OR has_table_privilege('authenticated', 'public.billing_owed_refunds', 'SELECT')
     OR has_table_privilege('anon', 'public.billed_result_replay_failures', 'SELECT')
     OR has_table_privilege('authenticated', 'public.billed_result_replay_failures', 'SELECT') THEN
    RAISE EXCEPTION '061 postcondition: a client role can read a billed-result-recovery table';
  END IF;
  IF has_function_privilege('anon', 'public.record_billed_result_replay_failure(text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_billed_result_replay_failure(text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '061 postcondition: a client role can execute record_billed_result_replay_failure';
  END IF;
END
$m061_post$;
