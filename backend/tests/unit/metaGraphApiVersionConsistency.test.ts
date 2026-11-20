/**
 * Meta Graph API version — one version across the whole repo, no silent drift.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Graph version is a bare string repeated in ~25 source files (adapters,
 * connectors, OAuth callbacks, analytics, engagement ingestion, reconciliation,
 * the platform registry). Nothing held them together, and they drifted: the
 * Facebook and Instagram reconciliation providers were still on v18.0 while
 * every other caller had moved to v22.0 — so reconciliation read a post back on
 * a different API version from the one that published it, and nothing failed
 * until a real provider call was made.
 *
 * That is the exact shape of the 2026-09-16 LinkedIn version outage, which is
 * now guarded by linkedinApiVersionFreshness.test.ts. This is the Graph
 * equivalent: a repo-local, network-free check that a version bump can never be
 * applied to only some of the call sites.
 *
 * This test deliberately does NOT assert a particular version number. Picking
 * "the current Graph version" needs evidence from Meta, not from this repo; what
 * the repo can prove is that its callers agree with each other.
 */

export {};

import { collectOccurrences } from '../helpers/metaGraphVersionScan';

describe('Meta Graph API version pin', () => {
  const occurrences = collectOccurrences();

  it('the scan actually finds the Graph callers (guards against a broken scanner)', () => {
    expect(occurrences.length).toBeGreaterThan(20);
  });

  it('CRITICAL: every Graph caller in the repo sends the SAME version', () => {
    const byVersion = new Map<string, Set<string>>();
    for (const { file, version } of occurrences) {
      if (!byVersion.has(version)) byVersion.set(version, new Set());
      byVersion.get(version)!.add(file);
    }

    // Reported as { version: [files] } so a failure names exactly what drifted.
    const summary = Object.fromEntries(
      [...byVersion.entries()].map(([v, files]) => [v, [...files].sort()]),
    );

    expect(summary).toEqual({
      [[...byVersion.keys()].sort()[0]]: expect.any(Array),
    });
  });

  it('the two reconciliation providers are on that same version', () => {
    // These are the two that drifted. Named explicitly so the regression is
    // caught even if the repo-wide assertion is ever relaxed.
    const pinned = occurrences.filter((o) => o.file.includes('providerReconciliation/providers/'));
    const adapter = occurrences.filter((o) => o.file === 'backend/adapters/instagramAdapter.ts');

    expect(pinned.length).toBeGreaterThanOrEqual(2);
    expect(adapter.length).toBeGreaterThan(0);
    for (const o of pinned) {
      expect(o.version).toBe(adapter[0].version);
    }
  });

  it('every pin is a well-formed vMAJOR.MINOR', () => {
    for (const { file, version } of occurrences) {
      expect(`${file}:${version}`).toMatch(/:v\d+\.\d+$/);
    }
  });
});
