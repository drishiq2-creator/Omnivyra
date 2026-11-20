/**
 * Meta Graph API version FRESHNESS (PL-60, a9 2026-11-20; 7c via a9 on the meta-graph-version re-land).
 *
 * metaGraphApiVersionConsistency.test.ts proves every Graph caller sends the SAME version. It cannot see that
 * version being RETIRED by Meta: the only record of v22.0's end of life was a code comment
 * (instagramAdapter.ts, "valid until 2027-05-20"). Precedent: the 2026-09-16 LinkedIn outage, where a pinned
 * version left its support window and nothing failed until a real post was attempted
 * (linkedinApiVersionFreshness.test.ts is that guard).
 *
 * This test fails RUNWAY_DAYS before the fleet's version is retired, so the bump happens with runway instead of
 * during an outage. Network-free: the dates are copied from Meta's changelog below, with the date read.
 *
 * SOURCE: https://developers.facebook.com/docs/graph-api/changelog/ - "Available Until", read 2026-11-20.
 * To update: bump every caller (the consistency test enforces it), and add the new version's row here from that
 * page. A version Meta lists as "TBD" is recorded as null (no announced end); one missing from the table FAILS,
 * so a bump cannot skip this file.
 */
import { collectOccurrences } from '../helpers/metaGraphVersionScan';

/** Meta's published "Available Until" per version (UTC dates). null = Meta lists "TBD" (no announced end yet). */
const GRAPH_AVAILABLE_UNTIL: Readonly<Record<string, string | null>> = Object.freeze({
  'v21.0': '2027-01-21',
  'v22.0': '2027-05-20',
  'v23.0': '2027-10-08',
  'v24.0': '2028-02-18',
  'v25.0': '2028-07-29',
  'v26.0': null,
  'v27.0': null,
});

/** Fail this many days before retirement: about two months, matching the LinkedIn guard's runway. */
const RUNWAY_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The verdict for one version at an INJECTED instant (`now`), so the rule itself is tested with fixed dates and
 * only the fleet check reads the real clock.
 */
function freshness(version: string, now: Date):
  | { ok: true; daysLeft: number | null }
  | { ok: false; reason: 'unknown_version' | 'retired' | 'inside_runway'; daysLeft?: number } {
  if (!Object.prototype.hasOwnProperty.call(GRAPH_AVAILABLE_UNTIL, version)) return { ok: false, reason: 'unknown_version' };
  const until = GRAPH_AVAILABLE_UNTIL[version];
  if (until === null) return { ok: true, daysLeft: null };
  const daysLeft = Math.floor((Date.parse(`${until}T00:00:00Z`) - now.getTime()) / DAY_MS);
  if (daysLeft <= 0) return { ok: false, reason: 'retired', daysLeft };
  if (daysLeft < RUNWAY_DAYS) return { ok: false, reason: 'inside_runway', daysLeft };
  return { ok: true, daysLeft };
}

describe('Meta Graph API version freshness', () => {
  const occurrences = collectOccurrences();
  const fleet = [...new Set(occurrences.map((o) => o.version))].sort();

  it('PREMISE: the scan finds the Graph callers, and they share ONE version (the consistency test, restated)', () => {
    expect(occurrences.length).toBeGreaterThan(20);
    expect(fleet).toHaveLength(1);
  });

  it(`the fleet's version is known to this table and has more than ${RUNWAY_DAYS} days before Meta retires it`, () => {
    // Real clock, on purpose: this is the early warning. Fix: bump every caller to a version with runway, from
    // https://developers.facebook.com/docs/graph-api/changelog/ , and add its row above.
    expect(fleet.map((v) => ({ version: v, ...freshness(v, new Date()) }))).toEqual(
      fleet.map((v) => expect.objectContaining({ version: v, ok: true })),
    );
  });

  it('every table date is a real calendar date (a typo cannot silently mean "never retires")', () => {
    for (const [v, until] of Object.entries(GRAPH_AVAILABLE_UNTIL)) {
      expect(v).toMatch(/^v\d+\.0$/);
      if (until === null) continue;
      expect(until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${until}T00:00:00Z`).toISOString().slice(0, 10)).toBe(until);
    }
  });

  // ── The rule, at fixed instants (controls: each would pass under a rule that always says ok) ──
  it.each([
    ['well before retirement', 'v22.0', '2026-11-20T00:00:00Z', { ok: true, daysLeft: 181 }],
    ['exactly RUNWAY_DAYS before', 'v22.0', '2027-03-21T00:00:00Z', { ok: true, daysLeft: 60 }],
    ['one day inside the runway', 'v22.0', '2027-03-22T00:00:00Z', { ok: false, reason: 'inside_runway', daysLeft: 59 }],
    ['on the retirement date', 'v22.0', '2027-05-20T00:00:00Z', { ok: false, reason: 'retired', daysLeft: 0 }],
    ['after retirement (a past date)', 'v21.0', '2027-02-01T00:00:00Z', { ok: false, reason: 'retired', daysLeft: -11 }],
    ['a TBD version', 'v27.0', '2026-11-20T00:00:00Z', { ok: true, daysLeft: null }],
    ['a version missing from the table', 'v99.0', '2026-11-20T00:00:00Z', { ok: false, reason: 'unknown_version' }],
  ])('%s: %s at %s', (_name, version, at, expected) => {
    expect(freshness(version, new Date(at))).toEqual(expected);
  });
});
