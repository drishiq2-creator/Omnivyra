/**
 * Every app link a transactional email sends must land on a real page (2026-11-20). The "Someone tried to
 * join your Omnivyra company" email linked to /settings/team, which had no page, so every admin who clicked
 * it got a 404. Producer: supabase/functions/send-transactional-email/index.ts. Consumer: pages/ + the
 * redirects in next.config.js.
 *
 * KNOWN LIMIT (do not over-trust a green run): only links written as a template literal `${<base>}/path`
 * are read, (1) inside the email function via getAppUrl(), and (2) in server code when assigned to
 * ctaUrl / inviteUrl / loginUrl / dashboardUrl / inviteLink with `:` or `=`. A link built by a helper call,
 * by string concatenation, or under another name is INVISIBLE here.
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const EMAIL_FN = path.join(ROOT, 'supabase/functions/send-transactional-email/index.ts');

function appLinkPaths(): string[] {
  const src = fs.readFileSync(EMAIL_FN, 'utf8');
  return [...src.matchAll(/getAppUrl\(\)\}(\/[A-Za-z0-9/_.-]*)/g)].map((m) => m[1]);
}

/**
 * Source 2 (7c): most email CTAs are built by the CALLERS and passed in as ctaUrl / inviteUrl / loginUrl /
 * dashboardUrl / inviteLink, invisible to a scan of the email function. Read every template literal
 * `${<base url>}/path` assigned to one of those names (`name: \`...\`` or `name = \`...\``) in server code.
 * This found the /accept-invite dead link (Team Management "Reinvite").
 */
const CALLER_DIRS = ['backend/services', 'pages/api', 'lib'];
function walk(dir: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '__tests__') continue;
      walk(rel, out);
    } else if (/\.(ts|tsx)$/.test(ent.name) && !/\.test\.(ts|tsx)$/.test(ent.name)) {
      out.push(rel);
    }
  }
  return out;
}
function callerLinkPaths(): Array<{ file: string; route: string }> {
  const found: Array<{ file: string; route: string }> = [];
  const re = /\b(?:ctaUrl|inviteUrl|loginUrl|dashboardUrl|inviteLink)\s*[:=]\s*`\$\{[^`]*?\}(\/[A-Za-z0-9/_.-]*)/g;
  for (const dir of CALLER_DIRS) {
    for (const file of walk(dir)) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const m of src.matchAll(re)) found.push({ file: file.replace(/\\/g, '/'), route: m[1] });
    }
  }
  return found;
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

  it('finds the caller-built links (non-vacuous: today >= 8 across services and API routes)', () => {
    const routes = callerLinkPaths().map((l) => l.route);
    expect(routes.length).toBeGreaterThanOrEqual(8);
    expect(routes).toEqual(expect.arrayContaining(['/company/billing', '/auth/accept-invite', '/accept-invite']));
  });

  it.each(callerLinkPaths().map((l) => [l.file, l.route]))('%s builds %s, which resolves', (file, route) => {
    expect({ file, route, resolves: resolves(route) }).toEqual({ file, route, resolves: true });
  });

  it('/accept-invite (Team Management reinvite) goes to the accept page, query kept by Next.js', () => {
    expect(redirectSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: '/accept-invite', destination: '/auth/accept-invite', permanent: false }),
    ]));
  });

  it('control: a path with no page and no redirect does not resolve', () => {
    expect(resolves('/settings/definitely-not-a-page')).toBe(false);
  });
});
