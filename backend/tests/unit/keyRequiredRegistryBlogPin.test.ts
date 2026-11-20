/**
 * b3/04 2026-11-18: KEY_REQUIRED_ROUTES (base) is the source of truth for the routes that REQUIRE the client's
 * Idempotency-Key. This pins the two blog routes to it: each registered blog route refuses a missing key through
 * blogReferenceId BEFORE any replay, hold or generation, and the registry describes exactly which modes are keyed.
 * (Behaviour - no key -> 400, nothing held - is asserted in blogRouteBilling.)
 */
import * as fs from 'fs';
import * as path from 'path';
import { KEY_REQUIRED_ROUTES, KEY_REQUIRED_SURFACE } from '../../services/billing/keyRequiredRoutes';

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
const FILES: Record<string, string> = {
  '/api/blogs/generate': 'pages/api/blogs/generate.ts',
  '/api/admin/blog/generate': 'pages/api/admin/blog/generate.ts',
};

describe('blog routes: the registry and the routes agree', () => {
  test('both blog routes are registered, with their surfaces', () => {
    expect(KEY_REQUIRED_ROUTES.find((r) => r.route === '/api/blogs/generate')).toMatchObject({ field: 'mode', values: ['full'], surfaces: [KEY_REQUIRED_SURFACE.companyBlog] });
    expect(KEY_REQUIRED_ROUTES.find((r) => r.route === '/api/admin/blog/generate')).toMatchObject({ field: 'mode', values: { except: ['angles'] }, surfaces: [KEY_REQUIRED_SURFACE.platformBlog] });
  });
  test.each(Object.entries(FILES))('%s: refuses a missing key (blogReferenceId) BEFORE replay / hold / generation', (_route, f) => {
    const s = read(f);
    const ref = s.indexOf("blogReferenceId(req.headers['idempotency-key'])");
    expect(ref).toBeGreaterThan(-1);
    expect(s.indexOf('if (isBlogRefusal(ref))')).toBeGreaterThan(ref);
    for (const later of ['blogReplay(', 'runGeneration({']) expect([later, s.indexOf(later, ref) > ref]).toEqual([later, true]);
    const hold = s.indexOf('holdBlog(');
    if (hold > -1) expect(hold).toBeGreaterThan(ref);
  });
  test("the keyed modes match the code: 'angles' runs before (without) the key on both routes", () => {
    for (const f of Object.values(FILES)) {
      const s = read(f);
      expect([f, s.indexOf("=== 'angles'") > -1 && s.indexOf("=== 'angles'") < s.indexOf("blogReferenceId(req.headers['idempotency-key'])")]).toEqual([f, true]);
    }
  });
  test('every registered route under /api/blogs or /api/admin/blog maps to a file here (nothing unpinned)', () => {
    for (const r of KEY_REQUIRED_ROUTES.filter((e) => /^\/api\/(blogs|admin\/blog)\//.test(e.route))) expect([r.route, Boolean(FILES[r.route])]).toEqual([r.route, true]);
  });
});
