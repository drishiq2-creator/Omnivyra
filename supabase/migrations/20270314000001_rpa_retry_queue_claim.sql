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
--   * renew_rpa_retry_queue_claim(...)  - LEASE CHECK BEFORE RUNNING (review S-1): true only
--     when the caller's token still holds AND the lease has not expired; the lease is
--     extended in the same statement. The worker calls it immediately before the
--     handler; on false the row is NOT run.
--   * release_rpa_retry_queue_claim(...) - give back a claim that was never attempted
--     (token-matched; attempts unchanged; due again after a short delay). Used when the
--     renew refused an expired-but-still-held claim: the worker can prove it never ran
--     the row, so it is not recorded as outcome-unknown. A row already parked stays
--     parked (its token is gone; release returns 'not_held') and is not run.
--     BOUNDED (review N-b): every release increments release_count; the 5th release
--     parks the row as RPA_CLAIM_RELEASE_CAP_NOT_ATTEMPTED (attempts := max_attempts,
--     terminal, never re-run without a human) instead of cycling claim -> lost ->
--     release forever. Returns 'released' | 'parked_stuck' | 'not_held'.
--   * count_rpa_retry_queue_remaining() - backlog count against each row's OWN
--     max_attempts (review N-c; PostgREST cannot compare two columns).
--
-- SECURITY. All seven functions are SECURITY INVOKER (they run with the caller's
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
-- DEPLOY ORDER (review S-3; runbook docs/runbooks/phase-c-browser-execution-deploy.md)
--   * Apply this file TOGETHER WITH the release that calls these functions (the new
--     worker code cannot run without them; the old code ignores the new columns).
--   * A MERGE TO main ITSELF triggers the Railway worker deploy, and that deploy is
--     rolling (new container up before the old one stops). So: scale the worker to 0
--     and VERIFY 0 replicas BEFORE merging (runbook step 0).
--   * NO OVERLAP between the old and the new RPA worker: stop the old worker (all
--     replicas) BEFORE the new one starts. The old flush reads due rows with a plain
--     SELECT and ignores claim_token, so an old worker running next to a new one could
--     execute a row the new one has claimed: a double post / double like.
--   * Same release, other file: 20270314000010 (extension handshake store) must be
--     applied BEFORE the web deploy, or every extension route answers 503.
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
  -- Every pre-existing column the functions below read or write (review N-2): fail
  -- fast here rather than at the first call in production.
  FOREACH r IN ARRAY ARRAY['id', 'action_id', 'organization_id', 'platform', 'action_type', 'target_url',
                           'text', 'attempts', 'max_attempts', 'last_error', 'last_attempt_at',
                           'next_retry_at', 'updated_at'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rpa_retry_queue'::regclass
                    AND attname = r AND attnum > 0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'RPA-CLAIM preflight: column rpa_retry_queue.% does not exist - nothing changed', r;
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
  ADD COLUMN IF NOT EXISTS completed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS release_count    integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.rpa_retry_queue.claim_token IS
  'Set while one worker holds the row (claim_rpa_retry_queue / born-claimed accept). '
  'finalize_rpa_retry_queue_claim only writes when the caller presents this token. '
  'Cleared on finalisation and when an expired claim is parked as outcome-unknown.';
COMMENT ON COLUMN public.rpa_retry_queue.claim_expires_at IS
  'Lease end. A claim past this instant is parked as RPA_OUTCOME_UNKNOWN by '
  'park_expired_rpa_retry_claims and is never re-executed (the side effect may have happened).';
COMMENT ON COLUMN public.rpa_retry_queue.release_count IS
  'Times a claim on this row was released as never attempted (lease lost before the run). '
  'At 5 the row is parked RPA_CLAIM_RELEASE_CAP_NOT_ATTEMPTED and never re-run automatically.';
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

  -- Duplicate: report the existing row of THIS organization, never touch it.
  SELECT q.id INTO v_id FROM public.rpa_retry_queue q
   WHERE q.action_id = p_action_id AND q.organization_id = p_organization_id
   LIMIT 1;
  IF v_id IS NULL AND EXISTS (SELECT 1 FROM public.rpa_retry_queue q WHERE q.action_id = p_action_id) THEN
    -- Review N-1: under production's unique index (action_id) alone, the conflicting
    -- row belongs to ANOTHER organization. Never return its id (no cross-tenant leak)
    -- and never report "already queued" for work this organization does not own.
    RAISE EXCEPTION 'RPA_ACCEPT_ORG_MISMATCH: action_id is queued under another organization'
      USING ERRCODE = '42501';
  END IF;
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

-- ── 4b. renew: the lease check immediately before running (review S-1) ──────
CREATE OR REPLACE FUNCTION public.renew_rpa_retry_queue_claim(
  p_queue_id      uuid,
  p_claim_token   uuid,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'renew_rpa_retry_queue_claim: lease seconds must be 1..86400' USING ERRCODE = '22023';
  END IF;
  IF p_queue_id IS NULL OR p_claim_token IS NULL THEN
    RETURN false;
  END IF;
  -- true ONLY when the token still holds and the lease has not run out (database
  -- clock). An expired claim is never revived: another worker may park it as
  -- outcome-unknown at any moment.
  UPDATE public.rpa_retry_queue q
     SET claim_expires_at = now() + make_interval(secs => p_lease_seconds),
         updated_at       = now()
   WHERE q.id = p_queue_id
     AND q.claim_token = p_claim_token
     AND q.claim_expires_at > now()
  RETURNING q.id INTO v_id;
  RETURN v_id IS NOT NULL;
END
$fn$;

-- ── 4c. release a claim that was never attempted (bounded) ─────────────────
-- Return type changed during review (boolean -> text); the function has never been
-- applied anywhere, the DROP only keeps this file re-runnable on a throwaway replay.
DROP FUNCTION IF EXISTS public.release_rpa_retry_queue_claim(uuid, uuid, text, integer);
CREATE FUNCTION public.release_rpa_retry_queue_claim(
  p_queue_id            uuid,
  p_claim_token         uuid,
  p_reason              text DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 60
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c_cap   constant integer := 5;
  v_count integer;
  v_why   text := coalesce(nullif(p_reason, ''), 'LEASE_LOST');
BEGIN
  IF p_retry_delay_seconds IS NULL OR p_retry_delay_seconds < 0 OR p_retry_delay_seconds > 86400 THEN
    RAISE EXCEPTION 'release_rpa_retry_queue_claim: retry delay must be 0..86400 seconds' USING ERRCODE = '22023';
  END IF;
  IF p_queue_id IS NULL OR p_claim_token IS NULL THEN
    RETURN 'not_held';
  END IF;
  -- Token-matched (expired or not): the caller proves the row was NOT attempted by
  -- still holding the token and never having run it. attempts is unchanged and the
  -- row is due again after the delay - until the release cap: the c_cap-th release
  -- parks it (attempts := max_attempts, terminal, a human must look). claimed_by /
  -- claimed_at stay as evidence.
  UPDATE public.rpa_retry_queue q
     SET claim_token      = NULL,
         claim_expires_at = NULL,
         release_count    = q.release_count + 1,
         attempts         = CASE WHEN q.release_count + 1 >= c_cap THEN greatest(q.attempts, q.max_attempts) ELSE q.attempts END,
         next_retry_at    = CASE WHEN q.release_count + 1 >= c_cap THEN q.next_retry_at
                                 ELSE now() + make_interval(secs => p_retry_delay_seconds) END,
         last_error       = CASE WHEN q.release_count + 1 >= c_cap
                              THEN left('RPA_CLAIM_RELEASE_CAP_NOT_ATTEMPTED: claim lost before the run '
                                        || (q.release_count + 1) || ' times (last: ' || v_why
                                        || '); never attempted; parked - re-run only after a human review', 500)
                              ELSE left('RPA_CLAIM_RELEASED_NOT_ATTEMPTED:' || v_why, 500) END,
         updated_at       = now()
   WHERE q.id = p_queue_id
     AND q.claim_token = p_claim_token
  RETURNING q.release_count INTO v_count;
  IF v_count IS NULL THEN
    RETURN 'not_held';
  END IF;
  RETURN CASE WHEN v_count >= c_cap THEN 'parked_stuck' ELSE 'released' END;
END
$fn$;

-- ── 4d. remaining backlog against each row's own max_attempts (review N-c) ───
CREATE OR REPLACE FUNCTION public.count_rpa_retry_queue_remaining()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
  SELECT count(*)::integer
    FROM public.rpa_retry_queue q
   WHERE q.claim_token IS NULL
     AND q.completed_at IS NULL
     AND q.attempts < q.max_attempts
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
REVOKE ALL ON FUNCTION public.renew_rpa_retry_queue_claim(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_rpa_retry_queue_claim(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.count_rpa_retry_queue_remaining() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpa_retry_queue_accept(uuid, uuid, text, text, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_rpa_retry_queue(text, integer, integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_rpa_retry_queue_claim(uuid, uuid, text, text, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.park_expired_rpa_retry_claims() TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_rpa_retry_queue_claim(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_rpa_retry_queue_claim(uuid, uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.count_rpa_retry_queue_remaining() TO service_role;

-- ── 7. postconditions ───────────────────────────────────────────────────────
-- Review N-d: EXACT proconfig and the proacl itself (aclexplode over the stored ACL,
-- or the owner default when NULL), not `proconfig @>` / has_function_privilege
-- (the latter is true for the owner and through role membership).
DO $verify$
DECLARE
  c text;
  f regprocedure;
  v_secdef boolean;
  v_config text[];
  v_leaked text[];
  v_n integer;
  fns regprocedure[] := ARRAY[
    'public.rpa_retry_queue_accept(uuid, uuid, text, text, text, text, text, integer)'::regprocedure,
    'public.claim_rpa_retry_queue(text, integer, integer, uuid)'::regprocedure,
    'public.finalize_rpa_retry_queue_claim(uuid, uuid, text, text, integer, boolean)'::regprocedure,
    'public.park_expired_rpa_retry_claims()'::regprocedure,
    'public.renew_rpa_retry_queue_claim(uuid, uuid, integer)'::regprocedure,
    'public.release_rpa_retry_queue_claim(uuid, uuid, text, integer)'::regprocedure,
    'public.count_rpa_retry_queue_remaining()'::regprocedure
  ];
BEGIN
  FOREACH c IN ARRAY ARRAY['claim_token', 'claimed_by', 'claimed_at', 'claim_expires_at', 'completed_at'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rpa_retry_queue'::regclass
                    AND attname = c AND NOT attisdropped AND NOT attnotnull) THEN
      RAISE EXCEPTION 'RPA-CLAIM postcondition: nullable column rpa_retry_queue.% missing', c;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'public.rpa_retry_queue'::regclass AND a.attname = 'release_count'
                    AND NOT a.attisdropped AND a.attnotnull AND pg_get_expr(d.adbin, d.adrelid) = '0') THEN
    RAISE EXCEPTION 'RPA-CLAIM postcondition: rpa_retry_queue.release_count must be NOT NULL DEFAULT 0';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.rpa_retry_queue'::regclass
                  AND conname = 'rpa_retry_queue_claim_shape' AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION 'RPA-CLAIM postcondition: rpa_retry_queue_claim_shape missing or not validated';
  END IF;
  FOREACH f IN ARRAY fns LOOP
    SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config FROM pg_proc p WHERE p.oid = f;
    IF v_secdef THEN
      RAISE EXCEPTION 'RPA-CLAIM postcondition: % must be SECURITY INVOKER', f;
    END IF;
    IF v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public'] THEN
      RAISE EXCEPTION 'RPA-CLAIM postcondition: % proconfig must be exactly {search_path=pg_catalog, public}, found %', f, coalesce(v_config::text, '{}');
    END IF;
    SELECT array_agg(DISTINCT coalesce(r.rolname, 'PUBLIC')) INTO v_leaked
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE p.oid = f AND a.privilege_type = 'EXECUTE'
       AND (a.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'authenticator'));
    IF v_leaked IS NOT NULL THEN
      RAISE EXCEPTION 'RPA-CLAIM postcondition: EXECUTE on % must not be held by %', f, v_leaked;
    END IF;
    SELECT count(*) INTO v_n
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid = a.grantee
     WHERE p.oid = f AND a.privilege_type = 'EXECUTE' AND r.rolname = 'service_role';
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'RPA-CLAIM postcondition: service_role must hold EXECUTE on % in its ACL', f;
    END IF;
  END LOOP;
END
$verify$;

COMMIT;
