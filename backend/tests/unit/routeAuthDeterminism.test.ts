/**
 * The route-auth gate must give the same findings whatever order it meets the routes in (CI-652, 2026-11-20).
 *
 * Two order dependencies made the same tree pass on one filesystem and fail on another (NTFS vs ext4 readdir
 * order), and made a reversed walk of main surface a different R6-ORDER finding:
 *  1. walk() used readdirSync's filesystem-defined order;
 *  2. the ordering analyzer's summarize() cached a service function's side-effect summary by function only,
 *     although the summary is cut at SUMMARY_DEPTH and by a shared visited set. Whichever route reached a
 *     function first fixed its summary for every later route: a truncated summary hid a reachable effect, a
 *     deeper one leaked effects past the next route's own depth budget.
 *
 * Each case runs in a fresh module registry (the analyzer's caches are process-global), once in each order,
 * and asserts identical findings.
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
import fs from 'fs';
import os from 'os';
import path from 'path';

type Violation = { rule: string; msg: string };
type Row = { violations: Violation[] };

const AUTH = "import { getSupabaseUserFromRequest } from '../../../backend/services/supabaseAuthService';";

// A four-deep service chain: chainA -> chainB -> chainC -> chainD, and only chainD writes.
// From a route, a call to chainA reaches chainD at summary depth 4 (past SUMMARY_DEPTH = 3: no effect);
// a call to chainB reaches it at depth 3 (the write is reachable).
const MODULES: Record<string, string> = {
  'backend/services/chainA.ts': "import { chainB } from './chainB';\nexport async function chainA(x) { return chainB(x); }\n",
  'backend/services/chainB.ts': "import { chainC } from './chainC';\nexport async function chainB(x) { return chainC(x); }\n",
  'backend/services/chainC.ts': "import { chainD } from './chainD';\nexport async function chainC(x) { return chainD(x); }\n",
  'backend/services/chainD.ts': "import { supabase } from '../db/supabaseClient';\nexport async function chainD(x) { await supabase.from('notes').insert({ x }); }\n",
};

const routeCalling = (fn: string) => `${AUTH}
import { ${fn} } from '../../../backend/services/${fn}';
export default async function handler(req, res) {
  await ${fn}(req.body.x);
  const { user } = await getSupabaseUserFromRequest(req);
  if (!user) return res.status(401).end();
  return res.status(200).end();
}`;

const ROUTES: Array<[string, string]> = [
  ['pages/api/fixture/deep.ts', routeCalling('chainA')],
  ['pages/api/fixture/shallow.ts', routeCalling('chainB')],
];

function findingsInOrder(order: Array<[string, string]>, modules: Record<string, string> = MODULES, ordering: Record<string, unknown> = {}): Record<string, string[]> {
  let out: Record<string, string[]> = {};
  jest.isolateModules(() => {
    const gate = require('../../../scripts/check-route-auth.js');
    const res: Record<string, string[]> = {};
    for (const [rel, src] of order) {
      const row: Row = gate.analyzeRoute(rel, src, {}, {}, { modules, ordering });
      res[rel] = row.violations.map((v) => `${v.rule} ${v.msg}`).sort();
    }
    out = res;
  });
  return out;
}

describe('route-auth gate: findings do not depend on the order routes are analysed', () => {
  it('a shared service summary is the same whichever route reaches it first', () => {
    const forward = findingsInOrder(ROUTES);
    const reversed = findingsInOrder([...ROUTES].reverse());
    expect(reversed).toEqual(forward);
  });

  it('the expected findings: the depth-3 chain write is reported, the depth-4 one is not (control: the fixture exercises the cut)', () => {
    const f = findingsInOrder(ROUTES);
    expect(f['pages/api/fixture/shallow.ts'].join('\n')).toMatch(/^R5-ORDER .*db-write \.insert\(\)/);
    expect(f['pages/api/fixture/deep.ts']).toEqual([]);
  });

  // 7c B1 (2026-11-20): a route's own orderingVerifiers (extraAuth) must not shape a SHARED summary. Route V names
  // verifyHook as its verifier; sharedSvc calls verifyHook, which writes. If V's summary of sharedSvc treated
  // verifyHook as auth (skipping its effects) and was cached, route N - which has no such verifier - lost the write.
  const HOOK_MODULES: Record<string, string> = {
    'backend/services/verifyHook.ts': "import { supabase } from '../db/supabaseClient';\nexport async function verifyHook(x) { await supabase.from('hook_log').insert({ x }); return true; }\n",
    'backend/services/sharedSvc.ts': "import { verifyHook } from './verifyHook';\nexport async function sharedSvc(x) { return verifyHook(x); }\n",
  };
  const HOOK_ROUTES: Array<[string, string]> = [
    ['pages/api/fixture/hooked.ts', `${AUTH}
import { sharedSvc } from '../../../backend/services/sharedSvc';
import { verifyHook } from '../../../backend/services/verifyHook';
export default async function handler(req, res) {
  await sharedSvc(req.body.x);
  if (!(await verifyHook(req))) return res.status(401).end();
  return res.status(200).end();
}`],
    ['pages/api/fixture/plain.ts', routeCalling('sharedSvc')],
  ];
  const HOOK_ORDERING = { orderingVerifiers: { 'pages/api/fixture/hooked.ts': [{ verifier: 'verifyHook', reason: 'fixture: the hooked route verifies with verifyHook before 401' }] } };

  it('a route\'s own verifier never truncates a shared summary another route uses (either order)', () => {
    const forward = findingsInOrder(HOOK_ROUTES, HOOK_MODULES, HOOK_ORDERING);
    const reversed = findingsInOrder([...HOOK_ROUTES].reverse(), HOOK_MODULES, HOOK_ORDERING);
    expect(reversed).toEqual(forward);
    // control: the route without that verifier sees the write through sharedSvc -> verifyHook
    expect(forward['pages/api/fixture/plain.ts'].join('\n')).toMatch(/db-write \.insert\(\)/);
  });

  it('walk() lists files in name order, whatever order the filesystem returns them in', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-auth-walk-'));
    try {
      for (const d of ['b', 'a', 'c']) fs.mkdirSync(path.join(dir, d));
      for (const f of ['b/z.ts', 'b/a.ts', 'a/m.ts', 'c/index.ts', 'top.ts', 'a/x.test.ts']) fs.writeFileSync(path.join(dir, f), '');
      const listings: string[][] = [];
      for (const reverse of [false, true]) {
        jest.isolateModules(() => {
          const realFs = jest.requireActual('fs');
          const original = realFs.readdirSync.bind(realFs);
          const spy = jest.spyOn(realFs, 'readdirSync').mockImplementation(((...a: unknown[]) => {
            const listed = original(...(a as [string])) as unknown as unknown[];
            return reverse ? [...listed].reverse() : listed;
          }) as never);
          try {
            const gate = require('../../../scripts/check-route-auth.js');
            const out: string[] = [];
            gate.walk(dir, out);
            listings.push(out.map((p) => path.relative(dir, p).split(path.sep).join('/')));
          } finally { spy.mockRestore(); }
        });
      }
      expect(listings[0]).toEqual(['a/m.ts', 'b/a.ts', 'b/z.ts', 'c/index.ts', 'top.ts']);
      expect(listings[1]).toEqual(listings[0]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
