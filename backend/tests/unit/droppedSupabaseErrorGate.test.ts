/**
 * Dropped-error read gate (scripts/check-dropped-supabase-error.js): shape detection + the per-file ratchet.
 * Controls: the correct `{ data, error }` form is NOT flagged; a new instance in an allowlisted file FAILS;
 * a reduction PASSES; an empty scan refuses to pass (no vacuous green).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gate = require('../../../scripts/check-dropped-supabase-error.js') as { scanSource: (s: string) => number[] };
const SCRIPT = path.join(__dirname, '../../../scripts/check-dropped-supabase-error.js');

describe('scanSource: the dropped-error shape', () => {
  it('flags { data } from a .from() read', () => {
    expect(gate.scanSource("const { data } = await supabase.from('t').select('*');")).toEqual([1]);
  });
  it('CONTROL: { data, error } is not flagged', () => {
    expect(gate.scanSource("const { data, error } = await supabase.from('t').select('*');")).toEqual([]);
  });
  it('flags a renamed data without error, and a multi-line chain', () => {
    const src = ['const { data: rows } = await ownedDbTable("t")', '  .select("id")', '  .eq("a", 1);'].join('\n');
    expect(gate.scanSource(src)).toEqual([1]);
  });
  it('flags rpc reads; ignores non-DB awaits', () => {
    expect(gate.scanSource("const { data } = await supabase.rpc('fn', {});")).toEqual([1]);
    expect(gate.scanSource('const { data } = await fetchSomething();')).toEqual([]);
  });
  it('LIMIT (stated): a whole-result read is not this shape', () => {
    expect(gate.scanSource("const r = await supabase.from('t').select('*'); if (r.error) throw r.error;")).toEqual([]);
  });
});

describe('the per-file ratchet', () => {
  function repo(files: Record<string, string>, baseline: Record<string, number>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropped-err-'));
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    }
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts/dropped-supabase-error-baseline.json'), JSON.stringify({ files: baseline }));
    return (extra: string[] = []) => spawnSync(process.execPath, [SCRIPT, '--root', dir, ...extra], { encoding: 'utf8' });
  }
  const one = "const { data } = await supabase.from('t').select('*');\n";

  it('PASS at baseline', () => {
    expect(repo({ 'backend/a.ts': one }, { 'backend/a.ts': 1 })().status).toBe(0);
  });
  it('FAIL: a new instance in an ALLOWLISTED file (count rises)', () => {
    const r = repo({ 'backend/a.ts': one + one }, { 'backend/a.ts': 1 })();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('backend/a.ts: 2 (baseline 1)');
  });
  it('FAIL: an instance in a file not in the baseline', () => {
    expect(repo({ 'backend/a.ts': one, 'pages/api/b.ts': one }, { 'backend/a.ts': 1 })().status).toBe(1);
  });
  it('PASS + reported: a reduction (the fix lowers its own entry)', () => {
    const r = repo({ 'backend/a.ts': "const { data, error } = await supabase.from('t').select('*');\n", 'backend/c.ts': one }, { 'backend/a.ts': 1, 'backend/c.ts': 1 })();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REDUCED');
  });
  it('tests are out of scope', () => {
    expect(repo({ 'backend/tests/unit/x.test.ts': one, 'backend/a.ts': one }, { 'backend/a.ts': 1 })().status).toBe(0);
  });
  it('NO VACUOUS PASS: zero instances anywhere refuses (exit 2)', () => {
    expect(repo({ 'backend/a.ts': 'export const x = 1;\n' }, {})().status).toBe(2);
  });
});
