-- ROLLBACK STEP 3 of 3 for 20270222000001_community_ai_actions_linkedin_new_dm.sql.
--
-- Order (review B3, 2026-11-22):
--   1. scripts/migrations/ops/community_ai_actions_linkedin_new_dm_withdraw_open.sql - withdraw every open, never-claimed new DM;
--   2. deploy the previous server build (it never reads these columns);
--   3. this file. LOSSY: the lead and sender binding of past new DMs is dropped.
-- Refuses while any new DM is still open (step 1 not run, or a claimed one is unresolved).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'community_ai_actions' AND column_name = 'dm_lead_id') THEN
    IF EXISTS (SELECT 1 FROM public.community_ai_actions
                WHERE dm_lead_id IS NOT NULL
                  AND status IN ('pending', 'approved', 'dispatched', 'acknowledged', 'executing')) THEN
      RAISE EXCEPTION 'LND rollback refused: a new LinkedIn DM is still open - run the prepare step first';
    END IF;
  END IF;
END
$guard$;

DROP INDEX IF EXISTS public.community_ai_actions_one_open_linkedin_new_dm;
ALTER TABLE public.community_ai_actions DROP CONSTRAINT IF EXISTS community_ai_actions_linkedin_new_dm_shape;
ALTER TABLE public.community_ai_actions DROP COLUMN IF EXISTS dm_sender_member_id;
ALTER TABLE public.community_ai_actions DROP COLUMN IF EXISTS dm_lead_id;

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'community_ai_actions'
              AND column_name IN ('dm_lead_id', 'dm_sender_member_id')) THEN
    RAISE EXCEPTION 'LND rollback postcondition: a column is still present';
  END IF;
  IF to_regclass('public.community_ai_actions_one_open_linkedin_new_dm') IS NOT NULL THEN
    RAISE EXCEPTION 'LND rollback postcondition: the open-request index is still present';
  END IF;
END
$verify$;

COMMIT;
