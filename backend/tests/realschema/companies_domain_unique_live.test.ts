/**
 * 20270217000063_companies_domain_unique_live: one LIVE company per WEBSITE domain, enforced by the
 * database (CI-309 merge precondition; owner ruling 2026-11-19). Pins, on the replayed schema:
 *   - exactly ONE index of ours exists (the website index), with EXACTLY the migration's definition, and NO
 *     unique index on companies covers admin_email_domain (several companies may share an admin email
 *     domain: e.g. company A, website alpha.test, admin a@shared.test, and company B, website beta.test,
 *     admin b@shared.test);
 *   - two live companies sharing an admin_email_domain are ALLOWED;
 *   - a second live company on a website domain is refused 23505 (what CI-309's race path answers with a
 *     join request), case-insensitively;
 *   - a soft-deleted company does NOT hold its domain;
 *   - the migration's own $post$ block can FAIL (run against perturbed indexes, in a rolled-back
 *     transaction), including on a planted UNIQUE admin_email_domain index: a postcondition that cannot
 *     fail is worse than none.
 *
 * A green run concerns a disposable database built from the committed baseline plus replayed
 * migrations. It is NOT evidence about production.
 */
import fs from 'fs';
import path from 'path';
import { db, inRollback } from './setup';

const MIG = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/20270217000063_companies_domain_unique_live.sql'), 'utf8');

function block(tag: string): string {
  const a = MIG.indexOf(`DO $${tag}$`);
  const b = MIG.indexOf(`$${tag}$;`, a + 5);
  if (a < 0 || b < 0) throw new Error(`$${tag}$ block not found in the migration file`);
  return MIG.slice(a, b + tag.length + 3);
}

const WEBSITE_DEF =
  'CREATE UNIQUE INDEX idx_companies_website_domain_unique ON public.companies USING btree (lower(website_domain)) WHERE ((deleted_at IS NULL) AND (website_domain IS NOT NULL))';

async function sqlstate(sql: string, params: unknown[] = []): Promise<string> {
  await db.query('SAVEPOINT s');
  try {
    await db.query(sql, params);
    await db.query('RELEASE SAVEPOINT s');
    return 'ok';
  } catch (err: any) {
    await db.query('ROLLBACK TO SAVEPOINT s');
    return err.code ?? 'unknown';
  }
}

const insert = (admin: string | null, site: string | null, deleted = false) => sqlstate(
  'INSERT INTO public.companies (name, admin_email_domain, website_domain, deleted_at) VALUES ($1, $2, $3, $4)',
  [`rs-063-${Math.random().toString(36).slice(2)}`, admin, site, deleted ? new Date() : null],
);

describe('20270217000063 companies_domain_unique_live', () => {
  it('exactly one index of ours: the website index, unique + valid + ready, with exactly the migration definition', async () => {
    const { rows } = await db.query(
      `SELECT c.relname, i.indisunique, i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = ANY($1::text[])`,
      [['idx_companies_website_domain_unique', 'idx_companies_admin_email_domain_unique']]);
    expect(rows.map((r: { relname: string }) => r.relname)).toEqual(['idx_companies_website_domain_unique']);
    expect([rows[0].indisunique, rows[0].indisvalid, rows[0].indisready]).toEqual([true, true, true]);
    expect(rows[0].def).toBe(WEBSITE_DEF);
  });

  it('no unique index on companies covers admin_email_domain (key column or expression, any name)', async () => {
    const { rows } = await db.query(
      `SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'public.companies'::regclass AND i.indisunique
          AND (EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attname = 'admin_email_domain'
                         AND a.attnum = ANY (i.indkey::int2[]))
               OR coalesce(pg_get_expr(i.indexprs, i.indrelid), '') ~ '\\madmin_email_domain\\M')`);
    expect(rows).toEqual([]);
  });

  it('two LIVE companies sharing an admin_email_domain (different websites) are ALLOWED (policy: A + B on shared.test)', async () => {
    await inRollback(async () => {
      expect(await insert('rs063-owner.test', 'rs063-owner.test')).toBe('ok');
      expect(await insert('rs063-owner.test', 'rs063-second-brand.test')).toBe('ok');
      expect(await insert('RS063-OWNER.test', null)).toBe('ok');
    });
  });

  it('a second LIVE company on a website domain is refused 23505, case-insensitively', async () => {
    await inRollback(async () => {
      expect(await insert(null, 'rs063-site.test')).toBe('ok');
      expect(await insert('rs063-other-admin.test', 'rs063-site.test')).toBe('23505');
      expect(await insert(null, 'RS063-SITE.test')).toBe('23505');
    });
  });

  it('a SOFT-DELETED company does not hold its domain', async () => {
    await inRollback(async () => {
      expect(await insert('rs063-gone.test', 'rs063-gone.test', true)).toBe('ok');
      expect(await insert('rs063-gone.test', 'rs063-gone.test')).toBe('ok');
      expect(await insert(null, 'rs063-gone.test', true)).toBe('ok');
    });
  });

  it('CONTROL: different website domains coexist', async () => {
    await inRollback(async () => {
      expect(await insert('rs063-one.test', 'rs063-one.test')).toBe('ok');
      expect(await insert('rs063-two.test', 'rs063-two.test')).toBe('ok');
    });
  });

  it('the $post$ block FAILS on a planted UNIQUE admin_email_domain index (the collided 20260322 declaration)', async () => {
    const post = block('post');
    await inRollback(async () => {
      await db.query(post); // the real state passes (non-vacuous)
      await db.query(`CREATE UNIQUE INDEX idx_companies_admin_email_domain_unique ON public.companies (admin_email_domain)
                        WHERE admin_email_domain IS NOT NULL`);
      await expect(db.query(post)).rejects.toThrow(/cover admin_email_domain/);
    });
  });

  it('the $post$ block FAILS on a planted unique admin index under ANY name', async () => {
    const post = block('post');
    await inRollback(async () => {
      await db.query('CREATE UNIQUE INDEX rs063_any_admin ON public.companies (lower(admin_email_domain)) WHERE deleted_at IS NULL');
      await expect(db.query(post)).rejects.toThrow(/rs063_any_admin cover admin_email_domain/);
    });
  });

  it('the $post$ block FAILS on a perturbed website index (an unscoped one of the same name)', async () => {
    const post = block('post');
    await inRollback(async () => {
      await db.query('DROP INDEX public.idx_companies_website_domain_unique');
      await db.query(`CREATE UNIQUE INDEX idx_companies_website_domain_unique ON public.companies (website_domain)
                        WHERE website_domain IS NOT NULL`);
      await expect(db.query(post)).rejects.toThrow(/unexpected definition/);
    });
  });

  it('the $post$ block FAILS when the website index is missing', async () => {
    const post = block('post');
    await inRollback(async () => {
      await db.query('DROP INDEX public.idx_companies_website_domain_unique');
      await expect(db.query(post)).rejects.toThrow(/expected 1 index, found 0/);
    });
  });
});
