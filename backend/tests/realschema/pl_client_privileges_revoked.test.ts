/**
 * PL-ACL — real-schema cover for
 * 20270301000000_prospect_lists_client_privileges_revoked.
 *
 * The replay harness gives client roles NO default table privilege
 * (scripts/ci/schema-bootstrap.sql grants the hosted default to service_role
 * only), so the INSTALLED state proves nothing about the REVOKE on its own.
 * Every behavioural test therefore first recreates a client-granted pre-image
 * (production's 2026-11-10 ACL: authenticated=arwdxtm, plus anon/PUBLIC/
 * column grants the migration must also clear), ASSERTS that pre-image is
 * really there (the control against a vacuous pass), runs the migration text,
 * and observes the result. Everything runs inside inRollback(); the migration
 * text is executed without its own BEGIN/COMMIT so nothing is ever committed.
 *
 * PL_ACL_MIGRATION_FILE substitutes a mutated migration (failing controls).
 */
import fs from 'fs';
import path from 'path';
import { db, inRollback } from './setup';

const ROOT = path.resolve(__dirname, '../../..');
const stripTx = (sql: string) => sql.replace(/^\s*(BEGIN|COMMIT);\s*$/gim, '');
const RAW = fs.readFileSync(process.env.PL_ACL_MIGRATION_FILE
  || path.join(ROOT, 'supabase/migrations/20270301000000_prospect_lists_client_privileges_revoked.sql'), 'utf8');
const MIGRATION = stripTx(RAW);

/** The $post$ block, extracted from the file (never a copy); throws if it is missing. */
function postBlock(): string {
  const start = RAW.indexOf('DO $post$');
  const end = RAW.indexOf('$post$;', start + 10);
  if (start < 0 || end < 0) throw new Error('postcondition block DO $post$ ... $post$; not found in the migration');
  return RAW.slice(start, end + '$post$;'.length);
}

const TABLES = ['prospect_lists', 'prospect_list_members'] as const;
const CLIENTS = ['anon', 'authenticated', 'authenticator'] as const;
const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

/** Every privilege any client role (or PUBLIC) holds on the two tables, table- or column-level. */
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

/** Non-client ACL entries (service_role, postgres, ...), RLS flags and policies. */
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

/** Production's 2026-11-10 client entry, plus the other client paths the REVOKE must also clear. */
async function grantPreImage(): Promise<void> {
  for (const t of TABLES) {
    await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.${t} TO authenticated`);
    await db.query(`GRANT ALL ON TABLE public.${t} TO anon`);
    await db.query(`GRANT SELECT ON TABLE public.${t} TO PUBLIC`);
    await db.query(`GRANT SELECT (id, organization_id) ON TABLE public.${t} TO authenticator`);
  }
}

async function sqlstate(sql: string): Promise<string> {
  await db.query('SAVEPOINT pl');
  try {
    await db.query(sql);
    await db.query('RELEASE SAVEPOINT pl');
    return 'ok';
  } catch (e: any) {
    await db.query('ROLLBACK TO SAVEPOINT pl');
    return `${e.code ?? 'unknown'} ${String(e.message ?? '')}`;
  }
}

describe('PL-ACL 20270301000000 — prospect list tables are closed to every client role', () => {
  it('0. both tables exist with RLS on (the scenario exists before any refusal is asserted)', async () => {
    const r = (await db.query(`SELECT relname, relrowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY relname`, [TABLES as unknown as string[]])).rows;
    expect(r).toEqual([
      { relname: 'prospect_list_members', relrowsecurity: true },
      { relname: 'prospect_lists', relrowsecurity: true },
    ]);
  });

  it('1. installed state after the replay: no client privilege, service_role keeps SELECT/INSERT/UPDATE', async () => {
    expect(await clientHoldings()).toEqual([]);
    for (const t of TABLES) {
      const s = await one(`SELECT has_table_privilege('service_role', $1, 'SELECT') s,
          has_table_privilege('service_role', $1, 'INSERT') i, has_table_privilege('service_role', $1, 'UPDATE') u`, [`public.${t}`]);
      expect(s).toEqual({ s: true, i: true, u: true });
    }
  });

  it('2. from a client-granted pre-image the migration removes every client privilege and changes nothing else', async () => {
    await inRollback(async () => {
      const before = await untouchedState();
      await grantPreImage();
      const pre = await clientHoldings();
      // CONTROL: the pre-image is really there, so the post-state below is not vacuous.
      expect(pre).toEqual(expect.arrayContaining([
        'prospect_lists:authenticated:DELETE', 'prospect_list_members:authenticated:MAINTAIN',
        'prospect_lists:anon:TRUNCATE', 'prospect_lists:PUBLIC', 'prospect_list_members:authenticator:col-SELECT',
      ]));
      expect(await sqlstate(MIGRATION)).toBe('ok');
      expect(await clientHoldings()).toEqual([]);
      expect(await untouchedState()).toEqual(before);
    });
  });

  it('3. an authenticated PostgREST-style request is refused by PRIVILEGE (42501), not merely filtered by RLS', async () => {
    await inRollback(async () => {
      await grantPreImage();
      await db.query(MIGRATION);
      for (const t of TABLES) {
        const r = await sqlstate(`SET LOCAL ROLE authenticated; SELECT 1 FROM public.${t} LIMIT 1`);
        expect(r).toMatch(/^42501 permission denied for table/);
        await db.query('RESET ROLE');
      }
    });
  });

  it('4. idempotent: a second run is a no-op that still passes its own postcondition', async () => {
    await inRollback(async () => {
      await grantPreImage();
      expect(await sqlstate(MIGRATION)).toBe('ok');
      const once = [await clientHoldings(), await untouchedState()];
      expect(await sqlstate(MIGRATION)).toBe('ok');
      expect([await clientHoldings(), await untouchedState()]).toEqual(once);
    });
  });

  it('5. the postcondition (extracted from the file) trips on each surviving or missing privilege', async () => {
    const POST = postBlock();
    const cases: Array<[string, RegExp]> = [
      ['GRANT SELECT (name) ON TABLE public.prospect_lists TO authenticated', /authenticated still holds column-level SELECT on public\.prospect_lists/],
      ['GRANT DELETE ON TABLE public.prospect_list_members TO anon', /anon still holds DELETE on public\.prospect_list_members/],
      ['GRANT MAINTAIN ON TABLE public.prospect_lists TO authenticator', /authenticator still holds MAINTAIN on public\.prospect_lists/],
      ['GRANT SELECT ON TABLE public.prospect_list_members TO PUBLIC', /still holds (SELECT|column-level SELECT) on public\.prospect_list_members|PUBLIC still holds/],
      ['REVOKE UPDATE ON TABLE public.prospect_lists FROM service_role', /service_role lacks UPDATE on public\.prospect_lists/],
      ['REVOKE TRUNCATE ON TABLE public.prospect_list_members FROM service_role', /non-client ACL entries changed/],
      ['ALTER POLICY prospect_lists_service_role ON public.prospect_lists TO service_role', /policies or non-client ACL entries changed/],
    ];
    for (const [perturb, expected] of cases) {
      await inRollback(async () => {
        expect(await sqlstate(MIGRATION)).toBe('ok'); // sets the snapshot, passes clean
        expect(await sqlstate(POST)).toBe('ok');       // CONTROL: unperturbed state passes
        await db.query(perturb);
        expect(await sqlstate(POST)).toMatch(expected);
      });
    }
  });

  it('6. fails closed when a table is missing: nothing is revoked', async () => {
    await inRollback(async () => {
      await grantPreImage();
      await db.query('ALTER TABLE public.prospect_list_members RENAME TO zz_pl_members_hidden');
      expect(await sqlstate(MIGRATION)).toMatch(/PL-ACL preflight: public\.prospect_list_members does not exist/);
      // The surviving table keeps its pre-image: the refusal changed nothing.
      const still = await one(`SELECT has_table_privilege('authenticated', 'public.prospect_lists', 'DELETE') d,
          has_table_privilege('anon', 'public.zz_pl_members_hidden', 'TRUNCATE') t`);
      expect(still).toEqual({ d: true, t: true });
    });
  });
});
