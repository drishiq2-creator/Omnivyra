-- 20270209000000 data_source_usage_ledger (reserved by virality-83, 2026-11-10)
--
-- PI mode B / owner "Data sources & usage" (2026-11-10): every data source must
-- be visible to the tenant, so they can reconcile against the vendor's own usage
-- page and see the value they got: per vendor, per user, per period, per run.
-- The view READS the existing ledgers; this migration only adds what they do not
-- hold yet. No parallel ledger, no backfill.
--
-- ─── 1. ADDITIVE NULLABLE COLUMNS ON TWO APPLIED TABLES ───────────────────
-- APPLIED STATUS (virality-83 C1, production catalogue, owner-approved,
-- 2026-11-10): CONFIRMED. Both tables EXIST in public (relkind r), with no
-- triggers or rules. prospect_enrichment_attempts has none of the new columns.
-- prospect_discovery_attempts ALREADY has provider_cost_units integer NULL and
-- provider_cost_state text NOT NULL default 'unknown', with cost_units_consistent
-- (state <> 'unknown' OR units IS NULL), cost_units_nonnegative,
-- cost_state_valid, and ingested_within_observed (ingested <= observed). This
-- file changes none of those; pda_screening_within_observed coexists with
-- ingested_within_observed, and the rollback never drops the existing ones.
-- The usage writer never writes discovery provider_cost_units: the existing
-- page writer owns it, together with provider_cost_state.
-- This version itself: never applied anywhere.
-- Adding a NULLABLE column without a default is a catalog-only change on PG11+
-- (no table rewrite); a new column inherits the table's ACL, so no grant moves.
--
-- prospect_enrichment_attempts:
--   provider_cost_units  integer  what the VENDOR billed for this call, in the
--                                 vendor's own unit (e.g. Apollo credits). The
--                                 SAME name and meaning as the column
--                                 prospect_discovery_attempts already has, so one
--                                 fact has one name across both ledgers (PI
--                                 review (a)).
--   funding              text     'tenant' (the tenant's own key; the vendor
--                                 bills the tenant). OWN KEY ONLY (owner
--                                 2026-11-20): central access ('platform') is not
--                                 offered; PL-171 widens this CHECK when it is.
--   credits_charged      integer  Omnivyra credits charged for this call
--                                 (always 0 while vendors are own-key only).
--   initiated_by         uuid     the user who started it (GOV-H actor: no FK,
--                                 writer-validated; NULL for a system action).
-- prospect_discovery_attempts: the same funding, credits_charged, initiated_by
--   (it already has provider_cost_units), plus R3's screening counts, which
--   today exist only in the run's response:
--   results_skipped_duplicate, results_held_for_review, results_probe_unknown.
--
-- provider_cost_units and credits_charged are DIFFERENT facts and are NOT tied
-- by a CHECK: when the vendor answered but persistence failed, the vendor billed
-- us (units > 0) and the tenant was not charged (credits 0). That divergence is
-- the reason both exist.
--
-- (A second section, the prospect_capture_runs table for Sales Navigator capture totals, was REMOVED on
-- 2026-11-20 before this version was ever applied (cb C159: absent in production) - capture is PL-170.)

BEGIN;

ALTER TABLE public.prospect_enrichment_attempts
  ADD COLUMN IF NOT EXISTS provider_cost_units integer,
  ADD COLUMN IF NOT EXISTS funding text,
  ADD COLUMN IF NOT EXISTS credits_charged integer,
  ADD COLUMN IF NOT EXISTS initiated_by uuid;

ALTER TABLE public.prospect_discovery_attempts
  ADD COLUMN IF NOT EXISTS funding text,
  ADD COLUMN IF NOT EXISTS credits_charged integer,
  ADD COLUMN IF NOT EXISTS initiated_by uuid,
  ADD COLUMN IF NOT EXISTS results_skipped_duplicate integer,
  ADD COLUMN IF NOT EXISTS results_held_for_review integer,
  ADD COLUMN IF NOT EXISTS results_probe_unknown integer;

DO $checks$
BEGIN
  -- NOT VALID (PI review, 2026-11-11): both attempt tables are applied and grow
  -- per call, and their row counts are unmeasured. A plain ADD CONSTRAINT would
  -- scan every existing row while this transaction holds ACCESS EXCLUSIVE (taken
  -- by ADD COLUMN and held to COMMIT), stalling writes during a production apply.
  -- NOT VALID enforces on every NEW or UPDATED row immediately and scans nothing.
  -- The VALIDATE step is a SEPARATE migration (20270209000001), run in its own transaction under
  -- SHARE UPDATE EXCLUSIVE (writes continue). Every existing row passes: the new
  -- columns are NULL and the coalesce sums reduce to ingested_within_observed.
  -- enrichment attempts
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pea_funding_valid') THEN
    ALTER TABLE public.prospect_enrichment_attempts ADD CONSTRAINT pea_funding_valid
      CHECK (funding IS NULL OR funding IN ('tenant')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pea_cost_units_nonnegative') THEN
    ALTER TABLE public.prospect_enrichment_attempts ADD CONSTRAINT pea_cost_units_nonnegative
      CHECK (provider_cost_units IS NULL OR provider_cost_units >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pea_credits_nonnegative') THEN
    ALTER TABLE public.prospect_enrichment_attempts ADD CONSTRAINT pea_credits_nonnegative
      CHECK (credits_charged IS NULL OR credits_charged >= 0) NOT VALID;
  END IF;
  -- Own key => never Omnivyra credits. NULL-tolerant for existing rows.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pea_tenant_funding_uncharged') THEN
    ALTER TABLE public.prospect_enrichment_attempts ADD CONSTRAINT pea_tenant_funding_uncharged
      CHECK (funding IS DISTINCT FROM 'tenant' OR coalesce(credits_charged, 0) = 0) NOT VALID;
  END IF;
  -- discovery attempts
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pda_funding_valid') THEN
    ALTER TABLE public.prospect_discovery_attempts ADD CONSTRAINT pda_funding_valid
      CHECK (funding IS NULL OR funding IN ('tenant')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pda_credits_nonnegative') THEN
    ALTER TABLE public.prospect_discovery_attempts ADD CONSTRAINT pda_credits_nonnegative
      CHECK (credits_charged IS NULL OR credits_charged >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pda_tenant_funding_uncharged') THEN
    ALTER TABLE public.prospect_discovery_attempts ADD CONSTRAINT pda_tenant_funding_uncharged
      CHECK (funding IS DISTINCT FROM 'tenant' OR coalesce(credits_charged, 0) = 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pda_screening_nonnegative') THEN
    ALTER TABLE public.prospect_discovery_attempts ADD CONSTRAINT pda_screening_nonnegative
      CHECK (coalesce(results_skipped_duplicate, 0) >= 0 AND coalesce(results_held_for_review, 0) >= 0
             AND coalesce(results_probe_unknown, 0) >= 0) NOT VALID;
  END IF;
  -- R3: everything the screen decided cannot exceed what was observed. coalesce
  -- lets an existing row (NULLs) pass while a new row cannot lie (PI review (b)).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pda_screening_within_observed') THEN
    ALTER TABLE public.prospect_discovery_attempts ADD CONSTRAINT pda_screening_within_observed
      CHECK (results_ingested + coalesce(results_skipped_duplicate, 0) + coalesce(results_held_for_review, 0)
             + coalesce(results_probe_unknown, 0) <= results_observed) NOT VALID;
  END IF;
END
$checks$;

-- POSTCONDITIONS (each RAISEs; trip input named).
DO $verify$
DECLARE
  p text;
BEGIN
  -- (1) the new attempt-table constraints exist (NOT VALID here; validated by the
  --     follow-on VALIDATE migration, whose postcondition checks convalidated).
  FOREACH p IN ARRAY ARRAY['pea_funding_valid', 'pea_cost_units_nonnegative', 'pea_credits_nonnegative',
      'pea_tenant_funding_uncharged', 'pda_funding_valid', 'pda_credits_nonnegative', 'pda_tenant_funding_uncharged',
      'pda_screening_nonnegative', 'pda_screening_within_observed'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = p) THEN
      RAISE EXCEPTION 'usage postcondition: constraint % is missing', p; END IF;
  END LOOP;
  -- (2) initiated_by: no FK anywhere (GOV-H). Trips on any FK on those columns.
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
             WHERE c.contype = 'f' AND a.attname = 'initiated_by'
               AND c.conrelid IN ('public.prospect_enrichment_attempts'::regclass, 'public.prospect_discovery_attempts'::regclass)) THEN
    RAISE EXCEPTION 'usage postcondition: initiated_by must not carry a foreign key'; END IF;
END
$verify$;

COMMIT;
