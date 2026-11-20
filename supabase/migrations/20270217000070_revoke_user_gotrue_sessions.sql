-- 20270217000070 revoke_user_gotrue_sessions (b3 ruling 2026-11-20, step 2 of the bearer-session fix; PL-102).
--
-- WHY: a "revoke all" must also end Supabase (GoTrue) sessions, or an outstanding REFRESH token mints a new access
-- token after the users.session_revoked_after epoch bump. supabase-js cannot do it by user id
-- (auth.admin.signOut takes the user's own JWT), so recovery-login, admin MFA reset and super-admin force-logout
-- could not revoke refresh tokens at all. This function does it by user id, for every revoke-all path.
--
-- WHAT (shape read from production, cb C138): deleting the user's auth.sessions rows cascades their refresh tokens
-- (refresh_tokens_session_id_fkey ON DELETE CASCADE). Legacy refresh tokens with session_id NULL are NOT reached by
-- the cascade, so they are marked revoked = true (UPDATE, not DELETE: GoTrue checks `revoked` when a refresh token is
-- presented, and keeping the row preserves its reuse-detection history). refresh_tokens.user_id is VARCHAR - compared
-- as text. The access JWTs already issued are NOT touched here: the epoch bump (invalidate_user_sessions) covers them.
--
-- Takes the PUBLIC users.id (what every caller has) and resolves the GoTrue uid (users.supabase_uid). A user with no
-- auth identity revokes nothing and says so.
--
-- ENVELOPE (053 pattern): SECURITY DEFINER, search_path pinned, EXECUTE for service_role only; the preflight REFUSES
-- (never adopts) if the function already exists or if the auth schema differs from C138, or if the owner cannot
-- write the GoTrue tables; the postcondition checks prosecdef, proconfig (exact), and effective privileges.
BEGIN;

DO $pre$
DECLARE
  v_t text;
BEGIN
  IF to_regprocedure('public.revoke_user_gotrue_sessions(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'revoke_user_gotrue_sessions already exists - refusing to adopt it';
  END IF;
  IF to_regclass('auth.sessions') IS NULL OR to_regclass('auth.refresh_tokens') IS NULL THEN
    RAISE EXCEPTION 'GoTrue auth.sessions / auth.refresh_tokens missing - schema differs from C138';
  END IF;
  -- column shapes (C138)
  FOR v_t IN
    SELECT format('%s.%s=%s', c.table_name, c.column_name, c.data_type)
      FROM (VALUES ('sessions','id','uuid'), ('sessions','user_id','uuid'),
                   ('refresh_tokens','user_id','character varying'), ('refresh_tokens','session_id','uuid'),
                   ('refresh_tokens','revoked','boolean')) AS want(t, col, typ)
      LEFT JOIN information_schema.columns c
        ON c.table_schema = 'auth' AND c.table_name = want.t AND c.column_name = want.col
     WHERE c.data_type IS DISTINCT FROM want.typ
  LOOP
    RAISE EXCEPTION 'auth schema differs from C138: %', v_t;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'auth.refresh_tokens'::regclass AND contype = 'f'
       AND confrelid = 'auth.sessions'::regclass AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'auth.refresh_tokens -> auth.sessions is not ON DELETE CASCADE - schema differs from C138';
  END IF;
  IF NOT has_table_privilege(current_user, 'auth.sessions', 'DELETE')
     OR NOT has_table_privilege(current_user, 'auth.refresh_tokens', 'UPDATE') THEN
    RAISE EXCEPTION 'the migration owner (%) cannot DELETE auth.sessions / UPDATE auth.refresh_tokens', current_user;
  END IF;
END
$pre$;

CREATE FUNCTION public.revoke_user_gotrue_sessions(p_user_id uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
DECLARE
  v_uid uuid;
  v_sessions integer;
  v_legacy integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'REVOKE_USER_GOTRUE_SESSIONS_NULL_USER';
  END IF;
  SELECT u.supabase_uid INTO v_uid FROM public.users u WHERE u.id = p_user_id;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('auth_identity', false, 'sessions_deleted', 0, 'legacy_refresh_tokens_revoked', 0);
  END IF;
  WITH d AS (DELETE FROM auth.sessions s WHERE s.user_id = v_uid RETURNING 1)
  SELECT count(*) INTO v_sessions FROM d;
  WITH r AS (
    UPDATE auth.refresh_tokens t SET revoked = true
     WHERE t.user_id = v_uid::text AND t.session_id IS NULL AND t.revoked IS DISTINCT FROM true
    RETURNING 1)
  SELECT count(*) INTO v_legacy FROM r;
  RETURN jsonb_build_object('auth_identity', true, 'sessions_deleted', v_sessions, 'legacy_refresh_tokens_revoked', v_legacy);
END
$fn$;

REVOKE ALL ON FUNCTION public.revoke_user_gotrue_sessions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_user_gotrue_sessions(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_user_gotrue_sessions(uuid) TO service_role;

DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.revoke_user_gotrue_sessions(uuid)');
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'revoke_user_gotrue_sessions postcondition: function missing';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_oid) THEN
    RAISE EXCEPTION 'revoke_user_gotrue_sessions postcondition: not SECURITY DEFINER';
  END IF;
  IF (SELECT p.proconfig FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
    RAISE EXCEPTION 'revoke_user_gotrue_sessions postcondition: proconfig is not exactly {search_path=pg_catalog, pg_temp}';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'revoke_user_gotrue_sessions postcondition: a client role can EXECUTE it';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'revoke_user_gotrue_sessions postcondition: service_role cannot EXECUTE it';
  END IF;
END
$post$;

COMMIT;
