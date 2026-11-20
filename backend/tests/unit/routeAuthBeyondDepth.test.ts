/**
 * orderingPatterns `effectsBeyondDepth` (b3 ruling 2026-11-20, 7c F2): an effect a route REALLY reaches past the
 * analyzer's summary depth cut stays on the reviewed record, verified on every run at EXACTLY its stated depth.
 * Controls, on the real route that needs it (pages/api/social/comments.ts) and the real allowlist:
 *   - the reviewed record is pinned: deleting a beyond-depth entry (or moving it to `effects`) fails;
 *   - an UNDERSTATED depth fails (not reached there); an OVERSTATED depth fails (already reached one less);
 *   - an entry for an effect the route does not reach at all fails; one within SUMMARY_DEPTH must be in `effects`;
 *   - shape errors (depth not beyond the cut, missing reason, duplicated in `effects`) fail.
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
import fs from 'fs';
import path from 'path';

const ROUTE = 'pages/api/social/comments.ts';
const gate = require('../../../scripts/check-route-auth.js');
const { SUMMARY_DEPTH } = require('../../../scripts/route-auth-ordering-policy.js');
const raw = fs.readFileSync(path.join(process.cwd(), ROUTE), 'utf8');
const allowlist = gate.loadAllowlist();
const methodExemptions = gate.loadMethodExemptions();
const sections = gate.loadOrderingSections();

type Beyond = { effect: string; depth: number; reason: string };
const reviewed = (): any => JSON.parse(JSON.stringify(sections.orderingPatterns[ROUTE][0]));

function run(mutate: (p: any) => void): { allowlistErrors: string[]; stale: string[] } {
  const p = reviewed();
  mutate(p);
  const ordering = { ...sections, orderingPatterns: { ...sections.orderingPatterns, [ROUTE]: [p] } };
  const row = gate.analyzeRoute(ROUTE, raw, allowlist, methodExemptions, { ordering });
  return {
    allowlistErrors: row.violations.filter((v: any) => v.rule === 'ALLOWLIST' || v.rule === 'R6-ORDER').map((v: any) => `${v.rule} ${v.msg}`),
    stale: (row.ordering && row.ordering.unusedPatternEffects) || [],
  };
}

const AUTO = 'db-write .insert() backend/services/communityAiAutoRuleService.ts';
const LOG = 'db-write .insert() backend/services/communityAiActionLogService.ts';
const FETCH = 'external-call fetch() backend/services/omnivyraClientV1.ts';

describe('orderingPatterns effectsBeyondDepth', () => {
  it('the reviewed record: comments.ts declares exactly these three beyond-depth effects at these depths (deleting one fails here)', () => {
    const p = reviewed();
    expect(SUMMARY_DEPTH).toBe(3);
    expect((p.effectsBeyondDepth as Beyond[]).map((b) => [b.effect, b.depth]).sort()).toEqual([
      [AUTO, 4], [LOG, 5], [FETCH, 5],
    ].sort());
    for (const b of p.effectsBeyondDepth as Beyond[]) expect(p.effects).not.toContain(b.effect);
  });

  it('control: the reviewed entry passes with nothing stale', () => {
    expect(run(() => {})).toEqual({ allowlistErrors: [], stale: [] });
  });

  it('an UNDERSTATED depth fails (the effect is not reached there)', () => {
    const r = run((p) => { p.effectsBeyondDepth.find((b: Beyond) => b.effect === FETCH).depth = 4; });
    expect(r.allowlistErrors.join('\n')).toMatch(/effectsBeyondDepth external-call fetch\(\) backend\/services\/omnivyraClientV1\.ts: not reached at the stated depth 4/);
  });

  it('an OVERSTATED depth fails (already reached one level less)', () => {
    const r = run((p) => { p.effectsBeyondDepth.find((b: Beyond) => b.effect === AUTO).depth = 5; });
    expect(r.allowlistErrors.join('\n')).toMatch(/communityAiAutoRuleService\.ts: already reached at depth 4 \(the stated depth 5 is overstated\)/);
  });

  it('an effect the route never reaches fails; an effect within SUMMARY_DEPTH must be listed under effects', () => {
    const r1 = run((p) => { p.effectsBeyondDepth.push({ effect: 'db-write .insert() backend/services/notReachedAnywhere.ts', depth: 5, reason: 'fixture: an effect the route does not reach at any depth' }); });
    expect(r1.allowlistErrors.join('\n')).toMatch(/notReachedAnywhere\.ts: not reached at the stated depth 5/);
    const within = 'db-write .insert() backend/services/engagementEvaluationService.ts';
    const r2 = run((p) => {
      p.effects = p.effects.filter((e: string) => e !== within);
      p.effectsBeyondDepth.push({ effect: within, depth: 4, reason: 'fixture: an effect already reached within the summary depth cut' });
    });
    expect(r2.allowlistErrors.join('\n')).toMatch(/engagementEvaluationService\.ts: reached within SUMMARY_DEPTH \(3\) - list it under effects/);
  });

  it('moving a beyond-depth effect back into effects makes it stale again (the WARN this key exists to retire)', () => {
    const r = run((p) => {
      p.effectsBeyondDepth = p.effectsBeyondDepth.filter((b: Beyond) => b.effect !== LOG);
      p.effects.push(LOG);
    });
    expect(r.stale).toEqual([LOG]);
  });

  it('shape: depth must be beyond the cut, a reason is required, and an effect may not be in both lists', () => {
    const r = run((p) => {
      p.effectsBeyondDepth[0].depth = SUMMARY_DEPTH;
      p.effectsBeyondDepth[1].reason = 'short';
      p.effects.push(p.effectsBeyondDepth[2].effect);
    });
    const all = r.allowlistErrors.join('\n');
    expect(all).toMatch(/depth must be an integer in 4\.\.8/);
    expect(all).toMatch(/reason missing or too short/);
    expect(all).toMatch(/listed in effects too/);
  });
});
