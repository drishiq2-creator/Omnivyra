/**
 * Every app link a transactional email sends must land on a real page (2026-11-20). The "Someone tried to
 * join your Omnivyra company" email linked to /settings/team, which had no page, so every admin who clicked
 * it got a 404. Producer: supabase/functions/send-transactional-email/index.ts. Consumer: pages/ + the
 * redirects in next.config.js.
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const EMAIL_FN = path.join(ROOT, 'supabase/functions/send-transactional-email/index.ts');

function appLinkPaths(): string[] {
  const src = fs.readFileSync(EMAIL_FN, 'utf8');
  return [...src.matchAll(/getAppUrl\(\)\}(\/[A-Za-z0-9/_.-]*)/g)].map((m) => m[1]);
}

function pageExists(route: string): boolean {
  const base = path.join(ROOT, 'pages', route === '/' ? 'index' : route.replace(/^\//, ''));
  return ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts'].some((ext) => fs.existsSync(base + ext));
}

let redirectSources: Array<{ source: string; destination: string }> = [];
beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cfg = require(path.join(ROOT, 'next.config.js'));
  const resolved = typeof cfg === 'function' ? await cfg('phase-production-server', {}) : cfg;
  redirectSources = (await resolved.redirects()).filter((r: { has?: unknown }) => !r.has);
});

function resolves(route: string): boolean {
  if (pageExists(route)) return true;
  const r = redirectSources.find((x) => x.source === route);
  return !!r && pageExists(r.destination.split('?')[0]);
}

describe('transactional email app links land on a page', () => {
  it('finds the links (non-vacuous)', () => {
    expect(appLinkPaths().length).toBeGreaterThanOrEqual(2);
  });

  it.each(appLinkPaths())('%s resolves to a page or a redirect to one', (route) => {
    expect({ route, resolves: resolves(route) }).toEqual({ route, resolves: true });
  });

  it('/settings/team (join-request email) goes to the team page', () => {
    expect(redirectSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: '/settings/team', destination: '/team-management', permanent: false }),
    ]));
    expect(pageExists('/team-management')).toBe(true);
  });

  it('control: a path with no page and no redirect does not resolve', () => {
    expect(resolves('/settings/definitely-not-a-page')).toBe(false);
  });
});
