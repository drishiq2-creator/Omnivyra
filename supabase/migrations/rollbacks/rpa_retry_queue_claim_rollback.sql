-- ROLLBACK for 20270314000001_rpa_retry_queue_claim.sql
--
-- Restores the pre-migration shape of public.rpa_retry_queue: no claim columns,
-- no claim/accept/finalize/park/renew/release/remaining functions, no release_count.
--
-- REFUSES while any row is claimed (claim_token IS NOT NULL): such a row is being
-- executed (or its lease expired and it has not been parked yet). Dropping the
-- columns would erase the only record that it may already have run. Wait for the
-- worker to finalise, or call public.park_expired_rpa_retry_claims() once the
-- leases expire, then re-run this file.
--
-- DATA: success tombstones (completed_at IS NOT NULL) are DELETED, because the
-- pre-migration code deleted a row on success and would otherwise read a
-- tombstone (attempts = max_attempts) as a dead-lettered failure. Parked
-- outcome-unknown rows (including expired claims, last_error
-- 'RPA_OUTCOME_UNKNOWN:CLAIM_EXPIRED ...') are kept: they are the same shape the
-- old code parks, so they keep their meaning. claimed_by / claimed_at evidence on
-- those rows is lost with the columns; copy it out first if it is needed.
--
-- APPLY only after explicit authorization: psql -v ON_ERROR_STOP=1 -f <this file>
-- Deploy the pre-migration application code first (the new code calls the
-- functions dropped here), with no overlap: stop the new worker before the old one
-- starts (docs/runbooks/phase-c-browser-execution-deploy.md).

BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.rpa_retry_queue WHERE claim_token IS NOT NULL) THEN
    RAISE EXCEPTION 'RPA-CLAIM rollback: % row(s) still claimed - nothing changed',
      (SELECT count(*) FROM public.rpa_retry_queue WHERE claim_token IS NOT NULL);
  END IF;
END
$guard$;

DROP FUNCTION IF EXISTS public.rpa_retry_queue_accept(uuid, uuid, text, text, text, text, text, integer);
DROP FUNCTION IF EXISTS public.claim_rpa_retry_queue(text, integer, integer, uuid);
DROP FUNCTION IF EXISTS public.finalize_rpa_retry_queue_claim(uuid, uuid, text, text, integer, boolean);
DROP FUNCTION IF EXISTS public.park_expired_rpa_retry_claims();
DROP FUNCTION IF EXISTS public.renew_rpa_retry_queue_claim(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.release_rpa_retry_queue_claim(uuid, uuid, text, integer);
DROP FUNCTION IF EXISTS public.count_rpa_retry_queue_remaining();

DELETE FROM public.rpa_retry_queue WHERE completed_at IS NOT NULL;

DROP INDEX IF EXISTS public.idx_rpa_retry_queue_claim_expires;
ALTER TABLE public.rpa_retry_queue DROP CONSTRAINT IF EXISTS rpa_retry_queue_claim_shape;
ALTER TABLE public.rpa_retry_queue
  DROP COLUMN IF EXISTS claim_token,
  DROP COLUMN IF EXISTS claimed_by,
  DROP COLUMN IF EXISTS claimed_at,
  DROP COLUMN IF EXISTS claim_expires_at,
  DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS release_count;

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rpa_retry_queue'::regclass
              AND attname IN ('claim_token', 'claimed_by', 'claimed_at', 'claim_expires_at', 'completed_at', 'release_count')
              AND NOT attisdropped) THEN
    RAISE EXCEPTION 'RPA-CLAIM rollback postcondition: claim columns still present';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('rpa_retry_queue_accept', 'claim_rpa_retry_queue',
                                  'finalize_rpa_retry_queue_claim', 'park_expired_rpa_retry_claims',
                                  'renew_rpa_retry_queue_claim', 'release_rpa_retry_queue_claim',
                                  'count_rpa_retry_queue_remaining')) THEN
    RAISE EXCEPTION 'RPA-CLAIM rollback postcondition: claim functions still present';
  END IF;
END
$verify$;

COMMIT;
