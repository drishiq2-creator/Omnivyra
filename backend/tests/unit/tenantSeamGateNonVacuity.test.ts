/**
 * S2 (2026-11-19): the tenant-seam gate (scripts/check-tenant-seam.js --baseline <file> --block-new) must not pass
 * VACUOUSLY. A run that scans no files, or a scanner that stops recognising a tenant call, reports "0 keys grew" and
 * exits 0 - the same output as a clean branch. These cases pin, on a throwaway fixture root:
 *   (a) the gate reports the number of files it scanned, and it is the fixture's real count (> 0);
 *   (b) an unseamed tenant read IS a finding (R1), so a site added above the baseline BLOCKS (exit 1, "NEW <key>");
 *   (c) the same tree against a baseline that already records the site passes, naming 0 grown keys;
 * and, on the real repository, that every directory the gate walks exists and holds source files.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GATE = path.join(ROOT, 'scripts', 'check-tenant-seam.js');

const REGISTRY = [
  'export const TENANT_TABLES = {',
  "  widgets: { column: 'company_id', tag: 'content' },",
  '}',
  '',
].join('\n');

function withFixture<T>(baseline: Record<string, number>, fn: (dir: string, baselineFile: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-nonvacuity-'));
  try {
    fs.mkdirSync(path.join(dir, 'backend', 'db'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'pages', 'api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backend', 'db', 'tenantTables.ts'), REGISTRY);
    fs.writeFileSync(path.join(dir, 'backend', 'db', 'crossTenantAllowList.ts'), 'export const CROSS_TENANT_ALLOW_LIST = [];\n');
    fs.writeFileSync(
      path.join(dir, 'pages', 'api', 'widgets.ts'),
      "import { supabase } from '../../backend/db/supabaseClient';\nexport async function list() {\n  return supabase.from('widgets').select('id');\n}\n",
    );
    const baselineFile = path.join(dir, 'baseline.json');
    fs.writeFileSync(baselineFile, JSON.stringify(baseline));
    return fn(dir, baselineFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const run = (dir: string, baselineFile: string) =>
  spawnSync(process.execPath, [GATE, '--root', dir, '--baseline', baselineFile, '--block-new'], { encoding: 'utf8' });
const scanned = (stdout: string) => Number((stdout.match(/scanned (\d+) files/) || [])[1] ?? NaN);

const KEY = 'R1|pages/api/widgets.ts|widgets|read';

describe('tenant-seam gate is not vacuous', () => {
  it('(a)+(b) scans the fixture files (> 0) and BLOCKS an unseamed tenant read that the baseline does not record', () => {
    withFixture({}, (dir, baselineFile) => {
      const r = run(dir, baselineFile);
      // tenantTables.ts + crossTenantAllowList.ts + widgets.ts
      expect(scanned(r.stdout)).toBe(3);
      expect(r.stdout).toContain(`NEW ${KEY} (+1)`);
      expect(r.stderr).toMatch(/BLOCK: 1 new unseamed sites/);
      expect(r.status).toBe(1);
    });
  });

  it('(c) the same tree passes against a baseline that records the site (0 keys grew)', () => {
    withFixture({ [KEY]: 1 }, (dir, baselineFile) => {
      const r = run(dir, baselineFile);
      expect(scanned(r.stdout)).toBe(3);
      expect(r.stdout).toMatch(/vs baseline: 0 keys grew, 0 findings resolved/);
      expect(r.status).toBe(0);
    });
  });

  it('every directory the gate walks exists in the repository and holds .ts sources', () => {
    const src = fs.readFileSync(GATE, 'utf8');
    const m = src.match(/for \(const d of \[([^\]]+)\]\) walk\(/);
    expect(m).not.toBeNull();
    const dirs = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(dirs).toEqual(['backend', 'pages', 'lib']);
    for (const d of dirs) {
      const abs = path.join(ROOT, d);
      expect(fs.existsSync(abs)).toBe(true);
      const hasTs = (p: string): boolean =>
        fs.readdirSync(p, { withFileTypes: true }).some((e) =>
          e.isDirectory() ? !/^(node_modules|\.next)$/.test(e.name) && hasTs(path.join(p, e.name)) : /\.tsx?$/.test(e.name));
      expect(hasTs(abs)).toBe(true);
    }
  });
});
