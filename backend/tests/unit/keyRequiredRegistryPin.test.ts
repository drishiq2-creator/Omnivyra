/**
 * b3/04 2026-11-18: KEY_REQUIRED_ROUTES is the source of truth for which billed routes/actions REQUIRE the client's
 * Idempotency-Key (04's client contract test derives its list from it). This pins the server to the registry in BOTH
 * directions for the activity-workspace route (the blog routes are pinned on the blog branch):
 *   - every key-REQUIRING site in the handler names its surface from KEY_REQUIRED_SURFACE (no string literal);
 *   - every registry surface for this route is used by a key-requiring site;
 *   - the sites that ACCEPT a key without requiring it (requireClientKey: false) are NOT in the registry.
 * The behaviour itself (no key -> 400, nothing charged) is asserted in billedRequestRecoveryRoutes and
 * activityContentTenantBinding.
 */
import * as fs from 'fs';
import * as path from 'path';
import { KEY_REQUIRED_ROUTES, KEY_REQUIRED_SURFACE } from '../../services/billing/keyRequiredRoutes';

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
const handler = read('backend/services/activityWorkspace/contentRouteHandler.ts');

describe('activity-workspace content: the registry and the handler agree', () => {
  const entry = KEY_REQUIRED_ROUTES.find((r) => r.route === '/api/activity-workspace/content')!;
  test('the route is registered with its three billed actions', () => {
    expect(entry).toBeDefined();
    expect(entry.values).toEqual(['generate_master', 'generate_variants', 'refine_variant']);
  });
  test.each([
    ['generateMaster', /throw new BilledRouteKeyRequiredError\(KEY_REQUIRED_SURFACE\.generateMaster\)/],
    ['generateVariants', /recovery: \{ surface: KEY_REQUIRED_SURFACE\.generateVariants,[^}]*idempotencyKeyHeader: req\.headers\['idempotency-key'\]/],
    ['refineVariant', /surface: KEY_REQUIRED_SURFACE\.refineVariant,/],
  ])('%s: a key-requiring site uses the registry surface', (_n, re) => {
    expect(handler).toMatch(re);
  });
  test('every registry surface of this route is used by the handler', () => {
    for (const s of entry.surfaces) {
      const name = Object.entries(KEY_REQUIRED_SURFACE).find(([, v]) => v === s)![0];
      expect([s, handler.includes(`KEY_REQUIRED_SURFACE.${name}`)]).toEqual([s, true]);
    }
  });
  test('no key-requiring surface is spelled as a string literal in the handler (it would escape the registry)', () => {
    for (const s of entry.surfaces) expect([s, handler.includes(`'${s}'`)]).toEqual([s, false]);
  });
  test('the refine billed path does not opt out of the key (requireClientKey: false is only for the assist routes)', () => {
    const refine = handler.slice(handler.indexOf('surface: KEY_REQUIRED_SURFACE.refineVariant'), handler.indexOf("module:        'http:activity_workspace_refine_variant'"));
    expect(refine.length).toBeGreaterThan(0);
    expect(refine).not.toMatch(/requireClientKey:\s*false/);
  });
  test('the assist routes (key accepted, not required) are NOT registered', () => {
    for (const r of ['/api/campaign-content/assist', '/api/creator-templates/field-assist', '/api/creator-templates/chat-brief']) {
      expect([r, KEY_REQUIRED_ROUTES.some((e) => e.route === r)]).toEqual([r, false]);
    }
    for (const f of ['pages/api/campaign-content/assist.ts', 'pages/api/creator-templates/field-assist.ts', 'pages/api/creator-templates/chat-brief.ts']) {
      expect([f, /requireClientKey:\s*false/.test(read(f))]).toEqual([f, true]);
    }
  });
});

// 7c/04 2026-11-18: KEY_ACCEPTED_ROUTES - accepts a key but does not require it - is EXACT-SET equal to the code.
import { KEY_ACCEPTED_ROUTES } from '../../services/billing/keyRequiredRoutes';
describe('KEY_ACCEPTED_ROUTES equals the code exactly', () => {
  const ROOT = process.cwd();
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const walk = (d: string, out: string[]) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out); else if (/\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const routeOf = (f: string) => '/' + path.relative(path.join(ROOT, 'pages'), f).split(path.sep).join('/').replace(/\.ts$/, '').replace(/\/index$/, '');
  const pageFiles = walk(path.join(ROOT, 'pages', 'api'), []);
  const required = new Set(KEY_REQUIRED_ROUTES.map((r) => r.route));
  test('per-request: every wirePhase2Route caller not in KEY_REQUIRED_ROUTES, and nothing else', () => {
    const callers = pageFiles.filter((f) => /\bwirePhase2Route\s*\(/.test(strip(fs.readFileSync(f, 'utf8')))).map(routeOf);
    expect(callers.length).toBeGreaterThanOrEqual(20);   // non-vacuous
    const fromCode = callers.filter((r) => !required.has(r)).sort();
    const fromRegistry = KEY_ACCEPTED_ROUTES.filter((r) => r.fallback === 'per-request').map((r) => r.route).sort();
    expect(fromRegistry).toEqual(fromCode);
  });
  test('content-hash: exactly the routes whose recovery opts out with requireClientKey: false', () => {
    const fromCode = pageFiles.filter((f) => /requireClientKey:\s*false/.test(strip(fs.readFileSync(f, 'utf8')))).map(routeOf).sort();
    expect(fromCode.length).toBeGreaterThan(0);
    expect(KEY_ACCEPTED_ROUTES.filter((r) => r.fallback === 'content-hash').map((r) => r.route).sort()).toEqual(fromCode);
  });
  test('no route is both required and accepted', () => {
    for (const r of KEY_ACCEPTED_ROUTES) expect([r.route, required.has(r.route)]).toEqual([r.route, false]);
  });
});
