/**
 * S2-55 (7c, 2026-11-18): FROZEN allowlist of the explicitly named legacy `...Unscoped` store functions.
 *
 * campaignPlanStore (getLatestDraftPlan / saveDraftBlueprint / saveCampaignBlueprintFromRecommendation /
 * upsertCampaignResourceProjection) and contentAssetStore (listContentAssets / listAssetsWithLatestContent) REQUIRE
 * the authorized tenant / companyId. An `...Unscoped` variant runs the legacy campaign_id-only path: RECORDED DEBT,
 * through which a deleted campaign's orphaned rows (another company's) are reachable. Owner rule (no dormant code):
 * an unscoped variant exists only while a real caller uses it; the caller-less ones were removed (7c, 2026-11-19).
 *
 * This guard scans pages/, backend/ and lib/ (non-test sources) for CALL sites of every `...Unscoped` function and
 * pins them by name and count. A NEW caller fails (thread the tenant instead, or add a reviewed entry with its
 * reason); a REMOVED caller fails too (update the allowlist - the debt shrank).
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../../..');

/** Every legacy unscoped variant that still exists, with the file that defines it. */
const UNSCOPED_FUNCTIONS: Record<string, string> = {
  upsertCampaignResourceProjectionUnscoped: 'backend/db/campaignPlanStore.ts',
};
/** Removed under the no-dormant-code rule: must stay gone (re-adding one needs a caller and an allowlist entry). */
const REMOVED_UNSCOPED: Record<string, string> = {
  getLatestDraftPlanUnscoped: 'backend/db/campaignPlanStore.ts',
  saveDraftBlueprintUnscoped: 'backend/db/campaignPlanStore.ts',
  saveCampaignBlueprintFromRecommendationUnscoped: 'backend/db/campaignPlanStore.ts',
  listContentAssetsUnscoped: 'backend/db/contentAssetStore.ts',
  listAssetsWithLatestContentUnscoped: 'backend/db/contentAssetStore.ts',
};

type Entry = { fn: string; calls: number; reason: string };

/** THE allowlist: file -> the unscoped functions it calls, how many call sites, and why it cannot be scoped yet. */
const ALLOWLIST: Record<string, Entry[]> = {
  'backend/db/campaignPlanStore.ts': [
    {
      fn: 'upsertCampaignResourceProjectionUnscoped',
      calls: 3,
      reason: 'saveStructuredCampaignPlan / commitDraftBlueprint / updateToEditedCommitted are themselves unscoped (no tenant parameter); scoping them is a separate change',
    },
  ],
};

// The scan looks for the removed names too, so a re-introduced caller (or definition + caller) is caught.
const NAMES = [...Object.keys(UNSCOPED_FUNCTIONS), ...Object.keys(REMOVED_UNSCOPED)];
const CALL_RE = new RegExp(`\\b(${NAMES.join('|')})\\s*\\(`, 'g');

/** Non-test sources under pages/, backend/, lib/. */
export function isScannedFile(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  if (!/^(pages|backend|lib)\//.test(p)) return false;
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p)) return false;
  if (/(^|\/)(tests?|__tests__|__mocks__)\//.test(p)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return false;
  return true;
}

function stripComments(src: string): string {
  // Block comments keep their newlines (line numbers stay right); then line comments.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** CALL sites of the unscoped functions in one source (definitions, imports and comments are not calls). */
export function unscopedCallSites(src: string): Array<{ fn: string; line: number }> {
  const out: Array<{ fn: string; line: number }> = [];
  stripComments(src).split('\n').forEach((l, i) => {
    for (const m of l.matchAll(CALL_RE)) {
      const before = l.slice(0, m.index);
      if (/\bfunction\s*\*?\s*$/.test(before)) continue; // the definition itself
      out.push({ fn: m[1], line: i + 1 });
    }
  });
  return out;
}

type Found = Record<string, Record<string, number>>;

function tally(found: Found): string[] {
  const rows: string[] = [];
  for (const file of Object.keys(found).sort()) {
    for (const fn of Object.keys(found[file]).sort()) rows.push(`${file} :: ${fn} x${found[file][fn]}`);
  }
  return rows;
}

function allowRows(allow: Record<string, Entry[]>): string[] {
  const f: Found = {};
  for (const [file, entries] of Object.entries(allow)) for (const e of entries) (f[file] ??= {})[e.fn] = e.calls;
  return tally(f);
}

/** {unexpected: found but not allowlisted (a NEW caller), missing: allowlisted but not found (a REMOVED caller)}. */
export function diffAgainstAllowlist(found: Found, allow: Record<string, Entry[]>) {
  const have = tally(found);
  const want = allowRows(allow);
  return { unexpected: have.filter((r) => !want.includes(r)), missing: want.filter((r) => !have.includes(r)) };
}

function scanRepo(): { found: Found; scannedFiles: number } {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'pages', 'backend', 'lib'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isScannedFile);
  const found: Found = {};
  let scannedFiles = 0;
  for (const rel of [...new Set(files)]) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue; // deleted in the worktree but still in the index
    scannedFiles++;
    for (const site of unscopedCallSites(fs.readFileSync(abs, 'utf8'))) {
      const byFn = (found[rel] ??= {});
      byFn[site.fn] = (byFn[site.fn] ?? 0) + 1;
    }
  }
  return { found, scannedFiles };
}

describe('unscoped store callers are a frozen, reviewed allowlist (S2-55 7c)', () => {
  const { found, scannedFiles } = scanRepo();

  it('POSITIVE CONTROL: every listed unscoped function is defined where the list says, and the scan saw the tree', () => {
    for (const [fn, file] of Object.entries(UNSCOPED_FUNCTIONS)) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect({ fn, defined: new RegExp(`\\bfunction\\s+${fn}\\s*\\(`).test(src) }).toEqual({ fn, defined: true });
    }
    expect(scannedFiles).toBeGreaterThan(500);
  });

  it('the removed caller-less variants stay removed (no definition anywhere it was)', () => {
    for (const [fn, file] of Object.entries(REMOVED_UNSCOPED)) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect({ fn, defined: new RegExp(`\\bfunction\\s+${fn}\\s*\\(`).test(src) }).toEqual({ fn, defined: false });
    }
  });

  it('every allowlist entry carries a one-line reason and names a known unscoped function', () => {
    for (const [file, entries] of Object.entries(ALLOWLIST)) {
      for (const e of entries) {
        expect({ file, fn: e.fn, known: e.fn in UNSCOPED_FUNCTIONS }).toEqual({ file, fn: e.fn, known: true });
        expect(e.reason.trim().length).toBeGreaterThan(20);
        expect(e.reason).not.toMatch(/\n/);
        expect(e.calls).toBeGreaterThan(0);
      }
    }
  });

  it('the call sites found equal the allowlist exactly (a new caller fails; a removed caller fails - update the allowlist)', () => {
    const diff = diffAgainstAllowlist(found, ALLOWLIST);
    expect(diff).toEqual({ unexpected: [], missing: [] });
    expect(tally(found)).toEqual(allowRows(ALLOWLIST));
  });

  it('the cross-tenant allow-list entry for the legacy projection exists IFF its premise still holds (checkable exit, 7c)', () => {
    // Premise of crossTenantAllowList 'campaign-plan-store-legacy-unscoped-projection': the Unscoped projection
    // variant still HAS callers (the three tenant-less writers). When a tenant is threaded through them and the
    // callers go, this fails until the entry, the null branch and its marker are deleted - an exemption that cannot
    // outlive its reason.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CROSS_TENANT_IDS } = require('../../db/crossTenantAllowList');
    const projectionCalls = Object.values(found).reduce((n, byFn) => n + (byFn.upsertCampaignResourceProjectionUnscoped ?? 0), 0);
    const store = fs.readFileSync(path.join(ROOT, 'backend/db/campaignPlanStore.ts'), 'utf8');
    const state = {
      entry: CROSS_TENANT_IDS.has('campaign-plan-store-legacy-unscoped-projection'),
      marker: store.includes('cross-tenant: campaign-plan-store-legacy-unscoped-projection'),
      callers: projectionCalls > 0,
    };
    expect([state.entry === state.callers, state.marker === state.callers, state]).toEqual([true, true, state]);
  });

  it('found call count == allowlist call count, and > 0', () => {
    const foundCount = Object.values(found).reduce((n, byFn) => n + Object.values(byFn).reduce((a, b) => a + b, 0), 0);
    const allowCount = Object.values(ALLOWLIST).reduce((n, es) => n + es.reduce((a, e) => a + e.calls, 0), 0);
    expect(foundCount).toBe(allowCount);
    expect(foundCount).toBeGreaterThan(0);
  });
});

describe('scanner fixture controls', () => {
  it('a definition line is not counted; a call is', () => {
    expect(unscopedCallSites('export async function getLatestDraftPlanUnscoped(campaignId: string) {')).toEqual([]);
    expect(unscopedCallSites('async function upsertCampaignResourceProjectionUnscoped(id: string, b: any): Promise<void> {')).toEqual([]);
    expect(unscopedCallSites('  const d = await getLatestDraftPlanUnscoped(campaignId);')).toEqual([{ fn: 'getLatestDraftPlanUnscoped', line: 1 }]);
    expect(unscopedCallSites('x\n  await store.listContentAssetsUnscoped ({ campaignId });')).toEqual([{ fn: 'listContentAssetsUnscoped', line: 2 }]);
  });
  it('imports and comments are not calls', () => {
    expect(unscopedCallSites("import { listContentAssetsUnscoped } from '../db/contentAssetStore';")).toEqual([]);
    expect(unscopedCallSites('// later: saveDraftBlueprintUnscoped(x)\n/* listAssetsWithLatestContentUnscoped(y) */')).toEqual([]);
  });
  it('a call in a test file is not counted (the file is not scanned)', () => {
    expect(isScannedFile('backend/tests/unit/x.test.ts')).toBe(false);
    expect(isScannedFile('backend/services/foo.spec.ts')).toBe(false);
    expect(isScannedFile('lib/__tests__/foo.ts')).toBe(false);
    expect(isScannedFile('backend/services/campaignExecutionCheckpointService.ts')).toBe(true);
    expect(isScannedFile('pages/api/campaigns/forecast.ts')).toBe(true);
  });
  it('a new caller fails and a removed caller fails', () => {
    const allow = { 'a.ts': [{ fn: 'saveDraftBlueprintUnscoped', calls: 1, reason: 'fixture reason long enough' }] };
    expect(diffAgainstAllowlist({ 'a.ts': { saveDraftBlueprintUnscoped: 1 } }, allow)).toEqual({ unexpected: [], missing: [] });
    expect(diffAgainstAllowlist({ 'a.ts': { saveDraftBlueprintUnscoped: 1 }, 'b.ts': { listContentAssetsUnscoped: 1 } }, allow).unexpected)
      .toEqual(['b.ts :: listContentAssetsUnscoped x1']);
    expect(diffAgainstAllowlist({ 'a.ts': { saveDraftBlueprintUnscoped: 2 } }, allow).unexpected).toEqual(['a.ts :: saveDraftBlueprintUnscoped x2']);
    expect(diffAgainstAllowlist({}, allow).missing).toEqual(['a.ts :: saveDraftBlueprintUnscoped x1']);
  });
});
