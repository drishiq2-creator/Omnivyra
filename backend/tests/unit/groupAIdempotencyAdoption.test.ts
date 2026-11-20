/**
 * WS1-E6-T006 — Group A backend idempotency adoption gate + behaviour.
 *
 * ADOPTION GATE (permanent, three-way). It fails when:
 *   1. an authorized endpoint LOSES withIdempotency,
 *   2. a new authorized endpoint is added without adoption,
 *   3. an UNAUTHORIZED endpoint adopts it — Group B dormant endpoints and the
 *      three billing endpoints remain blocked by OR-08/ED-01, so silent
 *      adoption there must break the build too.
 *
 * BEHAVIOUR. The middleware's semantics are proven exhaustively in
 * withIdempotencyCallerScoping.test.ts against the real implementation. What
 * needs proving HERE is that each endpoint is wired such that those semantics
 * actually apply to it: the wrapper sits inside the route factory, the
 * handler's own authorization still runs, and each endpoint owns a distinct
 * replay namespace.
 *
 * No database, no network.
 */
import fs from 'fs';
import path from 'path';

const REPO = path.join(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(REPO, rel));
/**
 * PL-128 (c6 2026-11-20): an ADOPTION is a call `withIdempotency(` in code - not the word in a comment. The gate used
 * `includes('withIdempotency')` on raw source, so two routes whose comments explain why they deliberately do NOT adopt
 * (prospects/[id]/problems.ts, prospect-identity/erasure-requests/index.ts: a unique constraint / the ledger is their
 * idempotency) read as unauthorized adopters and kept this suite red on main since 2026-10-30/31.
 */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
/**
 * 89 (PL-128 delta): the detector works on SOURCE so its own cases can pin it. It deliberately keys on the CALL only,
 * not import+call: a route that reimplements or re-exports withIdempotency locally still calls it and must still count
 * as an adopter here; the SHARED import is separately required of every sanctioned route (the wiring proofs below).
 * A third comment-only false positive existed besides problems / erasure: admin/credits/idempotency/list.ts names the
 * middleware's table (masked by the admin prefix). Real adopters on main at 7a31852bd: 37 of 40 substring hits.
 */
const adoptsSource = (src: string) => stripComments(src).includes('withIdempotency(');
const adopts = (rel: string) => adoptsSource(read(rel));

/** OR-08 Group A — the ONLY endpoints authorized to adopt. */
const AUTHORIZED: Array<[string, string]> = [
  ['pages/api/social/publish.ts', 'social-publish'],
  ['pages/api/blogs/[id]/publish.ts', 'blogs-publish'],
  ['pages/api/activity-workspace/schedule.ts', 'activity-workspace-schedule'],
  ['pages/api/activity-workspace/[id]/reschedule.ts', 'activity-workspace-reschedule'],
  ['pages/api/activity-workspace/[id]/unschedule.ts', 'activity-workspace-unschedule'],
  ['pages/api/campaigns/[id]/repurpose-and-schedule.ts', 'campaigns-repurpose-and-schedule'],
  ['pages/api/campaigns/[id]/schedule-structured-plan.ts', 'campaigns-schedule-structured-plan'],
  // OWNER DECISION 2026-10-11 (Closure-007 F3): the Strategic Mix release seam
  // (456afd41) schedules through the same pipeline as Group A and adopted
  // replay protection by design; sanctioned here rather than stripped.
  ['pages/api/campaigns/[id]/release.ts', 'campaign-release'],
];

/**
 * Adoptions REVIEWED and sanctioned after OR-08 (PL-128, c6 2026-11-20). Each gets the same wiring proofs as Group A.
 * prospect-sources/discovery (PI, 5c0e441e4 2026-10-23): POST starts a credit-consuming provider search; the key is
 * what separates "my request was already accepted" from "a new search" (route comment). Caller scoping (OR-09) is the
 * middleware's own; the handler authorizes via requireCapability(PROSPECT_INGEST / PROSPECT_ENRICH_EXECUTE).
 */
const SANCTIONED_LATER: Array<[string, string]> = [
  ['pages/api/prospect-sources/discovery.ts', 'pi-prospect-discovery-create'],
];
const WIRED = [...AUTHORIZED, ...SANCTIONED_LATER];

/** Blocked by OR-08 (Group B dormant) and ED-01 (billing held pending telemetry). */
const MUST_NOT_ADOPT = [
  'pages/api/billing/checkout/create-order.ts',
  'pages/api/billing/checkout/verify.ts',
  'pages/api/billing/profile.ts',
  'pages/api/billing/context.ts',
  'pages/api/credits/earn/feedback.ts',
  'pages/api/credits/earn/referral.ts',
  'pages/api/credits/earn/setup-progress.ts',
  'pages/api/publishing/reconcile/run.ts',
  'pages/api/publishing/worker/run.ts',
  'pages/api/social/post.ts',
  'pages/api/social/comments.ts',
];

describe('adoption gate — authorized endpoints', () => {
  it.each(AUTHORIZED)('%s adopts withIdempotency', (rel) => {
    expect({ file: rel, adopted: read(rel).includes('withIdempotency(handler') })
      .toEqual({ file: rel, adopted: true });
  });

  it.each(AUTHORIZED)('%s uses its own replay namespace', (rel, scope) => {
    expect(read(rel)).toContain(`scope: '${scope}'`);
  });

  it.each(SANCTIONED_LATER)('%s (reviewed later adoption) adopts with its own scope', (rel, scope) => {
    expect(adopts(rel)).toBe(true);
    expect(read(rel)).toContain(`scope: '${scope}'`);
  });

  it('every scope is distinct — no endpoint can replay another', () => {
    const scopes = WIRED.map(([, s]) => s);
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it('the authorized list is exactly the seven Group A endpoints plus the release seam', () => {
    expect(AUTHORIZED).toHaveLength(8);
    AUTHORIZED.forEach(([rel]) => expect(exists(rel)).toBe(true));
  });
});

describe('adoption gate — unauthorized endpoints must NOT adopt', () => {
  it.each(MUST_NOT_ADOPT)('%s remains unadopted', (rel) => {
    if (!exists(rel)) return; // route removed by a lifecycle decision
    // SUBSTRING on purpose (89/c6): for a must-NOT list a false hit (a comment) fails RED - the safe direction.
    expect({ file: rel, adopted: read(rel).includes('withIdempotency') })
      .toEqual({ file: rel, adopted: false });
  });
});

describe('adoption detector (PL-128)', () => {
  const IMP = "import { withIdempotency } from '../../backend/middleware/withIdempotency';\n";
  it('a real adoption (call in code) is detected - with the shared import or a local one', () => {
    expect(adoptsSource(`${IMP}export default __createApiRoute(withIdempotency(handler, { scope: 'x' }), {});`)).toBe(true);
    expect(adoptsSource('const withIdempotency = (h: any) => h;\nexport default withIdempotency(handler);')).toBe(true);
  });
  it('a COMMENT naming the middleware is not an adoption (block and line comments)', () => {
    expect(adoptsSource('/**\n * Not wrapped in `withIdempotency(`: the ledger IS the mechanism.\n */\nexport default h;')).toBe(false);
    expect(adoptsSource(`${IMP}// withIdempotency(handler) deliberately not used\nexport default h;`)).toBe(false);
  });
  it('an import with no call is not an adoption', () => {
    expect(adoptsSource(`${IMP}export default h;`)).toBe(false);
  });
  it('the real tree: the three comment-only routes are not adopters; discovery is', () => {
    expect(adopts('pages/api/prospect-identity/erasure-requests/index.ts')).toBe(false);
    expect(adopts('pages/api/prospects/[id]/problems.ts')).toBe(false);
    expect(adopts('pages/api/admin/credits/idempotency/list.ts')).toBe(false);
    expect(adopts('pages/api/prospect-sources/discovery.ts')).toBe(true);
  });
});

describe('adoption gate — no adoption outside the sanctioned set', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const child = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(child, out);
      else if (e.name.endsWith('.ts')) out.push(child);
    }
    return out;
  };

  it('only Group A, the reviewed later adoptions and the 29 pre-existing adopters use the middleware', () => {
    const adopters = walk('pages/api').filter(adopts);
    const groupA = new Set(WIRED.map(([rel]) => rel));
    const unexpected = adopters.filter(
      (rel) => !groupA.has(rel) && !/^pages\/api\/(admin|super-admin|team|company|credits\/claim-action)/.test(rel),
    );
    // Anything else adopting is an unauthorized expansion of scope.
    expect(unexpected).toEqual([]);
  });

  it('the pre-existing adopter count has not shrunk', () => {
    const all = walk('pages/api').filter(adopts);
    // 29 pre-existing + 7 Group A + 1 reviewed later adoption (discovery) = 37 REAL adopters (comment hits excluded).
    expect(all.length).toBeGreaterThanOrEqual(37);
  });
});

describe('wiring — the middleware can actually take effect', () => {
  it.each(WIRED)('%s nests withIdempotency INSIDE the route factory', (rel) => {
    // __createApiRoute(withIdempotency(handler, …), …) — reversing this would
    // put the replay cache outside request-context seeding.
    expect(read(rel)).toMatch(/__createApiRoute\(\s*withIdempotency\(handler,/);
  });

  it.each(WIRED)('%s still performs its own authorization inside the handler', (rel) => {
    // Caller scoping makes replay same-caller-only; the handler must still be
    // the thing that decides tenant/role access on a cache MISS.
    const src = read(rel);
    const authorizes =
      /getSupabaseUserFromRequest|enforceCompanyAccess|enforceRole|requireCampaignAccess|resolveAuthenticatedUser|requireCapability\(/.test(src);
    expect({ file: rel, authorizes }).toEqual({ file: rel, authorizes: true });
  });

  it.each(WIRED)('%s responds only via res.json, so replay can capture it', (rel) => {
    // withIdempotency patches res.json only. An endpoint using send/end/redirect
    // would leave its record stuck in `processing` until the stale lock expires.
    const src = read(rel);
    expect({ file: rel, unsupported: /res\.send\(|res\.end\(|res\.redirect\(/.test(src) })
      .toEqual({ file: rel, unsupported: false });
  });

  it.each(WIRED)('%s imports the shared middleware — no local reimplementation', (rel) => {
    expect(read(rel)).toMatch(/import \{ withIdempotency \} from '[^']*backend\/middleware\/withIdempotency'/);
  });
});
