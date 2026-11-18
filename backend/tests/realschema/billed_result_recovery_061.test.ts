/**
 * Real-schema cover for 20270217000061 (c6; b3 rulings 2026-11-18 + 7c criteria). After the full replay:
 *   - billing_owed_refunds allows ONE row per original confirm (the UNIQUE index is valid and on that column);
 *   - record_billed_result_replay_failure counts atomically and keeps the FIRST failure time;
 *   - no client role can read either table or execute the function; service_role can;
 *   - the rollback refuses while a refund is still OWED.
 * Disposable replay DB; every mutation inside inRollback.
 */
import * as fs from 'fs';
import * as path from 'path';
import { db, inRollback } from './setup';

const URL = process.env.W6_DB_URL ?? '';
if (!/@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(URL)) throw new Error('billed_result_recovery_061 refuses a non-loopback W6_DB_URL');
const ROLLBACK = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/rollbacks/billed_result_recovery_rollback.sql'), 'utf8');
const ORG = '00000000-0000-4000-8000-0000000061a1';
const USER = '00000000-0000-4000-8000-0000000061b1';
const CONFIRM = '00000000-0000-4000-8000-0000000061c1';

async function errOf(sql: string, params: unknown[] = []): Promise<string | null> {
  await db.query('SAVEPOINT s061');
  try { await db.query(sql, params); await db.query('RELEASE SAVEPOINT s061'); return null; }
  catch (e) { await db.query('ROLLBACK TO SAVEPOINT s061'); return String((e as { code?: string }).code ?? (e as Error).message); }
}
const insertOwed = (status = 'owed') => db.query(
  `INSERT INTO public.billing_owed_refunds (organization_id, original_confirm_txn_id, free_credits, paid_credits, reason, grant_key_prefix, performed_by, status, granted_at)
   VALUES ($1, $2, 30, 10, 'blog_result_unavailable', 'blog_refund', $3, $4, CASE WHEN $4 = 'granted' THEN now() END)`, [ORG, CONFIRM, USER, status]);

describe('20270217000061 billed result recovery', () => {
  it('ONE owed row per original confirm: a second insert is 23505', async () => {
    await inRollback(async () => {
      await insertOwed();
      expect(await errOf(`INSERT INTO public.billing_owed_refunds (organization_id, original_confirm_txn_id, free_credits, reason, grant_key_prefix, performed_by)
                          VALUES ($1, $2, 5, 'x', 'y', $3)`, [ORG, CONFIRM, USER])).toBe('23505');
    });
  });
  it('the unique index is VALID, UNIQUE and on original_confirm_txn_id', async () => {
    const { rows } = await db.query(`SELECT i.indisvalid, i.indisunique, a.attname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE c.relname = 'billing_owed_refunds_original_confirm_uidx'`);
    expect(rows).toEqual([{ indisvalid: true, indisunique: true, attname: 'original_confirm_txn_id' }]);
  });
  it('a zero refund and a granted row without granted_at are refused (CHECKs)', async () => {
    await inRollback(async () => {
      expect(await errOf(`INSERT INTO public.billing_owed_refunds (organization_id, original_confirm_txn_id, reason, grant_key_prefix, performed_by)
                          VALUES ($1, $2, 'x', 'y', $3)`, [ORG, CONFIRM, USER])).toBe('23514');
      expect(await errOf(`INSERT INTO public.billing_owed_refunds (organization_id, original_confirm_txn_id, free_credits, reason, grant_key_prefix, performed_by, status)
                          VALUES ($1, $2, 5, 'x', 'y', $3, 'granted')`, [ORG, CONFIRM, USER])).toBe('23514');
    });
  });
  it('record_billed_result_replay_failure counts and keeps the FIRST failure time', async () => {
    await inRollback(async () => {
      const a = (await db.query(`SELECT * FROM public.record_billed_result_replay_failure('s', 'org:x', 'k', 'e1')`)).rows[0];
      const b = (await db.query(`SELECT * FROM public.record_billed_result_replay_failure('s', 'org:x', 'k', 'e2')`)).rows[0];
      expect([a.failures, b.failures]).toEqual([1, 2]);
      expect(new Date(b.first_failed_at).getTime()).toBe(new Date(a.first_failed_at).getTime());
    });
  });
  it.each(['anon', 'authenticated'])('%s can read neither table nor execute the counter', async (role) => {
    const { rows } = await db.query(`SELECT
      has_table_privilege($1, 'public.billing_owed_refunds', 'SELECT') AS a,
      has_table_privilege($1, 'public.billed_result_replay_failures', 'SELECT') AS b,
      has_function_privilege($1, 'public.record_billed_result_replay_failure(text, text, text, text)', 'EXECUTE') AS c`, [role]);
    expect(rows[0]).toEqual({ a: false, b: false, c: false });
  });
  it('service_role can read/write both tables and execute the counter', async () => {
    const { rows } = await db.query(`SELECT
      has_table_privilege('service_role', 'public.billing_owed_refunds', 'INSERT') AS a,
      has_table_privilege('service_role', 'public.billed_result_replay_failures', 'UPDATE') AS b,
      has_function_privilege('service_role', 'public.record_billed_result_replay_failure(text, text, text, text)', 'EXECUTE') AS c`);
    expect(rows[0]).toEqual({ a: true, b: true, c: true });
  });
  it('the rollback REFUSES while a refund is owed, and drops everything once none is', async () => {
    await inRollback(async () => {
      await insertOwed('owed');
      expect(await errOf(ROLLBACK)).toBe('P0001');
      await db.query(`UPDATE public.billing_owed_refunds SET status = 'granted', granted_at = now()`);
      await db.query(ROLLBACK);
      const { rows } = await db.query(`SELECT to_regclass('public.billing_owed_refunds') AS a, to_regclass('public.billed_result_replay_failures') AS b`);
      expect(rows[0]).toEqual({ a: null, b: null });
    });
  });
});
