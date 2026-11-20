/**
 * Dropped-error read gate (scripts/check-dropped-supabase-error.js): three shape detectors + the per-file, per-shape ratchet.
 *   A: `{ data }` destructured from a DB read with no `error` key.
 *   B: the error IS read, then answered with an absence value (null / [] / {} / false; also `catch { return null }`).
 *   C: the error IS tested, and the branch neither refuses nor answers - it logs and falls through.
 * Controls: the correct forms are NOT flagged; a new instance in an allowlisted file FAILS; fixing one shape while
 * adding another in the same file FAILS (no netting); a reduction PASSES; an empty scan refuses to pass.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gate = require('../../../scripts/check-dropped-supabase-error.js') as {
  scanSource: (s: string) => number[];
  scanSourceB: (s: string) => number[];
  scanSourceC: (s: string) => number[];
};
const SCRIPT = path.join(__dirname, '../../../scripts/check-dropped-supabase-error.js');
const L = (...lines: string[]): string => lines.join('\n');
const READ = "const { data, error } = await supabase.from('t').select('*');";

describe('scanSource (shape A): { data } without error', () => {
  it('flags { data } from a .from() read', () => {
    expect(gate.scanSource("const { data } = await supabase.from('t').select('*');")).toEqual([1]);
  });
  it('CONTROL: { data, error } is not flagged', () => {
    expect(gate.scanSource(READ)).toEqual([]);
  });
  it('flags a renamed data without error, and a multi-line chain', () => {
    expect(gate.scanSource(L('const { data: rows } = await ownedDbTable("t")', '  .select("id")', '  .eq("a", 1);'))).toEqual([1]);
  });
  it('flags rpc reads; ignores non-DB awaits', () => {
    expect(gate.scanSource("const { data } = await supabase.rpc('fn', {});")).toEqual([1]);
    expect(gate.scanSource('const { data } = await fetchSomething();')).toEqual([]);
  });
  it('a whole-result read is not shape A (shape B covers its absence answer)', () => {
    expect(gate.scanSource("const r = await supabase.from('t').select('*'); if (r.error) throw r.error;")).toEqual([]);
  });
});

describe('scanSourceB: the error is read, then answered with an absence value', () => {
  it('flags if (error) return null / [] (inline and in a logging block), and r.error', () => {
    expect(gate.scanSourceB(L(READ, 'if (error) return null;'))).toEqual([2]);
    expect(gate.scanSourceB(L(READ, 'if (error) {', "  console.error('x', error);", '  return [];', '}'))).toEqual([2]);
    expect(gate.scanSourceB(L("const r = await supabase.from('t').select();", 'if (r.error || !r.data) return [];'))).toEqual([2]);
  });
  it('flags catch { return null } around a DB read', () => {
    expect(gate.scanSourceB(L('try {', "  const { data } = await supabase.rpc('f');", '  return data;', '} catch {', '  return null;', '}'))).toEqual([4]);
  });
  it('CONTROLS: a throw, if (!error), a non-DB error, a typed result, a catch around a non-DB call', () => {
    expect(gate.scanSourceB(L(READ, 'if (error) throw new Error("x");'))).toEqual([]);
    expect(gate.scanSourceB(L(READ, 'if (!error) return null;'))).toEqual([]);
    expect(gate.scanSourceB(L('const { error } = validate(x);', 'if (error) return null;'))).toEqual([]);
    expect(gate.scanSourceB(L("const r = await supabase.from('t').select();", "if (r.error) return { ok: false, reason: 'unreadable' };"))).toEqual([]);
    expect(gate.scanSourceB(L('try {', '  x = await fetch(u);', '} catch { return null; }'))).toEqual([]);
  });
});

describe('scanSourceC: the error is tested, the branch neither refuses nor answers (falls through)', () => {
  it('flags a logging block and an inline log', () => {
    expect(gate.scanSourceC(L(READ, 'if (error) {', "  logger.warn('x', { error });", '}', 'const next = 1;'))).toEqual([2]);
    expect(gate.scanSourceC(L(READ, 'if (error) console.error(error);'))).toEqual([2]);
  });
  it('CONTROLS: a throw (even after nested blocks), a return, an if/else, a shape-B line', () => {
    expect(gate.scanSourceC(L(READ, 'if (error) {', '  if (x) {', '    log(1);', '  }', '  throw e;', '}'))).toEqual([]);
    expect(gate.scanSourceC(L(READ, 'if (error) {', '  return { ok: false };', '}'))).toEqual([]);
    expect(gate.scanSourceC(L(READ, 'if (error) {', "  logger.warn('x');", '} else {', '  use(data);', '}'))).toEqual([]);
    expect(gate.scanSourceC(L(READ, 'if (error) return null;'))).toEqual([]);
  });
});

describe('the per-file, per-shape ratchet', () => {
  function repo(files: Record<string, string>, baseline: Record<string, Record<string, number>>) {
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
    expect(repo({ 'backend/a.ts': one }, { 'backend/a.ts': { A: 1 } })().status).toBe(0);
  });
  it('FAIL: a new instance in an ALLOWLISTED file (count rises)', () => {
    const r = repo({ 'backend/a.ts': one + one }, { 'backend/a.ts': { A: 1 } })();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('backend/a.ts [shape A]: 2 (baseline 1)');
  });
  it('FAIL: an instance in a file not in the baseline', () => {
    expect(repo({ 'backend/a.ts': one, 'pages/api/b.ts': one }, { 'backend/a.ts': { A: 1 } })().status).toBe(1);
  });
  it('PASS + reported: a reduction (the fix lowers its own entry)', () => {
    const r = repo({ 'backend/a.ts': READ + '\n', 'backend/c.ts': one }, { 'backend/a.ts': { A: 1 }, 'backend/c.ts': { A: 1 } })();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REDUCED');
  });
  it('FAIL: fixing a shape-A read while ADDING a shape-B read in the same file (no netting across shapes)', () => {
    const r = repo({ 'backend/a.ts': L(READ, 'if (error) return null;', '') }, { 'backend/a.ts': { A: 1 } })();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('backend/a.ts [shape B]: 1 (baseline 0)');
  });
  it('tests are out of scope', () => {
    expect(repo({ 'backend/tests/unit/x.test.ts': one, 'backend/a.ts': one }, { 'backend/a.ts': { A: 1 } })().status).toBe(0);
  });
  it('NO VACUOUS PASS: zero instances anywhere refuses (exit 2)', () => {
    expect(repo({ 'backend/a.ts': 'export const x = 1;\n' }, {})().status).toBe(2);
  });
});
