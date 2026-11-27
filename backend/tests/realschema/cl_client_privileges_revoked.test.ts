/**
 * CL-ACL — real-schema cover for
 * 20270301000010_content_learning_client_privileges_revoked.
 *
 * In this harness the four tables are created by the baseline-gap step AFTER
 * every migration (supabase/_schema/baseline-gap-migrations.txt), so the replay
 * ran this migration in its ABSENT mode, and the tables took the bootstrap's
 * default ACL (service_role only). The installed state therefore proves nothing
 * about the REVOKE. Every behavioural test recreates a shape first, ASSERTS it is
 * really there (control against a vacuous pass), runs the migration text, and
 * observes the result:
 *   - PRODUCTION shape (2026-11-27 read-only catalog): authenticated=arwdxtm on
 *     all four, set_content_updated_at() EXECUTE for authenticated, proconfig NULL;
 *   - REPLAY shape: all four tables absent;
 *   - PARTIAL / MOVED shapes: must refuse.
 * Everything runs inside inRollback(); BEGIN/COMMIT are stripped so nothing commits.
 *
 * CL_ACL_MIGRATION_FILE substitutes a mutated migration (failing controls).
 */
import fs from 'fs';
import path from 'path';
import { db, inRollback } from './setup';

const ROOT = path.resolve(__dirname, '../../..');
const stripTx = (sql: string) => sql.replace(/^\s*(BEGIN|COMMIT);\s*$/gim, '');
const RAW = fs.readFileSync(process.env.CL_ACL_MIGRATION_FILE
  || path.join(ROOT, 'supabase/migrations/20270301000010_content_learning_client_privileges_revoked.sql'), 'utf8');
const MIGRATION = stripTx(RAW);
const ROLLBACK = stripTx(fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/rollbacks/content_learning_client_privileges_revoked_rollback.sql'), 'utf8'));

function postBlock(): string {
  const start = RAW.indexOf('DO $post$');
  const end = RAW.indexOf('$post$;', start + 10);
  if (start < 0 || end < 0) throw new Error('postcondition block DO $post$ ... $post$; not found in the migration');
  return RAW.slice(start, end + '$post$;'.length);
}

const TABLES = ['content_performance', 'content_prediction', 'learning_intelligence', 'learning_memory'] as const;
const CLIENTS = ['anon', 'authenticated', 'authenticator'] as const;
const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const FN = 'public.set_content_updated_at()';

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

async function clientHoldings(): Promise<string[]> {
  const out: string[] = [];
  for (const t of TABLES) {
    for (const r of CLIENTS) {
      for (const p of PRIVS) {
        if ((await one(`SELECT has_table_privilege($1, $2, $3) v`, [r, `public.${t}`, p])).v) out.push(`${t}:${r}:${p}`);
      }
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
        if ((await one(`SELECT has_any_column_privilege($1, $2, $3) v`, [r, `public.${t}`, p])).v) out.push(`${t}:${r}:col-${p}`);
      }
    }
    const pub = await one(`SELECT count(*)::int n FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = $1::regclass AND a.grantee = 0`, [`public.${t}`]);
    if (pub.n > 0) out.push(`${t}:PUBLIC`);
  }
  return out.sort();
}

async function fnState(): Promise<any> {
  return one(`SELECT proconfig,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_x,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_x
    FROM pg_proc p WHERE p.oid = $1::regprocedure`, [FN]);
}

async function untouchedState(): Promise<any[]> {
  return (await db.query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
           (SELECT array_agg(a.grantee::regrole::text || '=' || a.privilege_type ORDER BY 1)
              FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
             WHERE a.grantee <> 0 AND a.grantee::regrole::text NOT IN ('anon', 'authenticated', 'authenticator')) AS other_acl,
           (SELECT array_agg(p.polname || ':' || p.polcmd::text || ':' || p.polroles::text || ':' || pg_get_expr(p.polqual, p.polrelid) ORDER BY 1)
              FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1)
     ORDER BY c.relname`, [TABLES as unknown as string[]])).rows;
}

/** Production's pre-image (2026-11-27), plus other client paths the REVOKE must also clear. */
async function prodPreImage(extra = true): Promise<void> {
  for (const t of TABLES) {
    await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.${t} TO authenticated`);
    if (extra) {
      await db.query(`GRANT ALL ON TABLE public.${t} TO anon`);
      await db.query(`GRANT SELECT ON TABLE public.${t} TO PUBLIC`);
      await db.query(`GRANT SELECT (company_id) ON TABLE public.${t} TO authenticator`);
    }
  }
  // Production's function ACL exactly: {postgres=X, authenticated=X, service_role=X}, no PUBLIC/anon (the CI
  // function is created by the gap step with the stock PUBLIC EXECUTE), proconfig NULL.
  await db.query(`REVOKE ALL ON FUNCTION ${FN} FROM PUBLIC, anon, authenticator`);
  await db.query(`GRANT EXECUTE ON FUNCTION ${FN} TO authenticated, service_role`);
  await db.query(`ALTER FUNCTION ${FN} RESET search_path`);
}

async function sqlstate(sql: string): Promise<string> {
  await db.query('SAVEPOINT cl');
  try {
    await db.query(sql);
    await db.query('RELEASE SAVEPOINT cl');
    return 'ok';
  } catch (e: any) {
    await db.query('ROLLBACK TO SAVEPOINT cl');
    return `${e.code ?? 'unknown'} ${String(e.message ?? '')}`;
  }
}

/** Runs sql as the given role; always returns to the session role. */
async function asRole(role: string, sql: string): Promise<string> {
  const r = await sqlstate(`SET LOCAL ROLE ${role}; ${sql}`);
  await db.query('RESET ROLE');
  return r;
}

async function withNotices<T>(body: () => Promise<T>): Promise<{ result: T; notices: string[] }> {
  const notices: string[] = [];
  const h = (n: any) => notices.push(`${n.severity}: ${n.message}`);
  db.on('notice', h);
  try {
    return { result: await body(), notices };
  } finally {
    db.removeListener('notice', h);
  }
}

describe('CL-ACL 20270301000010 — content/learning tables closed to every client role', () => {
  it('0. the four tables and the trigger function exist with RLS on (scenario exists before any refusal is asserted)', async () => {
    const r = (await db.query(`SELECT relname, relrowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY relname`, [TABLES as unknown as string[]])).rows;
    expect(r).toEqual(TABLES.map((relname) => ({ relname, relrowsecurity: true })).sort((a, b) => a.relname.localeCompare(b.relname)));
    expect((await one(`SELECT to_regprocedure($1) IS NOT NULL AS v`, [FN])).v).toBe(true);
  });

  it('1. replay end state (tables created by the gap step after this migration): no client table privilege; service_role keeps S/I/U', async () => {
    expect(await clientHoldings()).toEqual([]);
    for (const t of TABLES) {
      expect(await one(`SELECT has_table_privilege('service_role', $1, 'SELECT') s,
          has_table_privilege('service_role', $1, 'INSERT') i, has_table_privilege('service_role', $1, 'UPDATE') u`, [`public.${t}`]))
        .toEqual({ s: true, i: true, u: true });
    }
  });

  it('2. PRODUCTION shape: removes every client privilege, closes and pins the function, changes nothing else', async () => {
    await inRollback(async () => {
      const before = await untouchedState();
      await prodPreImage();
      const pre = await clientHoldings();
      // CONTROL: the pre-image is really there.
      expect(pre).toEqual(expect.arrayContaining([
        'content_performance:authenticated:DELETE', 'learning_memory:authenticated:MAINTAIN',
        'content_prediction:anon:TRUNCATE', 'learning_intelligence:PUBLIC', 'content_performance:authenticator:col-SELECT',
      ]));
      expect(pre).not.toContain('content_performance:authenticated:TRUNCATE'); // arwdxtm has no D
      expect(await fnState()).toEqual({ proconfig: null, auth_x: true, anon_x: false, sr_x: true, public_x: false });
      expect(await sqlstate(MIGRATION)).toBe('ok');
      expect(await clientHoldings()).toEqual([]);
      expect(await untouchedState()).toEqual(before);
      expect(await fnState()).toEqual({ proconfig: ['search_path=pg_catalog, public'], auth_x: false, anon_x: false, sr_x: true, public_x: false });
    });
  });

  it('3. exploitability: today a client is refused by user_company_roles; with one membership read path the tables open; after the migration the table itself refuses', async () => {
    await inRollback(async () => {
      await prodPreImage(false);
      // Today (production): the membership sub-select needs SELECT on user_company_roles, which no client has.
      expect(await asRole('authenticated', 'SELECT 1 FROM public.content_performance LIMIT 1'))
        .toMatch(/^42501 permission denied for table user_company_roles/);
      // Latent: one routine "read own memberships" grant + policy turns the FOR ALL policy into a read/WRITE path.
      await db.query('GRANT SELECT ON TABLE public.user_company_roles TO authenticated');
      await db.query('CREATE POLICY zz_cl_member_read ON public.user_company_roles FOR SELECT TO authenticated USING (user_id = auth.uid())');
      expect(await asRole('authenticated', 'SELECT 1 FROM public.content_performance LIMIT 1')).toBe('ok');
      expect(await asRole('authenticated', 'DELETE FROM public.learning_memory')).toBe('ok');
      // After the migration the privilege check on the table itself refuses, whatever user_company_roles allows.
      expect(await sqlstate(MIGRATION)).toBe('ok');
      for (const t of TABLES) {
        expect(await asRole('authenticated', `SELECT 1 FROM public.${t} LIMIT 1`)).toMatch(new RegExp(`^42501 permission denied for table ${t}`));
      }
      expect(await asRole('authenticated', 'DELETE FROM public.learning_memory')).toMatch(/^42501 permission denied for table learning_memory/);
    });
  });

  it('4. the trigger still fires through the client-closed, pinned function', async () => {
    await inRollback(async () => {
      await prodPreImage(false);
      expect(await sqlstate(MIGRATION)).toBe('ok');
      const id = '00000000-0000-4000-8000-0000000c1ac1';
      await db.query(`INSERT INTO public.learning_memory (company_id, updated_at) VALUES ($1, '2000-01-01')`, [id]);
      await db.query(`UPDATE public.learning_memory SET model_version = 2 WHERE company_id = $1`, [id]);
      const r = await one(`SELECT updated_at > '2001-01-01'::timestamptz AS touched FROM public.learning_memory WHERE company_id = $1`, [id]);
      expect(r).toEqual({ touched: true });
    });
  });

  it('5. idempotent: a second run is a no-op that still passes its own postcondition', async () => {
    await inRollback(async () => {
      await prodPreImage();
      expect(await sqlstate(MIGRATION)).toBe('ok');
      const once = [await clientHoldings(), await untouchedState(), await fnState()];
      expect(await sqlstate(MIGRATION)).toBe('ok');
      expect([await clientHoldings(), await untouchedState(), await fnState()]).toEqual(once);
    });
  });

  it('6. REPLAY shape (all four absent): changes no table, WARNS, still hardens the function', async () => {
    await inRollback(async () => {
      await prodPreImage(false);
      await db.query(`DROP TABLE ${TABLES.map((t) => `public.${t}`).join(', ')}`);
      expect((await one(`SELECT count(*)::int n FROM pg_class WHERE relname = ANY($1)`, [TABLES as unknown as string[]])).n).toBe(0); // CONTROL
      const { result, notices } = await withNotices(() => sqlstate(MIGRATION));
      expect(result).toBe('ok');
      expect(notices.some((n) => /^WARNING: CL-ACL: .* ALL absent - table REVOKE skipped/.test(n))).toBe(true);
      expect(notices.some((n) => /^NOTICE: CL-ACL: verified \(tables: absent\)/.test(n))).toBe(true);
      expect((await one(`SELECT count(*)::int n FROM pg_class WHERE relname = ANY($1)`, [TABLES as unknown as string[]])).n).toBe(0);
      expect(await fnState()).toEqual({ proconfig: ['search_path=pg_catalog, public'], auth_x: false, anon_x: false, sr_x: true, public_x: false });
    });
  });

  it('7. PARTIAL shape (one table missing): refuses and changes nothing', async () => {
    await inRollback(async () => {
      await prodPreImage(false);
      await db.query('DROP TABLE public.learning_memory');
      expect(await sqlstate(MIGRATION)).toMatch(/CL-ACL preflight: only 3 of the 4 tables exist in public/);
      expect(await one(`SELECT has_table_privilege('authenticated', 'public.content_performance', 'DELETE') d`)).toEqual({ d: true });
      expect((await fnState()).auth_x).toBe(true);
    });
  });

  it('8. MOVED shape (absent from public but present in another schema): refuses, never skips', async () => {
    await inRollback(async () => {
      await db.query('CREATE SCHEMA zz_cl_moved');
      for (const t of TABLES) await db.query(`ALTER TABLE public.${t} SET SCHEMA zz_cl_moved`);
      expect(await sqlstate(MIGRATION)).toMatch(/none of the four tables is in public, but 4 relation\(s\) of those names exist elsewhere/);
    });
  });

  it('9. refuses to pin a function whose body differs from the reviewed one', async () => {
    await inRollback(async () => {
      await db.query(`CREATE OR REPLACE FUNCTION ${FN} RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END; $$`);
      expect(await sqlstate(MIGRATION)).toMatch(/body differs from the reviewed one/);
    });
  });

  it('10. the postcondition (extracted from the file) trips on each surviving or missing privilege', async () => {
    const POST = postBlock();
    const cases: Array<[string, RegExp]> = [
      ['GRANT SELECT (company_id) ON TABLE public.content_performance TO authenticated', /authenticated still holds column-level SELECT on public\.content_performance/],
      ['GRANT DELETE ON TABLE public.learning_memory TO anon', /anon still holds DELETE on public\.learning_memory/],
      ['GRANT MAINTAIN ON TABLE public.content_prediction TO authenticator', /authenticator still holds MAINTAIN on public\.content_prediction/],
      ['GRANT SELECT ON TABLE public.learning_intelligence TO PUBLIC', /still holds (SELECT|column-level SELECT) on public\.learning_intelligence|PUBLIC still holds/],
      ['REVOKE UPDATE ON TABLE public.content_performance FROM service_role', /service_role lacks UPDATE on public\.content_performance/],
      ['REVOKE TRUNCATE ON TABLE public.learning_memory FROM service_role', /non-client ACL entries changed/],
      ['ALTER POLICY content_prediction_company_rw ON public.content_prediction TO service_role', /policies or non-client ACL entries changed/],
      [`GRANT EXECUTE ON FUNCTION ${FN} TO authenticated`, /authenticated can still EXECUTE public\.set_content_updated_at\(\)/],
      [`GRANT EXECUTE ON FUNCTION ${FN} TO PUBLIC`, /can still EXECUTE public\.set_content_updated_at\(\)/],
      [`ALTER FUNCTION ${FN} RESET search_path`, /search_path not pinned/],
      [`REVOKE EXECUTE ON FUNCTION ${FN} FROM service_role`, /owner, definer flag, body or non-client ACL changed/],
      ['ALTER TABLE public.learning_memory DISABLE TRIGGER learning_memory_set_updated_at', /learning_memory_set_updated_at is missing, disabled/],
    ];
    for (const [perturb, expected] of cases) {
      await inRollback(async () => {
        await prodPreImage();
        expect(await sqlstate(MIGRATION)).toBe('ok'); // sets the snapshot, passes clean
        expect(await sqlstate(POST)).toBe('ok');       // CONTROL: unperturbed state passes
        await db.query(perturb);
        expect(await sqlstate(POST)).toMatch(expected);
      });
    }
  });

  it('11. the rollback companion restores production\'s pre-image exactly (client entries and function)', async () => {
    await inRollback(async () => {
      await prodPreImage(false);
      const pre = [await clientHoldings(), await fnState()];
      expect(await sqlstate(MIGRATION)).toBe('ok');
      expect(await clientHoldings()).toEqual([]); // CONTROL: the migration really removed them
      expect(await sqlstate(ROLLBACK)).toBe('ok');
      expect([await clientHoldings(), await fnState()]).toEqual(pre);
    });
  });
});
