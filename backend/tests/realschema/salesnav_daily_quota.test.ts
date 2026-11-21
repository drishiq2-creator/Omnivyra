/**
 * 20270217000074 salesnav_daily_quota - the Sales Navigator SHARED daily cap, on the real schema (cb checklist):
 * atomic all-or-nothing consume; a genuine two-session race at cap-1 yields EXACTLY ONE success (control: at cap-2
 * both succeed); the cap is bounded 1..200 and the member id must be canonical, in the database; no client role can
 * execute the function.
 * RE-KEYED 2026-11-21 (b3 ruling A): the count is per MEMBER (not per tenant); only the owning company (073
 * salesnav_member_owner) may consume - a non-owner gets 0 and writes nothing; a same-day ownership move carries the
 * count; the ownership check holds a lock on the owner row, so a transfer cannot interleave with a consume.
 */
import { Client } from 'pg';
import { db, seedTenants, ORG_A, ORG_B } from './setup';

const url = process.env.W6_DB_URL as string;
const DAY = '2026-11-21';
const M1 = 'ACoAAAsnqTest00001';
const M2 = 'ACoAAAsnqTest00002';

const consume = (c: Client | typeof db, org: string, member: string, n: number, cap: number) =>
  c.query('SELECT * FROM public.salesnav_consume_daily_quota($1, $2, $3::date, $4, $5)', [org, member, DAY, n, cap]);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'error'; }
}

const own = (member: string, org: string) =>
  db.query('INSERT INTO public.salesnav_member_owner (member_id, organization_id) VALUES ($1, $2)', [member, org]);
const transfer = async (member: string, org: string) => {
  await db.query('DELETE FROM public.salesnav_member_owner WHERE member_id = $1', [member]);
  await own(member, org);
};
const rowCount = async (member: string): Promise<number> =>
  (await db.query('SELECT count(*)::int n FROM public.salesnav_daily_quota WHERE member_id = $1', [member])).rows[0].n;

beforeAll(async () => { await seedTenants(); });
beforeEach(async () => {
  // M1 and M2 are both owned by ORG_A unless a test moves one.
  await own(M1, ORG_A);
  await own(M2, ORG_A);
});
afterEach(async () => {
  await db.query(`DELETE FROM public.salesnav_daily_quota WHERE member_id LIKE 'ACoAAAsnqTest%'`);
  await db.query(`DELETE FROM public.salesnav_member_owner WHERE member_id LIKE 'ACoAAAsnqTest%'`);
});

describe('consume: atomic, all-or-nothing, bounded by the cap', () => {
  it('accumulates within the cap and REFUSES past it, consuming nothing and reporting the remaining', async () => {
    expect((await consume(db, ORG_A, M1, 140, 150)).rows[0]).toEqual({ granted: 140, consumed: 140, remaining: 10 });
    expect((await consume(db, ORG_A, M1, 25, 150)).rows[0]).toEqual({ granted: 0, consumed: 140, remaining: 10 });
    // the caller's single retry with exactly the remaining succeeds and lands on the cap
    expect((await consume(db, ORG_A, M1, 10, 150)).rows[0]).toEqual({ granted: 10, consumed: 150, remaining: 0 });
    expect((await consume(db, ORG_A, M1, 1, 150)).rows[0]).toEqual({ granted: 0, consumed: 150, remaining: 0 });
  });

  it('the key is (member, day): another member has its own count', async () => {
    await consume(db, ORG_A, M1, 150, 150);
    expect((await consume(db, ORG_A, M2, 5, 150)).rows[0]).toMatchObject({ granted: 5 });
  });

  it('a first call above the cap inserts nothing', async () => {
    expect((await consume(db, ORG_A, M1, 151, 150)).rows[0]).toEqual({ granted: 0, consumed: 0, remaining: 150 });
    const { rows } = await db.query(`SELECT count(*)::int n FROM public.salesnav_daily_quota WHERE member_id = $1`, [M1]);
    expect(rows[0].n).toBe(0);
  });
});

describe('ownership (b3 ruling A): only the owning company consumes; the count follows the member', () => {
  it('a NON-OWNER company gets 0 and writes NOTHING (no row created)', async () => {
    expect((await consume(db, ORG_B, M1, 5, 150)).rows[0]).toEqual({ granted: 0, consumed: 0, remaining: 0 });
    expect(await rowCount(M1)).toBe(0);
  });

  it('a non-owner cannot add to an existing count either - and LEARNS NOTHING about it (7c slice 1)', async () => {
    await consume(db, ORG_A, M1, 10, 150);
    // the member really has consumed 10 today; the non-owner is told 0, never the true figure
    expect((await consume(db, ORG_B, M1, 5, 150)).rows[0]).toEqual({ granted: 0, consumed: 0, remaining: 0 });
    expect((await db.query('SELECT consumed FROM public.salesnav_daily_quota WHERE member_id = $1', [M1])).rows[0].consumed).toBe(10);
  });

  it('control: the OWNER is told the true consumed figure', async () => {
    await consume(db, ORG_A, M1, 10, 150);
    expect((await consume(db, ORG_A, M1, 10, 150)).rows[0]).toMatchObject({ granted: 10, consumed: 20 });
  });

  it('a member with NO owner row cannot consume at all', async () => {
    await db.query('DELETE FROM public.salesnav_member_owner WHERE member_id = $1', [M1]);
    expect((await consume(db, ORG_A, M1, 1, 150)).rows[0]).toMatchObject({ granted: 0 });
    expect(await rowCount(M1)).toBe(0);
  });

  it('a SAME-DAY move carries the count: the new owner sees only what remains of that day', async () => {
    await consume(db, ORG_A, M1, 100, 150);
    await transfer(M1, ORG_B);
    expect((await consume(db, ORG_A, M1, 1, 150)).rows[0]).toMatchObject({ granted: 0 });    // the old owner is out
    expect((await consume(db, ORG_B, M1, 60, 150)).rows[0]).toEqual({ granted: 0, consumed: 100, remaining: 50 });
    expect((await consume(db, ORG_B, M1, 50, 150)).rows[0]).toEqual({ granted: 50, consumed: 150, remaining: 0 });
  });

  it('control: the same consume by the owner, without a move, is granted', async () => {
    await consume(db, ORG_A, M1, 100, 150);
    expect((await consume(db, ORG_A, M1, 50, 150)).rows[0]).toEqual({ granted: 50, consumed: 150, remaining: 0 });
  });

  it('a transfer WAITS for an in-flight consume (the owner row is locked), and the old owner is out after it', async () => {
    const c1 = new Client({ connectionString: url });
    const c2 = new Client({ connectionString: url });
    await Promise.all([c1.connect(), c2.connect()]);
    try {
      await c1.query('BEGIN');
      expect((await consume(c1, ORG_A, M1, 1, 150)).rows[0]).toMatchObject({ granted: 1 });   // holds FOR SHARE
      let deleted = false;
      const pending = c2.query('DELETE FROM public.salesnav_member_owner WHERE member_id = $1', [M1])
        .then((r) => { deleted = true; return r; });
      await new Promise((r) => setTimeout(r, 300));
      expect(deleted).toBe(false);          // blocked behind the consume's lock
      await c1.query('COMMIT');
      expect((await pending).rowCount).toBe(1);
    } finally {
      await Promise.all([c1.end(), c2.end()]);
    }
    expect((await consume(db, ORG_A, M1, 1, 150)).rows[0]).toMatchObject({ granted: 0 });
  });
});

describe('a genuine two-session race (row lock): never past the cap', () => {
  async function race(seed: number, cap: number): Promise<number[]> {
    if (seed > 0) await consume(db, ORG_A, M1, seed, cap);
    const c1 = new Client({ connectionString: url });
    const c2 = new Client({ connectionString: url });
    await Promise.all([c1.connect(), c2.connect()]);
    try {
      await c1.query('BEGIN');
      const a = await consume(c1, ORG_A, M1, 1, cap);           // holds the row lock
      const pending = consume(c2, ORG_A, M1, 1, cap);           // blocks until c1 commits, then re-evaluates
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      const b = await pending;
      return [a.rows[0].granted, b.rows[0].granted];
    } finally {
      await Promise.all([c1.end(), c2.end()]);
    }
  }

  it('at cap-1, two concurrent consumes of 1 -> EXACTLY ONE succeeds', async () => {
    const granted = await race(149, 150);
    expect(granted.sort()).toEqual([0, 1]);
    const { rows } = await db.query(`SELECT consumed FROM public.salesnav_daily_quota WHERE member_id = $1`, [M1]);
    expect(rows[0].consumed).toBe(150);
  });

  it('control: at cap-2, both succeed', async () => {
    expect(await race(148, 150)).toEqual([1, 1]);
  });
});

describe('the database refuses what the contract forbids (22023)', () => {
  it.each([
    ['cap above the hard max 200', ORG_A, M1, 1, 201],
    ['cap 0', ORG_A, M1, 1, 0],
    ['count 0', ORG_A, M1, 0, 150],
    ['a non-canonical member id', ORG_A, 'urn:li:member:1', 1, 150],
    ['a free-text member id', ORG_A, 'Ada Lovelace', 1, 150],
  ])('%s', async (_l, org, member, n, cap) => {
    expect(await codeOf(consume(db, org as string, member as string, n as number, cap as number))).toBe('22023');
  });

  it('control: cap 200 (the hard max) is accepted', async () => {
    expect((await consume(db, ORG_A, M1, 1, 200)).rows[0]).toMatchObject({ granted: 1 });
  });
});

describe('no client role can consume or read', () => {
  it.each(['anon', 'authenticated'])('%s cannot EXECUTE the function or SELECT the table', async (role) => {
    const roleExists = (await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1;
    expect(roleExists).toBe(true);   // the refusal below must be about privilege, not a missing role
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL ROLE ${role}`);
      await db.query('SAVEPOINT s');
      expect(await codeOf(consume(db, ORG_A, M1, 1, 150))).toBe('42501');
      await db.query('ROLLBACK TO SAVEPOINT s');
      expect(await codeOf(db.query('SELECT * FROM public.salesnav_daily_quota'))).toBe('42501');
    } finally {
      await db.query('ROLLBACK');
    }
  });
});

describe('074 preflight refuses a PRE-re-key table (7c slice 1, finding 1)', () => {
  // The file's own preflight block, executed as written - not a re-statement of its rule.
  const fileSql = require('fs').readFileSync(
    require('path').join(process.cwd(), 'supabase/migrations/20270217000074_salesnav_daily_quota.sql'), 'utf8') as string;
  const preflight = (/DO \$preflight\$[\s\S]*?\$preflight\$;/.exec(fileSql) as RegExpExecArray)[0];

  async function inTx<T>(body: () => Promise<T>): Promise<T> {
    await db.query('BEGIN');
    try { return await body(); } finally { await db.query('ROLLBACK'); }
  }
  async function codeOfSql(sql: string): Promise<string> {
    await db.query('SAVEPOINT p');
    try { await db.query(sql); await db.query('RELEASE SAVEPOINT p'); return 'ok'; }
    catch (e) { await db.query('ROLLBACK TO SAVEPOINT p'); return (e as { message: string }).message; }
  }

  it('a salesnav_daily_quota carrying organization_id (the first form) makes the preflight RAISE', () => inTx(async () => {
    await db.query('DROP TABLE public.salesnav_daily_quota CASCADE');
    await db.query(`CREATE TABLE public.salesnav_daily_quota (organization_id uuid NOT NULL, member_id text NOT NULL,
      usage_day date NOT NULL, consumed integer NOT NULL DEFAULT 0, PRIMARY KEY (organization_id, member_id, usage_day))`);
    expect(await codeOfSql(preflight)).toContain('PRE-re-key shape');
  }));

  it('control: the re-keyed shape (the one this replay built) passes the same preflight', () => inTx(async () => {
    expect(await codeOfSql(preflight)).toBe('ok');
  }));
});
