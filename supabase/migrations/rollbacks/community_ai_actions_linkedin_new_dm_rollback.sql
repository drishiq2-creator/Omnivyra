-- ROLLBACK for 20270222000001_community_ai_actions_linkedin_new_dm.sql
--
-- LOSSY for new-DM rows: drops the lead and sender binding. Deploy the previous server build FIRST, and refuse to run
-- while a new-DM row is still pending or approved (it would lose its sender binding and could be handed out wrongly).

BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'community_ai_actions' AND column_name = 'dm_lead_id') THEN
    IF EXISTS (SELECT 1 FROM public.community_ai_actions WHERE dm_lead_id IS NOT NULL AND status IN ('pending', 'approved')) THEN
      RAISE EXCEPTION 'LND rollback refused: a new LinkedIn DM is still pending or approved';
    END IF;
  END IF;
END
$guard$;

ALTER TABLE public.community_ai_actions DROP CONSTRAINT IF EXISTS community_ai_actions_linkedin_new_dm_shape;
ALTER TABLE public.community_ai_actions DROP COLUMN IF EXISTS dm_sender_member_id;
ALTER TABLE public.community_ai_actions DROP COLUMN IF EXISTS dm_lead_id;

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'community_ai_actions'
              AND column_name IN ('dm_lead_id', 'dm_sender_member_id')) THEN
    RAISE EXCEPTION 'LND rollback postcondition: a column is still present';
  END IF;
END
$verify$;

COMMIT;
