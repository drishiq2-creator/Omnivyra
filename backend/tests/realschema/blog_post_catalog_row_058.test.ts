/**
 * Real-schema cover for 20270217000058 (c6; OWNER 2026-11-18: a blog is a fixed 40 credits). After the full replay:
 * credit_cost_config blog_post = 40 exactly once; NO active action_pricing_config row; the rollback deletes exactly 058's
 * row. Disposable replay DB only; every mutation runs inside inRollback.
 */
import * as fs from 'fs';
import * as path from 'path';
import { db, inRollback } from './setup';

const URL = process.env.W6_DB_URL ?? '';
if (!/@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(URL)) throw new Error('blog_post_catalog_row_058 refuses a non-loopback W6_DB_URL');
const ROLLBACK = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/rollbacks/blog_post_catalog_row_rollback.sql'), 'utf8');

describe('20270217000058 blog_post catalog row', () => {
  it('blog_post = 40, heavy, LONG_GENERATION, exactly once; no active apc row', async () => {
    const { rows } = await db.query(`SELECT credits, category, activity_class FROM public.credit_cost_config WHERE action_type = 'blog_post'`);
    expect(rows).toEqual([{ credits: 40, category: 'heavy', activity_class: 'LONG_GENERATION' }]);
    expect((await db.query(`SELECT 1 FROM public.action_pricing_config WHERE action_key = 'blog_post' AND is_active`)).rows).toEqual([]);
  });
  it('rollback deletes exactly the 058 row', async () => {
    await inRollback(async () => {
      const before = Number((await db.query('SELECT count(*)::int AS n FROM public.credit_cost_config')).rows[0].n);
      await db.query(ROLLBACK);
      expect(Number((await db.query('SELECT count(*)::int AS n FROM public.credit_cost_config')).rows[0].n)).toBe(before - 1);
      expect((await db.query(`SELECT 1 FROM public.credit_cost_config WHERE action_type = 'blog_post'`)).rows).toEqual([]);
    });
  });
});
