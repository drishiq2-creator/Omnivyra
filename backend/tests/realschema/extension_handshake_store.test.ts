/**
 * 20270314000010 extension_handshake_store - on the real schema (PostgreSQL, every migration replayed):
 *   - a claim code redeems ONCE; a genuine race of N concurrent sessions redeeming one code yields EXACTLY ONE row
 *     (control: N different codes, all redeemed by the same race, all succeed);
 *   - an expired code is refused (control: the same shape unexpired redeems); expiry is the DATABASE clock;
 *   - a nonce key is recorded once: a concurrent race yields exactly one first use (control: distinct keys all
 *     record); an EXPIRED key may be recorded again; argument bounds are enforced in the database;
 *   - only digests are accepted; the issue purge removes long-expired codes and keeps the rest;
 *   - no client role can execute the functions or touch the tables (control: service_role can).
 */
import { Client } from 'pg';
import { createHash, randomBytes } from 'crypto';
import { db, ORG_A } from './setup';

const url = process.env.W6_DB_URL as string;
const USER = '00000000-0000-4000-8000-0000000e0001';
const hex = (s: string) => createHash('sha256').update(s).digest('hex');
const freshHash = () => hex(randomBytes(16).toString('hex'));

const issue = (c: Client | typeof db, h: string, ttl = 60) =>
  c.query('SELECT * FROM public.extension_claim_code_issue($1, $2::uuid, $3::uuid, $4)', [h, USER, ORG_A, ttl]);
const redeem = (c: Client | typeof db, h: string) =>
  c.query('SELECT * FROM public.extension_claim_code_redeem($1)', [h]);
const nonce = (c: Client | typeof db, k: string, ttl = 900) =>
  c.query('SELECT public.extension_request_nonce_record($1, $2) AS recorded', [k, ttl]);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'error'; }
}

async function clients(n: number): Promise<Client[]> {
  const cs = Array.from({ length: n }, () => new Client({ connectionString: url }));
  await Promise.all(cs.map((c) => c.connect()));
  return cs;
}

afterEach(async () => {
  await db.query('DELETE FROM public.extension_claim_codes WHERE user_id = $1', [USER]);
  await db.query('DELETE FROM public.extension_request_nonces');
});

describe('claim codes', () => {
  it('issue returns the database-clock window; redeem returns the binding ONCE', async () => {
    const h = freshHash();
    const { rows } = await issue(db, h);
    const ms = new Date(rows[0].valid_until).getTime() - new Date(rows[0].issued_at).getTime();
    expect(ms).toBe(60_000);
    expect((await redeem(db, h)).rows).toEqual([{ redeemed_user_id: USER, redeemed_organization_id: ORG_A }]);
    expect((await redeem(db, h)).rows).toEqual([]);
    expect((await db.query('SELECT redeemed_at IS NOT NULL AS r FROM public.extension_claim_codes WHERE code_hash = $1', [h])).rows[0].r).toBe(true);
  });

  it('a duplicate digest is refused (23505), never overwritten', async () => {
    const h = freshHash();
    await issue(db, h);
    expect(await codeOf(issue(db, h))).toBe('23505');
  });

  it('RACE: 8 concurrent sessions redeeming ONE code -> exactly one row (control: 8 codes -> 8 rows)', async () => {
    const cs = await clients(8);
    try {
      const one = freshHash();
      await issue(db, one);
      const same = await Promise.all(cs.map((c) => redeem(c, one)));
      expect(same.reduce((n, r) => n + r.rows.length, 0)).toBe(1);

      const many = Array.from({ length: 8 }, freshHash);
      for (const h of many) await issue(db, h);
      const each = await Promise.all(cs.map((c, i) => redeem(c, many[i])));
      expect(each.reduce((n, r) => n + r.rows.length, 0)).toBe(8);
    } finally {
      await Promise.all(cs.map((c) => c.end()));
    }
  });

  it('RACE under explicit transactions: the loser waits for the winner, then sees it redeemed', async () => {
    const [c1, c2] = await clients(2);
    try {
      const h = freshHash();
      await issue(db, h);
      await c1.query('BEGIN');
      expect((await redeem(c1, h)).rows).toHaveLength(1);
      const second = redeem(c2, h); // blocks on c1's row lock
      await new Promise((r) => setTimeout(r, 150));
      await c1.query('COMMIT');
      expect((await second).rows).toEqual([]);
    } finally {
      await Promise.all([c1.end(), c2.end()]);
    }
  });

  it('an expired code is refused by the DATABASE clock (control: unexpired redeems)', async () => {
    const live = freshHash();
    const dead = freshHash();
    await issue(db, live);
    await db.query(
      `INSERT INTO public.extension_claim_codes (code_hash, user_id, organization_id, created_at, expires_at)
       VALUES ($1, $2, $3, now() - interval '61 seconds', now() - interval '1 second')`, [dead, USER, ORG_A]);
    expect((await redeem(db, dead)).rows).toEqual([]);
    expect((await redeem(db, live)).rows).toHaveLength(1);
  });

  it('malformed digests redeem nothing; issue refuses them and out-of-range TTLs (22023 / CHECK)', async () => {
    expect((await redeem(db, 'cc_raw_code_not_a_digest')).rows).toEqual([]);
    expect(await codeOf(issue(db, 'not-hex'))).toBe('22023');
    expect(await codeOf(issue(db, freshHash(), 0))).toBe('22023');
    expect(await codeOf(issue(db, freshHash(), 601))).toBe('22023');
    expect(await codeOf(issue(db, freshHash(), 600))).toBe('ok'); // control: the bound itself
    expect(await codeOf(db.query(
      `INSERT INTO public.extension_claim_codes (code_hash, user_id, organization_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '11 minutes')`, [freshHash(), USER, ORG_A]))).toBe('23514');
  });

  it('issue purges codes expired over an hour ago and keeps recent ones', async () => {
    const old = freshHash();
    const recent = freshHash();
    await db.query(
      `INSERT INTO public.extension_claim_codes (code_hash, user_id, organization_id, created_at, expires_at)
       VALUES ($1, $3, $4, now() - interval '2 hours', now() - interval '2 hours' + interval '60 seconds'),
              ($2, $3, $4, now() - interval '10 minutes', now() - interval '9 minutes')`, [old, recent, USER, ORG_A]);
    await issue(db, freshHash());
    const left = (await db.query('SELECT code_hash FROM public.extension_claim_codes WHERE code_hash = ANY($1)', [[old, recent]])).rows.map((r) => r.code_hash);
    expect(left).toEqual([recent]);
  });
});

describe('request nonces', () => {
  it('first use true, replay false', async () => {
    const k = freshHash();
    expect((await nonce(db, k)).rows[0].recorded).toBe(true);
    expect((await nonce(db, k)).rows[0].recorded).toBe(false);
  });

  it('RACE: 8 concurrent first uses of one key -> exactly one true (control: 8 keys -> 8 true)', async () => {
    const cs = await clients(8);
    try {
      const k = freshHash();
      const same = await Promise.all(cs.map((c) => nonce(c, k)));
      expect(same.filter((r) => r.rows[0].recorded === true)).toHaveLength(1);
      const keys = Array.from({ length: 8 }, freshHash);
      const each = await Promise.all(cs.map((c, i) => nonce(c, keys[i])));
      expect(each.filter((r) => r.rows[0].recorded === true)).toHaveLength(8);
    } finally {
      await Promise.all(cs.map((c) => c.end()));
    }
  });

  it('an EXPIRED key records again (control: an unexpired one does not); expired keys are purged', async () => {
    const expired = freshHash();
    const live = freshHash();
    await db.query(
      `INSERT INTO public.extension_request_nonces (nonce_key, first_seen_at, expires_at)
       VALUES ($1, now() - interval '20 minutes', now() - interval '5 minutes'), ($2, now(), now() + interval '15 minutes')`,
      [expired, live]);
    expect((await nonce(db, live)).rows[0].recorded).toBe(false);
    expect((await nonce(db, expired)).rows[0].recorded).toBe(true);

    const stale = freshHash();
    await db.query(
      `INSERT INTO public.extension_request_nonces (nonce_key, first_seen_at, expires_at)
       VALUES ($1, now() - interval '20 minutes', now() - interval '5 minutes')`, [stale]);
    await nonce(db, freshHash());
    expect((await db.query('SELECT 1 FROM public.extension_request_nonces WHERE nonce_key = $1', [stale])).rowCount).toBe(0);
  });

  it('bounds: digest only, TTL 60..3600', async () => {
    expect(await codeOf(nonce(db, 'raw-nonce'))).toBe('22023');
    expect(await codeOf(nonce(db, freshHash(), 59))).toBe('22023');
    expect(await codeOf(nonce(db, freshHash(), 3601))).toBe('22023');
    expect(await codeOf(nonce(db, freshHash(), 3600))).toBe('ok');
  });
});

describe('access: service_role only', () => {
  const asRole = async (role: string, sql: string, params: unknown[] = []) => {
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL ROLE ${role}`);
      return await codeOf(db.query(sql, params));
    } finally {
      await db.query('ROLLBACK');
    }
  };

  it.each(['anon', 'authenticated'])('%s cannot execute any function or read either table', async (role) => {
    expect(await asRole(role, 'SELECT * FROM public.extension_claim_code_redeem($1)', [freshHash()])).toBe('42501');
    expect(await asRole(role, 'SELECT * FROM public.extension_claim_code_issue($1, $2::uuid, $3::uuid, 60)', [freshHash(), USER, ORG_A])).toBe('42501');
    expect(await asRole(role, 'SELECT public.extension_request_nonce_record($1, 900)', [freshHash()])).toBe('42501');
    expect(await asRole(role, 'SELECT 1 FROM public.extension_claim_codes')).toBe('42501');
    expect(await asRole(role, 'SELECT 1 FROM public.extension_request_nonces')).toBe('42501');
  });

  it('control: service_role executes all three', async () => {
    expect(await asRole('service_role', 'SELECT * FROM public.extension_claim_code_issue($1, $2::uuid, $3::uuid, 60)', [freshHash(), USER, ORG_A])).toBe('ok');
    expect(await asRole('service_role', 'SELECT * FROM public.extension_claim_code_redeem($1)', [freshHash()])).toBe('ok');
    expect(await asRole('service_role', 'SELECT public.extension_request_nonce_record($1, 900)', [freshHash()])).toBe('ok');
  });
});
