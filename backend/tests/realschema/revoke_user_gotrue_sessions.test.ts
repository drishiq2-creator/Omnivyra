/**
 * 20270217000070 revoke_user_gotrue_sessions (step 2 of the bearer-session fix; PL-102). On the replayed schema
 * (auth.sessions / auth.refresh_tokens stubbed in the C138 shape by scripts/ci/schema-bootstrap.sql):
 *   - the user's GoTrue sessions are deleted and their refresh tokens go with them (FK cascade);
 *   - a legacy refresh token (session_id NULL) is marked revoked (user_id VARCHAR compared as text);
 *   - ANOTHER user's sessions and tokens are untouched (control); a non-uuid user_id string never errors;
 *   - a user with no auth identity revokes nothing and says so;
 *   - envelope: SECURITY DEFINER, exact pinned search_path, EXECUTE for service_role only;
 *   - the migration's $pre$ refuses a differing schema / an existing function, and $post$ can fail.
 * A green run concerns a disposable database built from the committed baseline plus replayed migrations.
 */
import fs from 'fs';
import path from 'path';
import { db, inRollback } from './setup';

const MIG = fs.readFileSync(path.resolve(__dirname, '../../../supabase/migrations/20270217000070_revoke_user_gotrue_sessions.sql'), 'utf8');
function block(tag: string): string {
  const a = MIG.indexOf(`DO $${tag}$`);
  const b = MIG.indexOf(`$${tag}$;`, a + 5);
  if (a < 0 || b < 0) throw new Error(`$${tag}$ block not found`);
  return MIG.slice(a, b + tag.length + 3);
}
async function sqlstate(sql: string, params: unknown[] = []): Promise<string> {
  await db.query('SAVEPOINT s');
  try { await db.query(sql, params); await db.query('RELEASE SAVEPOINT s'); return 'ok'; }
  catch (e: any) { await db.query('ROLLBACK TO SAVEPOINT s'); return String(e?.code ?? 'error'); }
}

const UA = 'a1a1a1a1-0000-4000-8000-0000000000a1';
const UB = 'b2b2b2b2-0000-4000-8000-0000000000b2';
async function seedUser(email: string, authUid: string | null): Promise<string> {
  if (authUid) await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [authUid, email]);
  const { rows } = await db.query('INSERT INTO public.users (email, supabase_uid) VALUES ($1, $2) RETURNING id', [email, authUid]);
  return rows[0].id;
}
async function seedSession(uid: string, sid: string, tokens: number) {
  await db.query('INSERT INTO auth.sessions (id, user_id, created_at) VALUES ($1, $2, now())', [sid, uid]);
  for (let i = 0; i < tokens; i++) {
    await db.query('INSERT INTO auth.refresh_tokens (token, user_id, revoked, created_at, session_id) VALUES ($1, $2, false, now(), $3)', [`t-${sid}-${i}`, uid, sid]);
  }
}
const count = async (sql: string, p: unknown[]) => Number((await db.query(sql, p)).rows[0].n);

describe('revoke_user_gotrue_sessions', () => {
  it('deletes the user\'s sessions (tokens cascade), revokes legacy NULL-session tokens; another user is untouched', async () => {
    await inRollback(async () => {
      const a = await seedUser('a@gotrue.test', UA);
      await seedUser('b@gotrue.test', UB);
      await seedSession(UA, 'a0000000-0000-4000-8000-00000000000a', 2);
      await seedSession(UA, 'a0000000-0000-4000-8000-00000000000b', 1);
      await seedSession(UB, 'b0000000-0000-4000-8000-00000000000b', 2);
      await db.query("INSERT INTO auth.refresh_tokens (token, user_id, revoked, session_id) VALUES ('legacy-a', $1, false, NULL), ('legacy-b', $2, false, NULL), ('junk', 'not-a-uuid', false, NULL)", [UA, UB]);
      const { rows } = await db.query('SELECT public.revoke_user_gotrue_sessions($1) AS r', [a]);
      expect(rows[0].r).toEqual({ auth_identity: true, sessions_deleted: 2, legacy_refresh_tokens_revoked: 1 });
      expect(await count('SELECT count(*) n FROM auth.sessions WHERE user_id = $1', [UA])).toBe(0);
      expect(await count("SELECT count(*) n FROM auth.refresh_tokens WHERE user_id = $1 AND session_id IS NOT NULL", [UA])).toBe(0);
      expect(await count("SELECT count(*) n FROM auth.refresh_tokens WHERE token = 'legacy-a' AND revoked", [])).toBe(1);
      // CONTROL: the other user, and a non-uuid user_id string, are untouched
      expect(await count('SELECT count(*) n FROM auth.sessions WHERE user_id = $1', [UB])).toBe(1);
      expect(await count("SELECT count(*) n FROM auth.refresh_tokens WHERE user_id = $1 AND NOT revoked", [UB])).toBe(3);
      expect(await count("SELECT count(*) n FROM auth.refresh_tokens WHERE token = 'junk' AND NOT revoked", [])).toBe(1);
    });
  });

  it('a second call changes nothing (idempotent) and a user without an auth identity revokes nothing', async () => {
    await inRollback(async () => {
      const a = await seedUser('a2@gotrue.test', UA);
      await seedSession(UA, 'a0000000-0000-4000-8000-0000000000c1', 1);
      await db.query('SELECT public.revoke_user_gotrue_sessions($1)', [a]);
      const again = await db.query('SELECT public.revoke_user_gotrue_sessions($1) AS r', [a]);
      expect(again.rows[0].r).toEqual({ auth_identity: true, sessions_deleted: 0, legacy_refresh_tokens_revoked: 0 });
      const n = await seedUser('noauth@gotrue.test', null);
      expect((await db.query('SELECT public.revoke_user_gotrue_sessions($1) AS r', [n])).rows[0].r)
        .toEqual({ auth_identity: false, sessions_deleted: 0, legacy_refresh_tokens_revoked: 0 });
    });
  });

  it('envelope: SECURITY DEFINER, exact pinned search_path, EXECUTE for service_role only', async () => {
    const { rows } = await db.query(`SELECT p.prosecdef, p.proconfig,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
        has_function_privilege('public', p.oid, 'EXECUTE') AS public_x, has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.revoke_user_gotrue_sessions(uuid)')`);
    expect(rows).toEqual([{ prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], anon_x: false, auth_x: false, public_x: false, svc_x: true }]);
  });

  it('$pre$ refuses an existing function and a differing auth schema; $post$ fails when a client role can EXECUTE', async () => {
    await inRollback(async () => {
      expect(await sqlstate(block('pre'))).toBe('P0001'); // the function exists on the replayed schema
      await db.query('DROP FUNCTION public.revoke_user_gotrue_sessions(uuid)');
      expect(await sqlstate(block('pre'))).toBe('ok'); // control: the C138 shape passes once it is absent
      await db.query('ALTER TABLE auth.refresh_tokens ALTER COLUMN user_id TYPE uuid USING NULL');
      expect(await sqlstate(block('pre'))).toBe('P0001');
    });
    await inRollback(async () => {
      expect(await sqlstate(block('post'))).toBe('ok');
      await db.query('GRANT EXECUTE ON FUNCTION public.revoke_user_gotrue_sessions(uuid) TO anon');
      expect(await sqlstate(block('post'))).toBe('P0001');
    });
  });
});
