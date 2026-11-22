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
--
-- This version: never applied anywhere.

BEGIN;

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
    -- Both columns NULL on every existing row, so this validates without touching data.
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
    );
  END IF;
END
$checks$;

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
END
$postcondition$;

COMMIT;
