/**
 * Coverage invariant (7c N1 on 064, 2026-11-20): the AlertType union that creditAlertService WRITES and the
 * credit_alert_log.alert_type CHECK that the database ENFORCES must be the SAME set.
 *   - a code type with no CHECK value = every insert of it is refused (a real org's warning silently missing until the
 *     runtime alarm fires);
 *   - a CHECK value no code writes = a dead entry.
 * The CHECK is the one defined by the HIGHEST-versioned migration that adds credit_alert_log_alert_type_check (the
 * effective definition after a replay). The union is read from source; every alternative must be a plain string
 * literal, and the number of alternatives must equal the number of literals read - so a member added as a type
 * reference or computed union cannot hide from the extractor.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = process.cwd();
const SERVICE = fs.readFileSync(path.join(ROOT, 'backend/services/creditAlertService.ts'), 'utf8');
const MIG_DIR = path.join(ROOT, 'supabase/migrations');

/** The union's alternatives (comments stripped) and the string literals among them. */
export function unionMembers(src: string): { alternatives: string[]; literals: string[] } {
  const start = src.indexOf('export type AlertType =');
  expect(start).toBeGreaterThanOrEqual(0);
  // Strip comments FIRST: a ';' inside a member's comment must not end the union (it did: "2026-11-14; c6").
  const rest = src.slice(start + 'export type AlertType ='.length)
    .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const body = rest.slice(0, rest.indexOf(';'));
  const alternatives = body.split('|').map((a) => a.trim()).filter(Boolean);
  const literals = alternatives.filter((a) => /^'[a-z0-9_]+'$/.test(a)).map((a) => a.slice(1, -1));
  return { alternatives, literals };
}

/** A migration's version prefix, normalised to 14 digits (YYYYMMDD -> YYYYMMDD000000) so mixed-length versions order by
 *  DATE, not lexically (7c M3). Non-numeric prefixes return null. */
export const versionKey = (file: string): string | null => {
  const v = file.split('_')[0];
  return /^\d{8}$|^\d{14}$/.test(v) ? v.padEnd(14, '0') : null;
};

/** The literal values of the CHECK in the newest (by normalised version) migration that (re)defines it. */
export function effectiveCheckValues(dir: string): { file: string; values: string[]; version: string } {
  let last: { file: string; values: string[]; version: string } | null = null;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = sql.match(/ADD CONSTRAINT credit_alert_log_alert_type_check CHECK \(alert_type IN \(([\s\S]*?)\)\)/);
    if (!m) continue;
    const key = versionKey(f);
    expect(key).not.toBeNull();
    expect(key).not.toBe(last?.version);   // a normalised tie has no defined winner: fail loudly
    if (!last || key! > last.version) last = { file: f, values: [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]), version: key! };
  }
  expect(last).not.toBeNull();
  return last!;
}

// Parsed in beforeAll, not at module scope, so a parse failure reports against the suite's tests with its assertion
// message instead of "Test suite failed to run" (7c).
let union: ReturnType<typeof unionMembers>;
let check: ReturnType<typeof effectiveCheckValues>;
beforeAll(() => {
  union = unionMembers(SERVICE);
  check = effectiveCheckValues(MIG_DIR);
});

it('the effective CHECK is 064 (the newest definition)', () => {
  expect(check.file).toBe('20270217000064_credit_alert_log_runway_3d.sql');
});

it('the selected definition can actually run: its version prefix is UNIQUE among migrations (7c M3: 56 versions collide)', () => {
  const prefix = check.file.split('_')[0];
  const same = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && f.split('_')[0] === prefix);
  expect(same).toEqual([check.file]);
});

it('control: version keys order by DATE, refuse any length but 8 / 14, and expose a normalised tie', () => {
  expect(versionKey('20280101_x.sql')! > versionKey('20270217000064_x.sql')!).toBe(true);   // 2028 after 2027
  expect(versionKey('20260831_x.sql')! < versionKey('20260831000001_x.sql')!).toBe(true);   // same day, later time
  expect(versionKey('202608310000_x.sql')).toBeNull();                                       // 12 digits: refused
  expect(versionKey('2026_x.sql')).toBeNull();
  expect(versionKey('20260831_x.sql')).toBe(versionKey('20260831000000_x.sql'));             // a tie -> must fail below
});

it('control: two definitions with the same normalised version make the selection fail loudly', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'alert-check-'));
  try {
    const def = (vals: string) => `ALTER TABLE public.credit_alert_log ADD CONSTRAINT credit_alert_log_alert_type_check CHECK (alert_type IN (${vals}));`;
    fs.writeFileSync(path.join(dir, '20260831_a.sql'), def("'low_20'"));
    fs.writeFileSync(path.join(dir, '20260831000000_b.sql'), def("'low_50'"));
    expect(() => effectiveCheckValues(dir)).toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('every AlertType alternative is a plain string literal (nothing invisible to the extractor)', () => {
  expect(union.alternatives.length).toBeGreaterThan(0);
  expect(union.literals).toHaveLength(union.alternatives.length);
});

it('the union and the CHECK are the SAME set (both directions), with no duplicates on either side', () => {
  expect(new Set(union.literals).size).toBe(union.literals.length);
  expect(new Set(check.values).size).toBe(check.values.length);
  expect([...union.literals].sort()).toEqual([...check.values].sort());
});

it('control: a union member written as a type reference is caught by the alternative count', () => {
  const mutated = SERVICE.replace("| 'runway_3d' | 'runway_3d_cleared';", "| 'runway_3d' | 'runway_3d_cleared' | ExtraAlert;");
  expect(mutated).not.toBe(SERVICE);
  const u = unionMembers(mutated);
  expect(u.literals.length).not.toBe(u.alternatives.length);
});

it('control: a code-only type (no CHECK value) breaks set equality', () => {
  const mutated = SERVICE.replace("| 'runway_3d' | 'runway_3d_cleared';", "| 'runway_3d' | 'runway_3d_cleared' | 'runway_1d';");
  expect([...unionMembers(mutated).literals].sort()).not.toEqual([...check.values].sort());
});

it('control: a migration that DROPS one value (runway_3d_cleared) breaks set equality', () => {
  const sql = fs.readFileSync(path.join(MIG_DIR, check.file), 'utf8');
  const dropped = sql.replace("'runway_3d', 'runway_3d_cleared'", "'runway_3d'");
  expect(dropped).not.toBe(sql);
  const m = dropped.match(/ADD CONSTRAINT credit_alert_log_alert_type_check CHECK \(alert_type IN \(([\s\S]*?)\)\)/);
  const values = [...m![1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
  expect(values).toHaveLength(check.values.length - 1);
  expect([...union.literals].sort()).not.toEqual([...values].sort());
});

it('control: a CHECK-only value (dead entry) breaks set equality', () => {
  expect([...union.literals].sort()).not.toEqual([...check.values, 'never_written'].sort());
});
