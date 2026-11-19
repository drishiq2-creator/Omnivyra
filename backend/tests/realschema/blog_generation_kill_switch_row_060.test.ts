/**
 * Real-schema cover for 20270217000060 (c6; b3 adopting 7c): after the full replay exactly one global
 * 'blog_generation' row exists (the blog routes FAIL CLOSED without it), and the rollback removes only a row this
 * migration inserted and nobody edited. Disposable replay DB; mutations inside inRollback.
 */
import * as fs from 'fs';
import * as path from 'path';
import { db, inRollback } from './setup';

const URL = process.env.W6_DB_URL ?? '';
if (!/@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(URL)) throw new Error('blog_generation_kill_switch_row_060 refuses a non-loopback W6_DB_URL');
const ROLLBACK = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/rollbacks/blog_generation_kill_switch_row_rollback.sql'), 'utf8');
const count = async () => Number((await db.query(`SELECT count(*)::int AS n FROM public.intelligence_global_config WHERE job_type = 'blog_generation'`)).rows[0].n);

describe('20270217000060 blog_generation kill-switch row', () => {
  it('exactly one global blog_generation row exists after the replay', async () => {
    expect(await count()).toBe(1);
  });
  it('the rollback leaves a row it did not insert (or that an admin edited)', async () => {
    await inRollback(async () => {
      await db.query(`UPDATE public.intelligence_global_config SET updated_by = 'admin:someone' WHERE job_type = 'blog_generation'`);
      await db.query(ROLLBACK);
      expect(await count()).toBe(1);
    });
  });
  it('the rollback removes a row carrying the 060 marker', async () => {
    await inRollback(async () => {
      await db.query(`UPDATE public.intelligence_global_config SET updated_by = 'migration:20270217000060' WHERE job_type = 'blog_generation'`);
      await db.query(ROLLBACK);
      expect(await count()).toBe(0);
    });
  });
});
