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
