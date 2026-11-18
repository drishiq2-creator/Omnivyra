/**
 * Real-schema cover for 20270217000056 (c6; OWNER rulings 2026-11-18). After the full replay:
 *   - credit_cost_config conversation_triage = 1 credit, low, REPLY - exactly once; NO active action_pricing_config row;
 *   - all 7 engagement AI controls default to FALSE (owner: inbox AI is opt-in): a row written for ONE setting switches no
 *     other on;
 *   - re-applying the forward migration switches an opted-in row OFF (existing rows are not assumed to have chosen);
 *   - the rollback restores the default true and deletes exactly 056's row, and does NOT switch anyone back on.
 * Disposable replay DB only; every mutation runs inside inRollback.
 */
import * as fs from 'fs';
import * as path from 'path';
import { db, inRollback } from './setup';

const URL = process.env.W6_DB_URL ?? '';
if (!/@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(URL)) throw new Error('triage_catalog_row_and_opt_in_056 refuses a non-loopback W6_DB_URL');

const MIG = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20270217000056_triage_catalog_row_and_opt_in.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/rollbacks/triage_catalog_row_and_opt_in_rollback.sql'), 'utf8');
const ORG = '00000000-0000-4000-8000-0000000056a1';
const triageDefault = async () => (await db.query(
  `SELECT column_default AS d FROM information_schema.columns
    WHERE table_schema='public' AND table_name='engagement_system_controls' AND column_name='triage_engine_enabled'`)).rows[0]?.d as string;

describe('20270217000056 triage catalog row + opt-in', () => {
  it('the catalog row: conversation_triage = 1, low, REPLY, exactly once; no active apc row', async () => {
    const { rows } = await db.query(`SELECT credits, category, activity_class FROM public.credit_cost_config WHERE action_type = 'conversation_triage'`);
    expect(rows).toEqual([{ credits: 1, category: 'low', activity_class: 'REPLY' }]);
    expect((await db.query(`SELECT 1 FROM public.action_pricing_config WHERE action_key = 'conversation_triage' AND is_active`)).rows).toEqual([]);
  });

  it('OPT-IN (owner via b3): all 7 engagement AI controls default to false; a row for ONE setting switches no other on', async () => {
    const { rows: defs } = await db.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name='engagement_system_controls' AND column_name LIKE '%\\_enabled' ORDER BY 1`);
    expect(defs).toEqual(['ai_suggestions_enabled', 'auto_reply_enabled', 'bulk_reply_enabled', 'digest_generation_enabled',
      'opportunity_detection_enabled', 'response_strategy_learning_enabled', 'triage_engine_enabled']
      .map((column_name) => ({ column_name, column_default: 'false' })));
    await inRollback(async () => {
      await db.query(`INSERT INTO public.engagement_system_controls (organization_id, ai_suggestions_enabled) VALUES ($1, true)`, [ORG]);
      const { rows } = await db.query(
        `SELECT auto_reply_enabled, bulk_reply_enabled, ai_suggestions_enabled, triage_engine_enabled, opportunity_detection_enabled,
                response_strategy_learning_enabled, digest_generation_enabled
           FROM public.engagement_system_controls WHERE organization_id = $1`, [ORG]);
      expect(rows).toEqual([{ auto_reply_enabled: false, bulk_reply_enabled: false, ai_suggestions_enabled: true, triage_engine_enabled: false,
        opportunity_detection_enabled: false, response_strategy_learning_enabled: false, digest_generation_enabled: false }]);
    });
  });

  it('re-applying the forward migration switches an opted-in row OFF and is otherwise a no-op', async () => {
    await inRollback(async () => {
      await db.query(`INSERT INTO public.engagement_system_controls (organization_id, triage_engine_enabled) VALUES ($1, true)`, [ORG]);
      await db.query(MIG);
      const { rows } = await db.query(`SELECT triage_engine_enabled FROM public.engagement_system_controls WHERE organization_id = $1`, [ORG]);
      expect(rows).toEqual([{ triage_engine_enabled: false }]);
      expect((await db.query(`SELECT count(*)::int AS n FROM public.credit_cost_config WHERE action_type = 'conversation_triage'`)).rows[0].n).toBe(1);
    });
  });

  it('7c/b3: the single-charge index exists, is unique + valid; if ABSENT, re-applying 056 rebuilds it', async () => {
    const idx = async () => (await db.query(
      `SELECT i.indisunique, i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_thread_classification_thread_org'`)).rows;
    expect(await idx()).toEqual([expect.objectContaining({ indisunique: true, indisvalid: true, indisready: true,
      def: expect.stringContaining('(thread_id, organization_id)') })]);
    await inRollback(async () => {
      await db.query('DROP INDEX public.idx_thread_classification_thread_org');
      expect(await idx()).toEqual([]);
      await db.query(MIG);
      expect(await idx()).toEqual([expect.objectContaining({ indisunique: true, indisvalid: true })]);
    });
  });

  it('7c/b3: with the index absent and DUPLICATE (thread, org) rows present, 056 refuses (no silent delete)', async () => {
    await inRollback(async () => {
      await db.query('DROP INDEX public.idx_thread_classification_thread_org');
      const T = '00000000-0000-4000-8000-0000000056b1';
      // thread_id references engagement_threads (FK) - the thread must exist.
      await db.query(
        `INSERT INTO public.engagement_threads (id, platform, platform_thread_id, organization_id) VALUES ($1, 'test', 'c6-056-dup', $2)`, [T, ORG]);
      for (let i = 0; i < 2; i++) {
        await db.query(
          `INSERT INTO public.engagement_thread_classification (organization_id, thread_id, classification_category, classification_confidence, sentiment, triage_priority, classified_at)
           VALUES ($1, $2, 'general_comment', 0.5, 'neutral', 3, now())`, [ORG, T]);
      }
      await db.query('SAVEPOINT s056');
      let msg = 'ok';
      try { await db.query(MIG); } catch (e: any) { msg = String(e.message); }
      await db.query('ROLLBACK TO SAVEPOINT s056');
      expect(msg).toMatch(/duplicate \(thread_id, organization_id\) group/);
    });
  });

  it('rollback restores default true, deletes exactly the 056 row, and switches nobody back on', async () => {
    await inRollback(async () => {
      await db.query(`INSERT INTO public.engagement_system_controls (organization_id, triage_engine_enabled) VALUES ($1, false)`, [ORG]);
      const before = Number((await db.query('SELECT count(*)::int AS n FROM public.credit_cost_config')).rows[0].n);
      await db.query(ROLLBACK);
      expect(await triageDefault()).toBe('true');
      expect(Number((await db.query('SELECT count(*)::int AS n FROM public.credit_cost_config')).rows[0].n)).toBe(before - 1);
      const { rows } = await db.query(`SELECT triage_engine_enabled FROM public.engagement_system_controls WHERE organization_id = $1`, [ORG]);
      expect(rows).toEqual([{ triage_engine_enabled: false }]);
    });
  });
});
