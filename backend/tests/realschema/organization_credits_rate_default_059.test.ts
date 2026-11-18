/**
 * Real-schema cover for 20270217000059 (c6; OWNER 2026-11-18: new wallets start at 0.007). After the full replay a wallet
 * created the way the SQL credit functions create one - INSERT organization_credits(organization_id) - gets 0.007; the
 * rollback restores the 0.01 default without touching rows. Disposable replay DB; mutations inside inRollback.
 */
import * as fs from 'fs';
import * as path from 'path';
import { db, inRollback } from './setup';

const URL = process.env.W6_DB_URL ?? '';
if (!/@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(URL)) throw new Error('organization_credits_rate_default_059 refuses a non-loopback W6_DB_URL');
const ROLLBACK = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/rollbacks/organization_credits_rate_default_0007_rollback.sql'), 'utf8');
const ORG = '00000000-0000-4000-8000-0000000059a1';

describe('20270217000059 organization_credits.credit_rate_usd default 0.007', () => {
  it('a bare wallet insert (the SQL-function path) gets 0.007', async () => {
    await inRollback(async () => {
      await db.query('INSERT INTO public.organization_credits (organization_id) VALUES ($1)', [ORG]);
      const { rows } = await db.query('SELECT credit_rate_usd::text AS r FROM public.organization_credits WHERE organization_id = $1', [ORG]);
      expect(Number(rows[0].r)).toBe(0.007);
    });
  });
  it('rollback restores the 0.01 default and changes no row', async () => {
    await inRollback(async () => {
      await db.query('INSERT INTO public.organization_credits (organization_id) VALUES ($1)', [ORG]);
      await db.query(ROLLBACK);
      const { rows } = await db.query('SELECT credit_rate_usd::text AS r FROM public.organization_credits WHERE organization_id = $1', [ORG]);
      expect(Number(rows[0].r)).toBe(0.007);
      const d = (await db.query(`SELECT column_default AS d FROM information_schema.columns WHERE table_schema='public' AND table_name='organization_credits' AND column_name='credit_rate_usd'`)).rows[0].d;
      expect(String(d)).toMatch(/^0\.01/);
    });
  });
});
