-- ============================================================================
-- rpa_retry_queue: durable, atomic claim (version 20270314000001)
-- prepared 2026-11-27 (Phase C, browser-execution framework) · NOT APPLIED ANYWHERE
-- ============================================================================
--
-- WHY. The RPA retry flush (backend/services/rpaWorker/rpaRetryQueue.ts) read due
-- rows with a plain SELECT and then ran them. Nothing marked a row as taken, so
-- two overlapping flushes (two worker replicas, or a tick that outlived the 90 s
-- interval) could execute the SAME row twice: a double post / double like. The
-- in-process task queue (rpaTaskQueue.ts) held accepted tasks only in memory, so a
-- restart lost them without a trace.
--
-- WHAT THIS ADDS
--   * claim columns on rpa_retry_queue: claim_token, claimed_by, claimed_at,
--     claim_expires_at, plus completed_at (a success tombstone: the row is kept so
--     a duplicate enqueue of the same action is a no-op instead of a re-run).
--   * rpa_retry_queue_accept(...)       - durable, idempotent enqueue. INSERT ... ON
--     CONFLICT DO NOTHING against the existing unique index on action_id
--     (production: uq_rpa_retry_queue_action (action_id); repo phase 9:
--     uq_rpa_retry_queue_org_action (organization_id, action_id)). A second accept
--     of the same action returns accepted=false and changes nothing. The row can be
--     born claimed (the worker's direct path) or unclaimed and due now (a web
--     process queuing work for the browser worker).
--   * claim_rpa_retry_queue(...)        - claims up to p_limit due, unclaimed rows
--     with FOR UPDATE SKIP LOCKED; each row gets its own random claim token and a
--     lease. Concurrent claimers receive disjoint rows.
--   * finalize_rpa_retry_queue_claim(...) - records the outcome ONLY when the
--     claim token matches (returns false otherwise and changes nothing).
--   * park_expired_rpa_retry_claims()   - LOST-RESPONSE RULE: a row whose lease
--     expired while executing may already have performed its side effect. It is
--     NEVER re-claimed; it is parked exactly like an existing outcome-unknown row
--     (attempts := max_attempts, last_error 'RPA_OUTCOME_UNKNOWN:CLAIM_EXPIRED...'),
--     claimed_by/claimed_at are kept as evidence, the token is cleared so a late
--     finaliser is refused.
--
-- SECURITY. All four functions are SECURITY INVOKER (they run with the caller's
-- rights; the table's RLS policy and ACL still apply), pin search_path, and are
-- executable by service_role ONLY: EXECUTE is revoked from PUBLIC, anon and
-- authenticated. The application calls them through ownedDbRpc (service-role
-- client). No table privilege is granted or revoked.
--
-- COMPATIBILITY. Every new column is nullable with no default: existing rows read
-- as "unclaimed, not completed", which is what they are. Code that predates this
-- migration ignores the columns. The CHECK constraint holds for every existing
-- row (all claim columns NULL).
--
-- IDEMPOTENT. ADD COLUMN / CREATE INDEX IF NOT EXISTS, constraint added only when
-- absent, CREATE OR REPLACE FUNCTION, REVOKE/GRANT re-runnable.
-- FAIL CLOSED. Missing table, missing roles or no unique index on action_id
-- refuse the whole file (nothing changed).
--
-- APPLY  (after explicit authorization only)
--   *** DO NOT RUN `supabase db push`. *** psql -v ON_ERROR_STOP=1 -f <this file>
--   per docs/migration-discipline.md. Own transaction.
-- ROLLBACK
--   supabase/migrations/rollbacks/rpa_retry_queue_claim_rollback.sql
-- ============================================================================

BEGIN;

DO $preflight$
DECLARE
  r text;
BEGIN
  IF to_regclass('public.rpa_retry_queue') IS NULL THEN
    RAISE EXCEPTION 'RPA-CLAIM preflight: public.rpa_retry_queue does not exist - nothing changed';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      RAISE EXCEPTION 'RPA-CLAIM preflight: role % does not exist - nothing changed', r;
    END IF;
  END LOOP;
  -- ON CONFLICT DO NOTHING is the idempotency proof; it needs a unique index
  -- whose columns include action_id and are a subset of (organization_id, action_id).
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
     WHERE i.indrelid = 'public.rpa_retry_queue'::regclass
       AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
       AND EXISTS (SELECT 1 FROM unnest(i.indkey) k
                    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k
                   WHERE a.attname = 'action_id')
       AND NOT EXISTS (SELECT 1 FROM unnest(i.indkey) k
                        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k
                       WHERE a.attname NOT IN ('action_id', 'organization_id'))
  ) THEN
    RAISE EXCEPTION 'RPA-CLAIM preflight: no valid unique index on rpa_retry_queue(action_id) or (organization_id, action_id) - nothing changed';
  END IF;
END
$preflight$;

-- ── 1. claim columns ─────────────────────────────────────────────────────────
ALTER TABLE public.rpa_retry_queue
  ADD COLUMN IF NOT EXISTS claim_token      uuid,
  ADD COLUMN IF NOT EXISTS claimed_by       text,
  ADD COLUMN IF NOT EXISTS claimed_at       timestamptz,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at     timestamptz;

COMMENT ON COLUMN public.rpa_retry_queue.claim_token IS
  'Set while one worker holds the row (claim_rpa_retry_queue / born-claimed accept). '
  'finalize_rpa_retry_queue_claim only writes when the caller presents this token. '
  'Cleared on finalisation and when an expired claim is parked as outcome-unknown.';
COMMENT ON COLUMN public.rpa_retry_queue.claim_expires_at IS
  'Lease end. A claim past this instant is parked as RPA_OUTCOME_UNKNOWN by '
  'park_expired_rpa_retry_claims and is never re-executed (the side effect may have happened).';
COMMENT ON COLUMN public.rpa_retry_queue.completed_at IS
  'Success tombstone. The row is kept (attempts = max_attempts) so a duplicate '
  'enqueue of the same action is a no-op rather than a second execution.';

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.rpa_retry_queue'::regclass
       AND conname = 'rpa_retry_queue_claim_shape'
  ) THEN
    ALTER TABLE public.rpa_retry_queue
      ADD CONSTRAINT rpa_retry_queue_claim_shape CHECK (
        (claim_token IS NULL AND claim_expires_at IS NULL)
        OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
            AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL)
      );
  END IF;
END
$constraint$;

-- Small table (a deferred-work buffer); a plain build inside the transaction.
CREATE INDEX IF NOT EXISTS idx_rpa_retry_queue_claim_expires
  ON public.rpa_retry_queue (claim_expires_at)
  WHERE claim_token IS NOT NULL;

-- ── 2. accept: durable, idempotent enqueue ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpa_retry_queue_accept(
  p_organization_id uuid,
  p_action_id       uuid,
  p_platform        text,
  p_action_type     text,
  p_target_url      text,
  p_text            text,
  p_claimed_by      text,
  p_lease_seconds   integer
)
RETURNS TABLE (accepted boolean, queue_id uuid, claim_token uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_id    uuid;
  v_token uuid;
BEGIN
  IF p_organization_id IS NULL OR p_action_id IS NULL
     OR coalesce(p_platform, '') = '' OR coalesce(p_action_type, '') = '' OR coalesce(p_target_url, '') = '' THEN
    RAISE EXCEPTION 'rpa_retry_queue_accept: organization_id, action_id, platform, action_type and target_url are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_claimed_by IS NOT NULL AND (p_claimed_by = '' OR p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 86400) THEN
    RAISE EXCEPTION 'rpa_retry_queue_accept: a born-claimed row needs a non-empty claimed_by and 1..86400 lease seconds'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.rpa_retry_queue AS q (
    action_id, organization_id, platform, action_type, target_url, text,
    attempts, next_retry_at,
    claim_token, claimed_by, claimed_at, claim_expires_at
  )
  VALUES (
    p_action_id, p_organization_id, p_platform, p_action_type, p_target_url, p_text,
    0, now(),
    CASE WHEN p_claimed_by IS NULL THEN NULL ELSE gen_random_uuid() END,
    p_claimed_by,
    CASE WHEN p_claimed_by IS NULL THEN NULL ELSE now() END,
    CASE WHEN p_claimed_by IS NULL THEN NULL ELSE now() + make_interval(secs => p_lease_seconds) END
  )
  ON CONFLICT DO NOTHING
  RETURNING q.id, q.claim_token INTO v_id, v_token;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT true, v_id, v_token;
    RETURN;
  END IF;

  -- Duplicate: report the existing row, never touch it.
  SELECT q.id INTO v_id FROM public.rpa_retry_queue q WHERE q.action_id = p_action_id
   ORDER BY (q.organization_id = p_organization_id) DESC LIMIT 1;
  RETURN QUERY SELECT false, v_id, NULL::uuid;
END
$fn$;

-- ── 3. claim: FOR UPDATE SKIP LOCKED, one token per row ─────────────────────
CREATE OR REPLACE FUNCTION public.claim_rpa_retry_queue(
  p_claimed_by      text,
  p_lease_seconds   integer,
  p_limit           integer,
  p_organization_id uuid DEFAULT NULL
)
RETURNS SETOF public.rpa_retry_queue
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF coalesce(p_claimed_by, '') = '' THEN
    RAISE EXCEPTION 'claim_rpa_retry_queue: claimed_by is required' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'claim_rpa_retry_queue: lease seconds must be 1..86400' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'claim_rpa_retry_queue: limit must be 1..1000' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH picked AS (
    SELECT q.id
      FROM public.rpa_retry_queue q
     WHERE q.claim_token IS NULL
       AND q.completed_at IS NULL
       AND q.attempts < q.max_attempts
       AND q.next_retry_at <= now()
       AND (p_organization_id IS NULL OR q.organization_id = p_organization_id)
     ORDER BY q.next_retry_at, q.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.rpa_retry_queue q
     SET claim_token      = gen_random_uuid(),
         claimed_by       = p_claimed_by,
         claimed_at       = now(),
         claim_expires_at = now() + make_interval(secs => p_lease_seconds),
         updated_at       = now()
    FROM picked
   WHERE q.id = picked.id
     -- Re-checked on the locked row version (READ COMMITTED re-evaluation).
     AND q.claim_token IS NULL
  RETURNING q.*;
END
$fn$;

-- ── 4. finalize: token-matched outcome ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finalize_rpa_retry_queue_claim(
  p_queue_id            uuid,
  p_claim_token         uuid,
  p_outcome             text,
  p_error               text DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT NULL,
  p_terminal            boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_id uuid;
  v_err text := left(coalesce(p_error, ''), 480);
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'failed', 'unknown') THEN
    RAISE EXCEPTION 'finalize_rpa_retry_queue_claim: outcome must be succeeded, failed or unknown' USING ERRCODE = '22023';
  END IF;
  IF p_queue_id IS NULL OR p_claim_token IS NULL THEN
    RETURN false;
  END IF;
  IF p_retry_delay_seconds IS NOT NULL AND (p_retry_delay_seconds < 1 OR p_retry_delay_seconds > 86400) THEN
    RAISE EXCEPTION 'finalize_rpa_retry_queue_claim: retry delay must be 1..86400 seconds' USING ERRCODE = '22023';
  END IF;

  UPDATE public.rpa_retry_queue q
     SET attempts = CASE
                      WHEN p_outcome = 'failed' AND NOT coalesce(p_terminal, false) THEN q.attempts + 1
                      ELSE greatest(q.attempts + CASE WHEN p_outcome = 'failed' THEN 1 ELSE 0 END, q.max_attempts)
                    END,
         next_retry_at = CASE
                           WHEN p_outcome = 'failed' AND NOT coalesce(p_terminal, false) AND q.attempts + 1 < q.max_attempts
                             THEN now() + make_interval(secs => coalesce(
                                    p_retry_delay_seconds,
                                    (least(120, power(2, q.attempts + 1)::integer) * 60)))
                           ELSE q.next_retry_at
                         END,
         last_error = CASE p_outcome
                        WHEN 'succeeded' THEN NULL
                        WHEN 'unknown' THEN CASE WHEN v_err LIKE 'RPA_OUTCOME_UNKNOWN%' THEN v_err
                                                 ELSE 'RPA_OUTCOME_UNKNOWN:' || coalesce(nullif(v_err, ''), 'UNKNOWN') END
                        ELSE coalesce(nullif(v_err, ''), 'unknown')
                      END,
         completed_at     = CASE WHEN p_outcome = 'succeeded' THEN now() ELSE q.completed_at END,
         last_attempt_at  = now(),
         claim_token      = NULL,
         claim_expires_at = NULL,
         updated_at       = now()
   WHERE q.id = p_queue_id
     AND q.claim_token = p_claim_token
  RETURNING q.id INTO v_id;

  RETURN v_id IS NOT NULL;
END
$fn$;

-- ── 5. park expired claims: outcome unknown, never re-run ───────────────────
CREATE OR REPLACE FUNCTION public.park_expired_rpa_retry_claims()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_count integer;
BEGIN
  WITH expired AS (
    SELECT q.id
      FROM public.rpa_retry_queue q
     WHERE q.claim_token IS NOT NULL
       AND q.claim_expires_at <= now()
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.rpa_retry_queue q
     SET attempts         = greatest(q.attempts, q.max_attempts),
         last_error       = left('RPA_OUTCOME_UNKNOWN:CLAIM_EXPIRED claimed_by=' || coalesce(q.claimed_by, '?')
                                 || ' claimed_at=' || coalesce(q.claimed_at::text, '?'), 500),
         claim_token      = NULL,
         claim_expires_at = NULL,
         updated_at       = now()
    FROM expired
   WHERE q.id = expired.id
     AND q.claim_token IS NOT NULL
     AND q.claim_expires_at <= now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$fn$;

-- ── 6. privileges: service_role only ────────────────────────────────────────
REVOKE ALL ON FUNCTION public.rpa_retry_queue_accept(uuid, uuid, text, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_rpa_retry_queue(text, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_rpa_retry_queue_claim(uuid, uuid, text, text, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.park_expired_rpa_retry_claims() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpa_retry_queue_accept(uuid, uuid, text, text, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_rpa_retry_queue(text, integer, integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_rpa_retry_queue_claim(uuid, uuid, text, text, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.park_expired_rpa_retry_claims() TO service_role;

-- ── 7. postconditions ───────────────────────────────────────────────────────
DO $verify$
DECLARE
  c text;
  f regprocedure;
  fns regprocedure[] := ARRAY[
    'public.rpa_retry_queue_accept(uuid, uuid, text, text, text, text, text, integer)'::regprocedure,
    'public.claim_rpa_retry_queue(text, integer, integer, uuid)'::regprocedure,
    'public.finalize_rpa_retry_queue_claim(uuid, uuid, text, text, integer, boolean)'::regprocedure,
    'public.park_expired_rpa_retry_claims()'::regprocedure
  ];
BEGIN
  FOREACH c IN ARRAY ARRAY['claim_token', 'claimed_by', 'claimed_at', 'claim_expires_at', 'completed_at'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rpa_retry_queue'::regclass
                    AND attname = c AND NOT attisdropped AND NOT attnotnull) THEN
      RAISE EXCEPTION 'RPA-CLAIM postcondition: nullable column rpa_retry_queue.% missing', c;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.rpa_retry_queue'::regclass
                  AND conname = 'rpa_retry_queue_claim_shape' AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION 'RPA-CLAIM postcondition: rpa_retry_queue_claim_shape missing or not validated';
  END IF;
  FOREACH f IN ARRAY fns LOOP
    IF (SELECT prosecdef FROM pg_proc WHERE oid = f) THEN
      RAISE EXCEPTION 'RPA-CLAIM postcondition: % must be SECURITY INVOKER', f;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f
                    AND proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
      RAISE EXCEPTION 'RPA-CLAIM postcondition: % search_path is not pinned', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'RPA-CLAIM postcondition: % is executable by anon/authenticated', f;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = f AND a.grantee = 0) THEN
      RAISE EXCEPTION 'RPA-CLAIM postcondition: % still grants EXECUTE to PUBLIC', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'RPA-CLAIM postcondition: service_role cannot EXECUTE %', f;
    END IF;
  END LOOP;
END
$verify$;

COMMIT;
