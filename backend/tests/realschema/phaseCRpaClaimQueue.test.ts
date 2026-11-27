/**
 * Phase C — rpa_retry_queue durable claim (20270314000001), against real
 * PostgreSQL. The properties under test are PostgreSQL behaviour:
 *
 *   - two concurrent claimers (separate sessions, the first holding its row
 *     locks) receive DISJOINT rows: FOR UPDATE SKIP LOCKED, not luck;
 *   - finalisation writes only when the claim token matches;
 *   - an expired claim is never re-claimed: it is parked as outcome-unknown and
 *     a late finaliser holding the old token is refused;
 *   - accept is idempotent per action (ON CONFLICT DO NOTHING);
 *   - EXECUTE is service_role only (anon / authenticated refused with 42501).
 *
 * Deterministic: the concurrent case holds session A's transaction open while
 * session B claims; no sleep decides an outcome.
 */
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { db, inRollback, attempt } from './setup';

const url = process.env.W6_DB_URL as string;
const ORG = '00000000-0000-4000-8000-0000000c1a1a';

async function seedRow(c: Client | typeof db, over: { attempts?: number; next?: string } = {}): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO public.rpa_retry_queue (action_id, organization_id, platform, action_type, target_url, attempts, next_retry_at)
     VALUES ($1, $2, 'synthetic_page_check', 'like', 'data:text/plain,x', $3, coalesce($4::timestamptz, now() - interval '1 minute'))
     RETURNING id`,
    [randomUUID(), ORG, over.attempts ?? 0, over.next ?? null],
  );
  return rows[0].id as string;
}

const claim = (c: Client | typeof db, worker: string, limit: number, lease = 600) =>
  c.query(`SELECT id, claim_token, claimed_by FROM public.claim_rpa_retry_queue($1, $2, $3, $4)`, [worker, lease, limit, ORG]);

describe('schema shape', () => {
  it('claim columns exist and are nullable; the shape CHECK is validated', async () => {
    const { rows } = await db.query(
      `SELECT attname, attnotnull FROM pg_attribute
        WHERE attrelid = 'public.rpa_retry_queue'::regclass AND NOT attisdropped
          AND attname IN ('claim_token','claimed_by','claimed_at','claim_expires_at','completed_at') ORDER BY attname`);
    expect(rows.map((r) => [r.attname, r.attnotnull])).toEqual([
      ['claim_expires_at', false], ['claim_token', false], ['claimed_at', false], ['claimed_by', false], ['completed_at', false],
    ]);
    await inRollback(async () => {
      // a token without a lease violates the CHECK; CONTROL: a full claim shape is admitted
      expect(await attempt(
        `INSERT INTO public.rpa_retry_queue (action_id, organization_id, platform, action_type, target_url, claim_token)
         VALUES (gen_random_uuid(), $1, 'p', 'like', 'u', gen_random_uuid())`, [ORG])).toBe('23514');
      expect(await attempt(
        `INSERT INTO public.rpa_retry_queue (action_id, organization_id, platform, action_type, target_url, claim_token, claimed_by, claimed_at, claim_expires_at)
         VALUES (gen_random_uuid(), $1, 'p', 'like', 'u', gen_random_uuid(), 'w', now(), now() + interval '1 minute')`, [ORG])).toBe('ok');
    });
  });
});

describe('two concurrent claimers get disjoint rows', () => {
  it('session A holds its claim open; session B skips A\'s rows and takes only the rest', async () => {
    const a = new Client({ connectionString: url });
    const b = new Client({ connectionString: url });
    await Promise.all([a.connect(), b.connect()]);
    const ids: string[] = [];
    try {
      for (let i = 0; i < 3; i += 1) ids.push(await seedRow(db));
      await a.query('BEGIN');
      const ra = await claim(a, 'worker-A', 2);
      // B runs while A's transaction (and its row locks) is still open.
      const rb = await claim(b, 'worker-B', 10);
      await a.query('COMMIT');
      const aIds = ra.rows.map((r) => r.id).sort();
      const bIds = rb.rows.map((r) => r.id).sort();
      // CONTROL: both claimers really got work, so the overlap was exercised
      expect(aIds).toHaveLength(2);
      expect(bIds).toHaveLength(1);
      expect(aIds.filter((x) => bIds.includes(x))).toEqual([]);
      expect([...aIds, ...bIds].sort()).toEqual([...ids].sort());
      // every token distinct, every row now claimed
      const tokens = [...ra.rows, ...rb.rows].map((r) => r.claim_token);
      expect(new Set(tokens).size).toBe(3);
      // a third claimer after both committed gets nothing
      expect((await claim(db, 'worker-C', 10)).rows).toHaveLength(0);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await Promise.all([a.end(), b.end()]);
      await db.query(`DELETE FROM public.rpa_retry_queue WHERE organization_id = $1`, [ORG]);
    }
  });
});

describe('finalisation needs the token; an expired claim is parked unknown, never re-run', () => {
  it('a token mismatch writes nothing; CONTROL: the real token finalises (success tombstone)', async () => {
    await inRollback(async () => {
      const id = await seedRow(db, { attempts: 1 });
      const { rows: [c] } = await claim(db, 'w', 1);
      expect(c.id).toBe(id);
      const before = (await db.query(`SELECT * FROM public.rpa_retry_queue WHERE id = $1`, [id])).rows[0];
      const wrong = await db.query(`SELECT public.finalize_rpa_retry_queue_claim($1, $2, 'succeeded') ok`, [id, randomUUID()]);
      expect(wrong.rows[0].ok).toBe(false);
      const same = (await db.query(`SELECT * FROM public.rpa_retry_queue WHERE id = $1`, [id])).rows[0];
      expect(same).toEqual(before);
      const right = await db.query(`SELECT public.finalize_rpa_retry_queue_claim($1, $2, 'succeeded') ok`, [id, c.claim_token]);
      expect(right.rows[0].ok).toBe(true);
      const after = (await db.query(`SELECT attempts, max_attempts, completed_at, claim_token, last_error FROM public.rpa_retry_queue WHERE id = $1`, [id])).rows[0];
      expect(after.attempts).toBe(after.max_attempts);
      expect(after.completed_at).not.toBeNull();
      expect(after.claim_token).toBeNull();
      // the same token cannot finalise twice
      expect((await db.query(`SELECT public.finalize_rpa_retry_queue_claim($1, $2, 'failed', 'x') ok`, [id, c.claim_token])).rows[0].ok).toBe(false);
    });
  });

  it('an expired claim is not re-claimed; park marks it RPA_OUTCOME_UNKNOWN; the late finaliser is refused', async () => {
    await inRollback(async () => {
      const id = await seedRow(db, { attempts: 1 });
      const { rows: [c] } = await claim(db, 'worker-dead', 1);
      await db.query(`UPDATE public.rpa_retry_queue SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
      // never re-claimed, even though it is due and attempts < max
      expect((await claim(db, 'worker-new', 10)).rows).toHaveLength(0);
      const parked = await db.query(`SELECT public.park_expired_rpa_retry_claims() n`);
      expect(parked.rows[0].n).toBe(1);
      const row = (await db.query(`SELECT attempts, max_attempts, last_error, claim_token, claimed_by, claimed_at FROM public.rpa_retry_queue WHERE id = $1`, [id])).rows[0];
      expect(row.attempts).toBe(row.max_attempts);
      expect(row.last_error).toMatch(/^RPA_OUTCOME_UNKNOWN:CLAIM_EXPIRED claimed_by=worker-dead/);
      expect(row.claim_token).toBeNull();
      expect(row.claimed_by).toBe('worker-dead'); // evidence kept
      // the late finaliser (the dead worker coming back) is refused
      expect((await db.query(`SELECT public.finalize_rpa_retry_queue_claim($1, $2, 'succeeded') ok`, [id, c.claim_token])).rows[0].ok).toBe(false);
      // and it is still never claimable
      expect((await claim(db, 'worker-new', 10)).rows).toHaveLength(0);
    });
  });

  it('CONTROL: a claim that has NOT expired is left alone by park', async () => {
    await inRollback(async () => {
      await seedRow(db);
      await claim(db, 'w', 1, 600);
      expect((await db.query(`SELECT public.park_expired_rpa_retry_claims() n`)).rows[0].n).toBe(0);
    });
  });

  it('failed: attempts+1 with backoff; terminal: retired; unknown: parked', async () => {
    await inRollback(async () => {
      const f = await seedRow(db, { attempts: 1 });
      const t = await seedRow(db, { attempts: 1 });
      const u = await seedRow(db, { attempts: 1 });
      const tok = Object.fromEntries((await claim(db, 'w', 3)).rows.map((r) => [r.id, r.claim_token]));
      await db.query(`SELECT public.finalize_rpa_retry_queue_claim($1, $2, 'failed', 'RPA_TIMEOUT')`, [f, tok[f]]);
      await db.query(`SELECT public.finalize_rpa_retry_queue_claim($1, $2, 'failed', 'SUPPRESSED', NULL, true)`, [t, tok[t]]);
      await db.query(`SELECT public.finalize_rpa_retry_queue_claim($1, $2, 'unknown', 'lost')`, [u, tok[u]]);
      const get = async (id: string) => (await db.query(
        `SELECT attempts, max_attempts, last_error, next_retry_at > now() + interval '3 minutes' later FROM public.rpa_retry_queue WHERE id = $1`, [id])).rows[0];
      expect(await get(f)).toMatchObject({ attempts: 2, last_error: 'RPA_TIMEOUT', later: true });
      expect(await get(t)).toMatchObject({ attempts: 5, last_error: 'SUPPRESSED', later: false });
      expect(await get(u)).toMatchObject({ attempts: 5, last_error: 'RPA_OUTCOME_UNKNOWN:lost' });
      // CONTROL: none of the three is claimable now (f is backed off, t and u are retired)
      expect((await claim(db, 'w2', 10)).rows).toHaveLength(0);
    });
  });
});

describe('accept is idempotent per action', () => {
  it('a second accept of the same action is a no-op; CONTROL: another action is accepted', async () => {
    await inRollback(async () => {
      const action = randomUUID();
      const args = [ORG, action, 'synthetic_page_check', 'like', 'data:text/plain,x', null];
      const first = await db.query(`SELECT * FROM public.rpa_retry_queue_accept($1,$2,$3,$4,$5,$6,'worker-A',600)`, args);
      expect(first.rows[0]).toMatchObject({ accepted: true });
      expect(first.rows[0].claim_token).not.toBeNull(); // born claimed
      const second = await db.query(`SELECT * FROM public.rpa_retry_queue_accept($1,$2,$3,$4,$5,$6,NULL,NULL)`, args);
      expect(second.rows[0]).toMatchObject({ accepted: false, queue_id: first.rows[0].queue_id, claim_token: null });
      const n = await db.query(`SELECT count(*)::int n, max(claimed_by) w FROM public.rpa_retry_queue WHERE action_id = $1`, [action]);
      expect(n.rows[0]).toEqual({ n: 1, w: 'worker-A' }); // the existing row was not touched
      const other = await db.query(`SELECT * FROM public.rpa_retry_queue_accept($1,$2,$3,$4,$5,$6,NULL,NULL)`, [ORG, randomUUID(), 'synthetic_page_check', 'like', 'u', null]);
      expect(other.rows[0]).toMatchObject({ accepted: true, claim_token: null });
    });
  });
});

describe('privileges: service_role only', () => {
  it.each(['anon', 'authenticated'])('%s cannot execute the claim, accept, finalize, park, renew or release functions', async (role) => {
    await inRollback(async () => {
      await db.query(`SET LOCAL ROLE ${role}`);
      expect(await attempt(`SELECT * FROM public.claim_rpa_retry_queue('x', 60, 1, NULL)`)).toBe('42501');
      expect(await attempt(`SELECT public.park_expired_rpa_retry_claims()`)).toBe('42501');
      expect(await attempt(`SELECT public.finalize_rpa_retry_queue_claim(gen_random_uuid(), gen_random_uuid(), 'failed')`)).toBe('42501');
      expect(await attempt(`SELECT * FROM public.rpa_retry_queue_accept(gen_random_uuid(), gen_random_uuid(), 'p', 'like', 'u', NULL, NULL, NULL)`)).toBe('42501');
      expect(await attempt(`SELECT public.renew_rpa_retry_queue_claim(gen_random_uuid(), gen_random_uuid(), 60)`)).toBe('42501');
      expect(await attempt(`SELECT public.release_rpa_retry_queue_claim(gen_random_uuid(), gen_random_uuid())`)).toBe('42501');
    });
  });

  it('CONTROL: service_role can claim', async () => {
    await inRollback(async () => {
      await seedRow(db);
      await db.query(`SET LOCAL ROLE service_role`);
      expect(await attempt(`SELECT * FROM public.claim_rpa_retry_queue('svc', 60, 1, $1)`, [ORG])).toBe('ok');
      expect(await attempt(`SELECT public.renew_rpa_retry_queue_claim(gen_random_uuid(), gen_random_uuid(), 60)`)).toBe('ok');
      expect(await attempt(`SELECT public.release_rpa_retry_queue_claim(gen_random_uuid(), gen_random_uuid())`)).toBe('ok');
    });
  });

  it('every function is SECURITY INVOKER with a pinned search_path', async () => {
    const { rows } = await db.query(
      `SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN
          ('claim_rpa_retry_queue','rpa_retry_queue_accept','finalize_rpa_retry_queue_claim','park_expired_rpa_retry_claims',
           'renew_rpa_retry_queue_claim','release_rpa_retry_queue_claim')
        ORDER BY p.proname`);
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.prosecdef).toBe(false);
      expect(r.proconfig).toEqual(['search_path=pg_catalog, public']);
    }
  });
});

describe('S-1: renew_rpa_retry_queue_claim — the lease check immediately before running', () => {
  const renew = (id: string, token: string, lease = 900) =>
    db.query(`SELECT public.renew_rpa_retry_queue_claim($1, $2, $3) ok`, [id, token, lease]).then((r) => r.rows[0].ok as boolean);

  it('a valid, unexpired token renews and extends the lease', async () => {
    await inRollback(async () => {
      const id = await seedRow(db);
      const { rows: [c] } = await claim(db, 'w', 1, 60);
      expect(await renew(id, c.claim_token, 900)).toBe(true);
      const row = (await db.query(`SELECT claim_expires_at > now() + interval '800 seconds' far, claim_token FROM public.rpa_retry_queue WHERE id = $1`, [id])).rows[0];
      expect(row.far).toBe(true);
      expect(row.claim_token).toBe(c.claim_token); // still the same claim
    });
  });

  it('a wrong token returns false and writes nothing (CONTROL in the same row: the right token renews)', async () => {
    await inRollback(async () => {
      const id = await seedRow(db);
      const { rows: [c] } = await claim(db, 'w', 1, 60);
      const before = (await db.query(`SELECT * FROM public.rpa_retry_queue WHERE id = $1`, [id])).rows[0];
      expect(await renew(id, randomUUID())).toBe(false);
      expect((await db.query(`SELECT * FROM public.rpa_retry_queue WHERE id = $1`, [id])).rows[0]).toEqual(before);
      expect(await renew(id, c.claim_token)).toBe(true);
    });
  });

  it('an EXPIRED claim is never revived, even with the right token; it stays parkable', async () => {
    await inRollback(async () => {
      const id = await seedRow(db);
      const { rows: [c] } = await claim(db, 'w', 1, 60);
      await db.query(`UPDATE public.rpa_retry_queue SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
      expect(await renew(id, c.claim_token)).toBe(false);
      expect((await db.query(`SELECT public.park_expired_rpa_retry_claims() n`)).rows[0].n).toBe(1);
    });
  });

  it('a PARKED claim returns false (token gone)', async () => {
    await inRollback(async () => {
      const id = await seedRow(db);
      const { rows: [c] } = await claim(db, 'w', 1, 60);
      await db.query(`UPDATE public.rpa_retry_queue SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
      await db.query(`SELECT public.park_expired_rpa_retry_claims()`);
      expect(await renew(id, c.claim_token)).toBe(false);
    });
  });

  it('lease seconds outside 1..86400 is refused (22023)', async () => {
    await inRollback(async () => {
      expect(await attempt(`SELECT public.renew_rpa_retry_queue_claim(gen_random_uuid(), gen_random_uuid(), 0)`)).toBe('22023');
    });
  });
});

describe('S-1: release_rpa_retry_queue_claim — a claim never attempted goes back, unchanged attempts', () => {
  it('a held (expired) token releases: claim cleared, attempts unchanged, due later, evidence kept; CONTROL: a parked row is not released', async () => {
    await inRollback(async () => {
      const id = await seedRow(db, { attempts: 2 });
      const { rows: [c] } = await claim(db, 'worker-r', 1, 60);
      await db.query(`UPDATE public.rpa_retry_queue SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
      const ok = await db.query(`SELECT public.release_rpa_retry_queue_claim($1, $2, 'LEASE_CHECK', 60) ok`, [id, c.claim_token]);
      expect(ok.rows[0].ok).toBe(true);
      const row = (await db.query(
        `SELECT attempts, claim_token, claim_expires_at, claimed_by, last_error, next_retry_at > now() later FROM public.rpa_retry_queue WHERE id = $1`, [id])).rows[0];
      expect(row).toMatchObject({ attempts: 2, claim_token: null, claim_expires_at: null, claimed_by: 'worker-r', later: true });
      expect(row.last_error).toBe('RPA_CLAIM_RELEASED_NOT_ATTEMPTED:LEASE_CHECK');
      // nothing left for park: it is not recorded as outcome-unknown
      expect((await db.query(`SELECT public.park_expired_rpa_retry_claims() n`)).rows[0].n).toBe(0);

      const id2 = await seedRow(db);
      const { rows: [c2] } = await claim(db, 'w', 1, 60);
      await db.query(`UPDATE public.rpa_retry_queue SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [id2]);
      await db.query(`SELECT public.park_expired_rpa_retry_claims()`);
      expect((await db.query(`SELECT public.release_rpa_retry_queue_claim($1, $2) ok`, [id2, c2.claim_token])).rows[0].ok).toBe(false);
      expect((await db.query(`SELECT last_error FROM public.rpa_retry_queue WHERE id = $1`, [id2])).rows[0].last_error)
        .toMatch(/^RPA_OUTCOME_UNKNOWN:CLAIM_EXPIRED/);
    });
  });

  it('a wrong token releases nothing', async () => {
    await inRollback(async () => {
      const id = await seedRow(db);
      await claim(db, 'w', 1, 60);
      expect((await db.query(`SELECT public.release_rpa_retry_queue_claim($1, $2) ok`, [id, randomUUID()])).rows[0].ok).toBe(false);
      expect((await db.query(`SELECT claim_token IS NOT NULL held FROM public.rpa_retry_queue WHERE id = $1`, [id])).rows[0].held).toBe(true);
    });
  });
});

describe('N-1: accept never returns another organization’s queue_id', () => {
  const OTHER = '00000000-0000-4000-8000-0000000c1b1b';
  it('the scenario exists: the unique index is on (action_id) alone in this schema', async () => {
    const { rows } = await db.query(
      `SELECT array_agg(a.attname::text ORDER BY a.attname) cols FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'public.rpa_retry_queue'::regclass AND i.indisunique AND NOT i.indisprimary
        GROUP BY i.indexrelid`);
    expect(rows.map((r) => r.cols)).toContainEqual(['action_id']);
  });

  it('same action under another org -> 42501 RPA_ACCEPT_ORG_MISMATCH; CONTROL: the owning org gets accepted=false with its own id', async () => {
    await inRollback(async () => {
      const action = randomUUID();
      const theirs = await db.query(`SELECT * FROM public.rpa_retry_queue_accept($1,$2,'synthetic_page_check','like','u',NULL,NULL,NULL)`, [OTHER, action]);
      expect(theirs.rows[0]).toMatchObject({ accepted: true });
      expect(await attempt(`SELECT * FROM public.rpa_retry_queue_accept($1,$2,'synthetic_page_check','like','u',NULL,NULL,NULL)`, [ORG, action])).toBe('42501');
      await db.query('SAVEPOINT n1');
      await expect(db.query(`SELECT * FROM public.rpa_retry_queue_accept($1,$2,'synthetic_page_check','like','u',NULL,NULL,NULL)`, [ORG, action]))
        .rejects.toThrow(/RPA_ACCEPT_ORG_MISMATCH/);
      await db.query('ROLLBACK TO SAVEPOINT n1');
      const own = await db.query(`SELECT * FROM public.rpa_retry_queue_accept($1,$2,'synthetic_page_check','like','u',NULL,NULL,NULL)`, [OTHER, action]);
      expect(own.rows[0]).toMatchObject({ accepted: false, queue_id: theirs.rows[0].queue_id });
    });
  });
});

describe('N-2: the migration preflight fails fast on a missing column', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const sql = fs.readFileSync(path.join(__dirname, '../../../supabase/migrations/20270314000001_rpa_retry_queue_claim.sql'), 'utf8');
  const preflight = sql.slice(sql.indexOf('DO $preflight$'), sql.indexOf('$preflight$;') + '$preflight$;'.length);

  it.each(['max_attempts', 'updated_at', 'last_attempt_at', 'last_error'])('without rpa_retry_queue.%s the preflight raises', async (col) => {
    await inRollback(async () => {
      expect(preflight).toContain(`'${col}'`);
      await db.query(`ALTER TABLE public.rpa_retry_queue RENAME COLUMN ${col} TO ${col}_gone`);
      await db.query('SAVEPOINT p');
      await expect(db.query(preflight)).rejects.toThrow(new RegExp(`column rpa_retry_queue\\.${col} does not exist`));
      await db.query('ROLLBACK TO SAVEPOINT p');
    });
  });

  it('CONTROL: the intact table passes the preflight', async () => {
    await inRollback(async () => {
      expect(await attempt(preflight)).toBe('ok');
    });
  });
});
