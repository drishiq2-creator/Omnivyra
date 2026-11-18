/**
 * THE client contract for key-requiring routes (b3 2026-11-18, BLOCKING for the double-charge PR set):
 * every client call that hits a key-requiring route + value sends the Idempotency-Key.
 *
 * Route list AND per-request rule: c6's server registry (backend/services/billing/keyRequiredRoutes).
 * Call sites: a scan of the client tree for each route PATH (backend/tests/helpers/keyContractScan).
 * Positive controls: a planted unkeyed caller is caught; the real scan is non-empty and finds the
 * callers we know about.
 */
import * as fs from 'fs';
import * as path from 'path';
import { KEY_REQUIRED_ROUTES } from '../../services/billing/keyRequiredRoutes';
import { scanSource, isRequired, type CallSite } from '../helpers/keyContractScan';

const ROOT = process.cwd();
const CLIENT_DIRS = ['components', 'pages', 'hooks', 'lib'];

function clientFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    if (rel.startsWith('pages/api/') || name === 'node_modules' || name.startsWith('.')) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) clientFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(rel);
  }
  return out;
}

const SITES: CallSite[] = CLIENT_DIRS.flatMap((d) => clientFiles(path.join(ROOT, d))).flatMap((rel) =>
  scanSource(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'), KEY_REQUIRED_ROUTES),
);

describe('registry is the source (derived, not typed)', () => {
  it('the server registry is non-empty and carries the activity-workspace and blog routes', () => {
    const routes = KEY_REQUIRED_ROUTES.map((e) => e.route);
    expect(routes).toEqual(expect.arrayContaining(['/api/activity-workspace/content', '/api/blogs/generate', '/api/admin/blog/generate']));
  });
});

describe('every key-requiring client call sends the Idempotency-Key', () => {
  it('scan is non-empty and finds the known callers (positive control against a vacuous pass)', () => {
    const files = new Set(SITES.filter((s) => s.required).map((s) => s.file));
    for (const known of [
      'lib/activity-workspace/postGenerateVariants.ts',
      'hooks/useActivityWorkspaceRefinementOps.ts',
      'components/blog/BlogGenerateModalMain.tsx',
      'pages/blogs/suggestions.tsx',
      'pages/admin/blog/content-refine.tsx',
    ]) expect(files).toContain(known);
  });

  it('no required call is unkeyed', () => {
    const offenders = SITES.filter((s) => s.required && !s.keyed).map((s) => `${s.file} -> ${s.route} (${s.value ?? 'non-literal'})`);
    expect(offenders).toEqual([]);
  });

  it('exempt calls are recognised (angles / improve_variant are not required)', () => {
    const exempt = SITES.filter((s) => !s.required).map((s) => s.value);
    expect(exempt).toEqual(expect.arrayContaining(['angles']));
  });
});

describe('scanner controls (planted callers)', () => {
  const REG = KEY_REQUIRED_ROUTES;
  it('a planted UNKEYED billed call is caught', () => {
    const planted = `async function x() { await fetch('/api/activity-workspace/content', { method: 'POST', body: JSON.stringify({ action: 'generate_master' }) }); }`;
    const sites = scanSource('planted.ts', planted, REG);
    expect(sites).toHaveLength(1);
    expect(sites[0].required && !sites[0].keyed).toBe(true);
  });
  it('a planted caller via an ALIAS constant is still seen', () => {
    const planted = `const API = '/api/blogs/generate'; async function y() { await apiFetch(API, { body: JSON.stringify({ mode: 'full' }) }); }`;
    const sites = scanSource('planted.ts', planted, REG);
    expect(sites.map((s) => [s.required, s.keyed])).toEqual([[true, false]]);
  });
  it('a keyed call passes; an exempt value is not required; a non-literal value is conservatively required', () => {
    const keyed = `await fetchWithAuth('/api/admin/blog/generate', { headers: { ...op.headers }, body: JSON.stringify({ mode: 'full' }) });`;
    expect(scanSource('k.ts', keyed, REG).map((s) => [s.required, s.keyed])).toEqual([[true, true]]);
    const exempt = `await fetch('/api/blogs/generate', { body: JSON.stringify({ mode: 'angles' }) });`;
    expect(scanSource('e.ts', exempt, REG)[0].required).toBe(false);
    const dynamic = `await fetch('/api/activity-workspace/content', { body: JSON.stringify({ action, ...b }) });`;
    expect(scanSource('d.ts', dynamic, REG)[0].required).toBe(true);
    expect(isRequired(REG.find((e) => e.route === '/api/admin/blog/generate')!, 'full')).toBe(true);
  });
});
