/**
 * Real-schema cover for 20270217000064_credit_alert_log_runway_3d (c6, 2026-11-20; review: 7c).
 * The replay has applied 064 on top of the baseline (prod snapshot) 12-value CHECK. Proven here on real rows:
 *   - runway_3d / runway_3d_cleared are admitted, every earlier type still is, an unknown type is still refused;
 *   - the preflight refuses a drifted or NOT VALID constraint (nothing changes);
 *   - the rollback refuses while a runway_* row exists, and otherwise restores the exact 12-value definition.
 * Synthetic org ids only; every mutation runs inside a rolled-back transaction.
 */
import * as fs from 'fs';
import * as path from 'path';
import { constraintDef, db, inRollback } from './setup';

const ORG = '0eda0064-0000-4000-8000-000000000064';
const ROOT = process.cwd();
const MIG = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20270217000064_credit_alert_log_runway_3d.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(ROOT, 'supabase/migrations/rollbacks/credit_alert_log_runway_3d_rollback.sql'), 'utf8');
const OLD12 = ['low_20pct', 'low_10pct', 'depleted', 'auto_topup', 'low_100', 'low_50', 'low_20', 'velocity_200',
  'consumed_80', 'consumed_90', 'consumed_95', 'forecast_insufficient_85'];
const defOf = (types: string[]) => `CHECK ((alert_type = ANY (ARRAY[${types.map((t) => `'${t}'::text`).join(', ')}])))`;
const DEF12 = defOf(OLD12);
const DEF14 = defOf([...OLD12, 'runway_3d', 'runway_3d_cleared']);

/** Run inside a savepoint; 'ok' or the error message. Keeps the effect on success. */
async function run(sql: string, params: unknown[] = []): Promise<string> {
  await db.query('SAVEPOINT r064');
  try {
    if (params.length) await db.query(sql, params); else await db.query(sql);
    await db.query('RELEASE SAVEPOINT r064');
    return 'ok';
  } catch (e: any) {
    await db.query('ROLLBACK TO SAVEPOINT r064');
    return String(e.message);
  }
}
const insert = (type: string) => run(
  `INSERT INTO public.credit_alert_log (organization_id, alert_type, balance_at_alert) VALUES ($1, $2, 0)`, [ORG, type]);

it('after 064 the live CHECK is exactly the validated 14-value list', async () => {
  expect(await constraintDef('credit_alert_log_alert_type_check')).toBe(DEF14);
  const { rows } = await db.query(`SELECT convalidated FROM pg_constraint WHERE conname = 'credit_alert_log_alert_type_check'`);
  expect(rows[0].convalidated).toBe(true);
});

it('runway_3d and runway_3d_cleared are admitted; every earlier type still is; an unknown type is refused', async () => {
  await inRollback(async () => {
    for (const t of ['runway_3d', 'runway_3d_cleared', ...OLD12]) expect(await insert(t)).toBe('ok');
    expect(await insert('runway_7d')).toMatch(/credit_alert_log_alert_type_check/);
  });
});

it('the preflight is satisfied by the baseline 12-value definition (re-run from the pre-064 state)', async () => {
  await inRollback(async () => {
    expect(await run(ROLLBACK)).toBe('ok');
    expect(await constraintDef('credit_alert_log_alert_type_check')).toBe(DEF12);
    expect(await run(MIG)).toBe('ok');
    expect(await constraintDef('credit_alert_log_alert_type_check')).toBe(DEF14);
  });
});

it('a drifted constraint is refused and left untouched', async () => {
  await inRollback(async () => {
    const drifted = defOf([...OLD12, 'something_else']);
    await db.query(`ALTER TABLE public.credit_alert_log DROP CONSTRAINT credit_alert_log_alert_type_check,
      ADD CONSTRAINT credit_alert_log_alert_type_check ${drifted}`);
    expect(await run(MIG)).toMatch(/064 preflight: .* is not the known 12-value list/);
    expect(await constraintDef('credit_alert_log_alert_type_check')).toBe(drifted);
  });
});

it('a NOT VALID 12-value constraint is refused and left untouched', async () => {
  // pg_get_constraintdef appends " NOT VALID", so the exact-definition check refuses it first; convalidated is a backstop.
  await inRollback(async () => {
    await db.query(`ALTER TABLE public.credit_alert_log DROP CONSTRAINT credit_alert_log_alert_type_check,
      ADD CONSTRAINT credit_alert_log_alert_type_check ${DEF12} NOT VALID`);
    expect(await run(MIG)).toMatch(/064 preflight: .*(is not the known 12-value list|is NOT VALID)/);
    expect(await constraintDef('credit_alert_log_alert_type_check')).toBe(`${DEF12} NOT VALID`);
  });
});

it('a missing constraint is refused', async () => {
  await inRollback(async () => {
    await db.query('ALTER TABLE public.credit_alert_log DROP CONSTRAINT credit_alert_log_alert_type_check');
    expect(await run(MIG)).toMatch(/064 preflight: credit_alert_log_alert_type_check is missing/);
  });
});

it('the rollback refuses while a runway_* row exists, and changes nothing', async () => {
  await inRollback(async () => {
    expect(await insert('runway_3d_cleared')).toBe('ok');
    expect(await run(ROLLBACK)).toMatch(/064 rollback: 1 runway_\* row\(s\) exist/);
    expect(await constraintDef('credit_alert_log_alert_type_check')).toBe(DEF14);
  });
});

it('control: with no runway_* row the rollback restores the 12-value list and runway_3d is refused again', async () => {
  await inRollback(async () => {
    expect(await run(ROLLBACK)).toBe('ok');
    expect(await constraintDef('credit_alert_log_alert_type_check')).toBe(DEF12);
    expect(await insert('runway_3d')).toMatch(/credit_alert_log_alert_type_check/);
    expect(await insert('consumed_80')).toBe('ok');
  });
});
