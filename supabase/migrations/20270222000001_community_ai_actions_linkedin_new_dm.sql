-- 20270222000001 community_ai_actions_linkedin_new_dm (b3, owner-approved 2026-11-22: "Message on LinkedIn" from a
-- lead in Prospects, through the existing approved-actions workflow, sent by the Omnivyra Sales Navigator extension)
--
-- A NEW LinkedIn DM to a lead is an ordinary community_ai_actions row (platform 'linkedin', action_type 'dm'), approved
-- through the existing approve/execute routes. Two nullable columns tie it to WHAT and WHO, recorded when the user
-- asks, so the approval record names the intended sender and their LinkedIn account:
--   dm_lead_id           the Prospect (canonical_leads.id) the message is for
--   dm_sender_member_id  the sender's linked LinkedIn account (canonical member id, from salesnav_member_bindings)
-- acting_user_id (existing column) is the sending user. The executor builds a start_new_dm step only for such rows,
-- and GET /api/extension/commands hands them only to that user's Sales Navigator extension bound to that account.
--
-- EXPAND only: two nullable columns + CHECKs that hold trivially for every existing row (both columns NULL). No grant
-- changes (columns inherit the table's privileges). Old code never reads or writes them.
-- CAVEAT (review B3): old code is NOT safe once an approved new-DM row exists - its hand-out would offer that row to any
-- session of the company. A rollback therefore starts with scripts/migrations/ops/
-- community_ai_actions_linkedin_new_dm_withdraw_open.sql BEFORE the previous build is deployed (see the rollback file).
-- DEPLOY ORDER (review B2): apply 20270222000000 and this file BEFORE deploying the code that reads them - the command
-- hand-out, the abandoned-dispatch recovery and pairing all depend on them.
--
-- HOW TO APPLY (review 3 M1): this file mixes two transactions with a CREATE INDEX CONCURRENTLY, which cannot run
-- inside a transaction block. Apply it ONLY with `psql -v ON_ERROR_STOP=1 -f <file>` (as the CI replay does), or
-- statement by statement. NEVER as one query - `psql -c "$(cat file)"`, `supabase db push`, or the whole file in ONE
-- Management-API call: that is one implicit transaction, so the index step fails AFTER the first transaction has
-- committed (measured on PG17, 2026-11-22: columns + NOT VALID CHECK present, no index). Do not use `psql -1` either:
-- it only works because this file's own COMMIT ends psql's wrapper. Re-running with `psql -f` after a failure at any
-- step converges (the index step drops a half-built index first - review 3 M2; measured).
--
-- This version: never applied anywhere.

BEGIN;
-- Never wait long for the table lock (an extension poll or the executor may hold it): fail and retry the apply.
SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regclass('public.community_ai_actions') IS NULL THEN
    RAISE EXCEPTION 'LND preflight: public.community_ai_actions is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'community_ai_actions' AND column_name = 'acting_user_id') THEN
    RAISE EXCEPTION 'LND preflight: community_ai_actions.acting_user_id is missing - the sender cannot be bound';
  END IF;
  -- Adopt nothing of an unknown shape: either both columns are absent, or this migration already ran exactly.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'community_ai_actions'
                AND ((column_name = 'dm_lead_id' AND data_type <> 'uuid') OR (column_name = 'dm_sender_member_id' AND data_type <> 'text'))) THEN
    RAISE EXCEPTION 'LND preflight: dm_lead_id / dm_sender_member_id exist with a different type';
  END IF;
END
$preflight$;

ALTER TABLE public.community_ai_actions
  ADD COLUMN IF NOT EXISTS dm_lead_id uuid,
  ADD COLUMN IF NOT EXISTS dm_sender_member_id text;

COMMENT ON COLUMN public.community_ai_actions.dm_lead_id IS
  'A NEW LinkedIn DM to this Prospect (canonical_leads.id), requested via "Message on LinkedIn". NULL for every other action.';
COMMENT ON COLUMN public.community_ai_actions.dm_sender_member_id IS
  'The sender''s linked LinkedIn account (canonical member id) for a new LinkedIn DM; only that account may send it.';

DO $checks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_ai_actions_linkedin_new_dm_shape'
                  AND conrelid = 'public.community_ai_actions'::regclass) THEN
    -- NOT VALID here (a brief lock, no scan); VALIDATE runs in its own transaction below under a weaker lock
    -- (review N6). New rows are checked from this moment either way.
    ALTER TABLE public.community_ai_actions ADD CONSTRAINT community_ai_actions_linkedin_new_dm_shape CHECK (
      (dm_lead_id IS NULL AND dm_sender_member_id IS NULL)
      OR (
        dm_lead_id IS NOT NULL
        AND platform = 'linkedin'
        AND action_type = 'dm'
        AND acting_user_id IS NOT NULL
        -- IS NOT NULL is required: a regex match on NULL is NULL, which a CHECK treats as passing (local replay
        -- 2026-11-22 caught a new DM with no sender account being accepted).
        AND dm_sender_member_id IS NOT NULL
        AND dm_sender_member_id ~ '^ACoAA[A-Za-z0-9_-]{10,80}$'
        AND target_id ~ '^https://www\.linkedin\.com/in/[A-Za-z0-9_%-]{1,100}/$'
      )
    ) NOT VALID;
  END IF;
END
$checks$;

COMMIT;

-- One OPEN request per (company, lead, sending user) (review N1): closes the request route's select-then-insert race.
-- The open statuses are the ones a new DM can be in ('scheduled' is not: a new DM is never scheduled - the actions
-- route refuses it). CONCURRENTLY: built without blocking writes (it cannot run inside a transaction block). Only
-- new-DM rows are indexed.
-- A failed earlier CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would skip; drop it first so a re-run
-- heals itself (review 3 M2). The file is never applied anywhere yet, so this drops nothing in use.
DROP INDEX CONCURRENTLY IF EXISTS public.community_ai_actions_one_open_linkedin_new_dm;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS community_ai_actions_one_open_linkedin_new_dm
  ON public.community_ai_actions (organization_id, dm_lead_id, acting_user_id)
  WHERE dm_lead_id IS NOT NULL AND status IN ('pending', 'approved', 'dispatched', 'acknowledged', 'executing');

BEGIN;
SET LOCAL lock_timeout = '5s';
-- SHARE UPDATE EXCLUSIVE: reads and writes continue while existing rows are checked (all have both columns NULL).
ALTER TABLE public.community_ai_actions VALIDATE CONSTRAINT community_ai_actions_linkedin_new_dm_shape;

DO $postcondition$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'community_ai_actions'
     AND ((column_name = 'dm_lead_id' AND data_type = 'uuid' AND is_nullable = 'YES')
       OR (column_name = 'dm_sender_member_id' AND data_type = 'text' AND is_nullable = 'YES'));
  IF v_n <> 2 THEN RAISE EXCEPTION 'LND postcondition: expected 2 nullable columns, found %', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_ai_actions_linkedin_new_dm_shape'
                  AND conrelid = 'public.community_ai_actions'::regclass AND convalidated) THEN
    RAISE EXCEPTION 'LND postcondition: community_ai_actions_linkedin_new_dm_shape missing or not validated';
  END IF;
  -- A CONCURRENTLY build that failed leaves an INVALID index: refuse rather than run without the guard.
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE c.relname = 'community_ai_actions_one_open_linkedin_new_dm' AND i.indisvalid AND i.indisunique) THEN
    RAISE EXCEPTION 'LND postcondition: community_ai_actions_one_open_linkedin_new_dm missing, invalid or not unique (drop it and re-run)';
  END IF;
END
$postcondition$;

COMMIT;
