-- 20270301000001 api_idempotency_keys_updated_at_index
--
-- Age index for the (NOT YET ENABLED) terminal-row retention purge
-- purgeExpiredApiIdempotencyKeys() in
-- backend/services/billing/idempotency/apiIdempotencyKeyCleaner.ts.
-- This migration adds an index ONLY. It deletes nothing, schedules nothing and
-- changes no behaviour; the purge stays unwired until an owner decision.
--
-- The purge scan is
--   SELECT id, status, updated_at FROM api_idempotency_keys
--   WHERE status IN ('completed','failed') AND updated_at < $cutoff
--   ORDER BY updated_at, id LIMIT <=250
-- Without this index (only the primary key and the unique
-- (scope, caller_id, idempotency_key) index exist) that scan is a sequential
-- scan plus a top-N sort of every row. With it, one batch reads ~250 index
-- entries in (updated_at, id) order and stops.
--
-- WHY NOT PARTIAL (WHERE status IN ('completed','failed')): measured on a local
-- PostgreSQL 17 replay, a partial index is used by a custom plan but NOT by a
-- generic plan of the parameterised statement (`status = ANY($1)` cannot be
-- proven to imply the index predicate), which falls back to the seq scan. The
-- full index serves both plan kinds at the same size (processing rows are a
-- small, transient share), filtering `status` on the few rows it visits.
-- Evidence: docs/supabase-e2e-retirement/10-idempotency-retention-readiness.md.
--
-- `updated_at` is the last-activity clock: every middleware transition
-- (insert, takeover, failed->processing resume, finalize) and the stale-
-- processing cleaner set it in application code (backend/middleware/
-- withIdempotency.ts); no trigger touches this table.
--
-- NO BEGIN/COMMIT: CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- (same convention as 20270211000007). One statement per call.
-- SELF-HEALING: a failed concurrent build leaves an INVALID index that a bare
-- IF NOT EXISTS would skip on re-run, so DROP CONCURRENTLY IF EXISTS runs
-- first; a re-run always completes a partial application. IF NOT EXISTS on the
-- CREATE is kept for the migration-quality gate. The postcondition (last
-- statement) fails loudly if the index is missing or invalid.
--
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS public.api_idempotency_keys_updated_at_id_idx;

DROP INDEX CONCURRENTLY IF EXISTS public.api_idempotency_keys_updated_at_id_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS api_idempotency_keys_updated_at_id_idx
  ON public.api_idempotency_keys (updated_at, id);

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'api_idempotency_keys_updated_at_id_idx'
                    AND c.relkind = 'i') THEN
    RAISE EXCEPTION 'api_idempotency_keys_updated_at_id_idx postcondition: index is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'api_idempotency_keys_updated_at_id_idx'
                    AND i.indisvalid) THEN
    RAISE EXCEPTION 'api_idempotency_keys_updated_at_id_idx postcondition: index exists but is INVALID (its concurrent build failed). Re-run this migration: it drops and rebuilds the index.';
  END IF;
END
$verify$;
