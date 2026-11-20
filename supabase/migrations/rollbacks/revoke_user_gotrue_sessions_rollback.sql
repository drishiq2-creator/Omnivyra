-- Rollback of 20270217000070_revoke_user_gotrue_sessions. Drops ONLY that function (the apply refused if it already
-- existed, so a function of that signature was created by it). Sessions already deleted / tokens already revoked are
-- NOT restored - they were revoked on purpose.
BEGIN;
DROP FUNCTION IF EXISTS public.revoke_user_gotrue_sessions(uuid);
COMMIT;
