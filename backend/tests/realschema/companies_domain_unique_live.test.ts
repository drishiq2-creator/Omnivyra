/**
 * 20270217000063_companies_domain_unique_live: one LIVE company per domain, enforced by the database
 * (CI-309 merge precondition). Pins, on the replayed schema:
 *   - both partial unique indexes exist with EXACTLY the migration's definition (an unscoped or
 *     non-lower index of the same name, e.g. from a replayed collided 20260322/20260713 file, fails);
 *   - a second live company on a domain is refused 23505 (what CI-309's race path answers with a join
 *     request), case-insensitively;
 *   - a soft-deleted company does NOT hold its domain;
 *   - the migration's own $post$ block can FAIL (run against a perturbed index, in a rolled-back
 *     transaction): a postcondition that cannot fail is worse than none.
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

const DEFS: Record<string, string> = {
  idx_companies_admin_email_domain_unique:
    'CREATE UNIQUE INDEX idx_companies_admin_email_domain_unique ON public.companies USING btree (lower(admin_email_domain)) WHERE ((deleted_at IS NULL) AND (admin_email_domain IS NOT NULL))',
  idx_companies_website_domain_unique:
    'CREATE UNIQUE INDEX idx_companies_website_domain_unique ON public.companies USING btree (lower(website_domain)) WHERE ((deleted_at IS NULL) AND (website_domain IS NOT NULL))',
};

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
  it('both indexes exist, unique + valid + ready, with exactly the migration definition', async () => {
    const { rows } = await db.query(
      `SELECT c.relname, i.indisunique, i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = ANY($1::text[])`, [Object.keys(DEFS)]);
    expect(rows.map((r: { relname: string }) => r.relname).sort()).toEqual(Object.keys(DEFS).sort());
    for (const r of rows) {
      expect([r.indisunique, r.indisvalid, r.indisready]).toEqual([true, true, true]);
      expect(r.def).toBe(DEFS[r.relname]);
    }
  });

  it('a second LIVE company on an admin domain is refused 23505, case-insensitively', async () => {
    await inRollback(async () => {
      expect(await insert('rs063-acme.test', null)).toBe('ok');
      expect(await insert('rs063-acme.test', null)).toBe('23505');
      expect(await insert('RS063-ACME.test', null)).toBe('23505');
    });
  });

  it('a second LIVE company on a website domain is refused 23505', async () => {
    await inRollback(async () => {
      expect(await insert(null, 'rs063-site.test')).toBe('ok');
      expect(await insert(null, 'rs063-site.test')).toBe('23505');
    });
  });

  it('a SOFT-DELETED company does not hold its domain', async () => {
    await inRollback(async () => {
      expect(await insert('rs063-gone.test', 'rs063-gone.test', true)).toBe('ok');
      expect(await insert('rs063-gone.test', 'rs063-gone.test')).toBe('ok');
      expect(await insert('rs063-gone.test', null, true)).toBe('ok');
    });
  });

  it('CONTROL: different domains coexist', async () => {
    await inRollback(async () => {
      expect(await insert('rs063-one.test', 'rs063-one.test')).toBe('ok');
      expect(await insert('rs063-two.test', 'rs063-two.test')).toBe('ok');
    });
  });

  it('the $post$ block FAILS on a perturbed index (an unscoped one of the same name)', async () => {
    const post = block('post');
    await inRollback(async () => {
      await db.query('DROP INDEX public.idx_companies_admin_email_domain_unique');
      await db.query(`CREATE UNIQUE INDEX idx_companies_admin_email_domain_unique ON public.companies (admin_email_domain)
                        WHERE admin_email_domain IS NOT NULL`);
      await expect(db.query(post)).rejects.toThrow(/unexpected definition/);
    });
  });

  it('the $post$ block FAILS when an index is missing, and passes on the real schema (non-vacuous)', async () => {
    const post = block('post');
    await inRollback(async () => {
      await db.query(post); // the real state passes
      await db.query('DROP INDEX public.idx_companies_website_domain_unique');
      await expect(db.query(post)).rejects.toThrow(/expected 2 indexes, found 1/);
    });
  });
});
