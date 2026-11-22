-- ROLLBACK STEP 1 of 3 for 20270222000001_community_ai_actions_linkedin_new_dm.sql - run BEFORE deploying the previous
-- server build (review B3, 2026-11-22).
--
-- Why first: the previous build's GET /api/extension/commands filters only (company, pending, browser). An approved and
-- executed new-DM row would then be handed to ANY session of the company - and an old v1.3.9 extension, which has no DM
-- refusal, could send it from the WRONG LinkedIn account.
--
--   1. this file: every OPEN new-DM row that was NEVER claimed -> 'skipped' (provably unsent). Refuses if a CLAIMED
--      open row exists (its delivery is unknown: an operator decides; it is never released to anyone).
--   2. deploy the previous server build.
--   3. supabase/migrations/rollbacks/community_ai_actions_linkedin_new_dm_rollback.sql (drops the index, constraint and columns).

BEGIN;

UPDATE public.community_ai_actions
   SET status = 'skipped', skip_reason = 'rollback: linkedin new dm withdrawn before the previous build', updated_at = now()
 WHERE dm_lead_id IS NOT NULL
   -- Not 'executing': an executor may be writing that row right now and would overwrite 'skipped' (review 3 N-b). It
   -- stays open, so the guard below refuses; run this file again once execution has finished.
   AND status IN ('pending', 'approved', 'dispatched', 'acknowledged')
   AND dispatch_lease_id IS NULL
   AND dispatch_acknowledged_at IS NULL;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.community_ai_actions
              WHERE dm_lead_id IS NOT NULL
                AND status IN ('pending', 'approved', 'dispatched', 'acknowledged', 'executing')) THEN
    RAISE EXCEPTION 'LND rollback prepare refused: a new LinkedIn DM is CLAIMED (delivery unknown - an operator resolves it) or still EXECUTING (re-run this file shortly)';
  END IF;
END
$guard$;

COMMIT;
