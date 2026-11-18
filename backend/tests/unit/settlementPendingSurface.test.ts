/**
 * b3 ruling 2026-11-18: billed work whose settle is ambiguous answers 200 + settlementPending on EVERY
 * wirePhase2Route route, with a structural pin that no caller can drop it.
 *   - behaviour: the surface adds the field to a 2xx plain-object body; never overwrites a route's own; arrays /
 *     primitives get the X-Settlement-Pending header (shape unchanged); non-2xx untouched; outside a scope the
 *     report is counted + logged;
 *   - end to end through the REAL createApiRoute;
 *   - structure: every non-test file calling wirePhase2Route( is built by createApiRoute or opens the surface itself.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockCounters: string[] = [];
jest.mock('../../services/billing/billingMetrics', () => ({ incrCounter: (n: string) => { mockCounters.push(n); } }));
const mockError = jest.fn();
jest.mock('../../services/logger', () => ({ logger: { error: (...a: unknown[]) => mockError(...a), warn: jest.fn(), info: jest.fn() } }));

import { runWithSettlementSurface, reportSettlementPending, SETTLEMENT_PENDING_HEADER } from '../../services/billing/settlementPendingSurface';

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string>, headersSent: false };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  res.setHeader = (n: string, v: string) => { res.headers[n] = v; return res; };
  return res;
}
const PENDING = { code: 'CREDIT_SETTLE_AMBIGUOUS' };

beforeEach(() => { mockCounters.length = 0; mockError.mockClear(); });

describe('surface behaviour', () => {
  test('2xx plain-object body gains settlementPending', async () => {
    const res = fakeRes();
    await runWithSettlementSurface(res, async () => { await Promise.resolve(); reportSettlementPending(); res.status(200).json({ a: 1 }); });
    expect(res.body).toEqual({ a: 1, settlementPending: PENDING });
  });
  test('control: no report -> body unchanged', async () => {
    const res = fakeRes();
    await runWithSettlementSurface(res, async () => { res.status(200).json({ a: 1 }); });
    expect(res.body).toEqual({ a: 1 });
    expect(res.headers[SETTLEMENT_PENDING_HEADER]).toBeUndefined();
  });
  test("a route's own settlementPending is never overwritten", async () => {
    const res = fakeRes();
    const own = { code: 'CREDIT_SETTLE_AMBIGUOUS', extra: 1 };
    await runWithSettlementSurface(res, async () => { reportSettlementPending(); res.json({ settlementPending: own }); });
    expect(res.body.settlementPending).toBe(own);
  });
  test('an ARRAY body keeps its shape and carries the header instead', async () => {
    const res = fakeRes();
    await runWithSettlementSurface(res, async () => { reportSettlementPending(); res.status(201).json([1, 2]); });
    expect(res.body).toEqual([1, 2]);
    expect(res.headers[SETTLEMENT_PENDING_HEADER]).toBe('CREDIT_SETTLE_AMBIGUOUS');
  });
  test('a non-2xx response is untouched', async () => {
    const res = fakeRes();
    await runWithSettlementSurface(res, async () => { reportSettlementPending(); res.status(500).json({ error: 'x' }); });
    expect(res.body).toEqual({ error: 'x' });
  });
  test('outside any surface: counted + logged, returns false (never silent)', () => {
    expect(reportSettlementPending({ surface: 's' })).toBe(false);
    expect(mockCounters).toContain('settlement_pending_unsurfaced_total');
    expect(mockError).toHaveBeenCalledWith('settlement_pending_unsurfaced', { surface: 's' });
  });
  test('concurrent requests do not leak into each other', async () => {
    const a = fakeRes(); const b = fakeRes();
    await Promise.all([
      runWithSettlementSurface(a, async () => { await new Promise((r) => setTimeout(r, 5)); reportSettlementPending(); a.json({ n: 'a' }); }),
      runWithSettlementSurface(b, async () => { await new Promise((r) => setTimeout(r, 10)); b.json({ n: 'b' }); }),
    ]);
    expect(a.body).toEqual({ n: 'a', settlementPending: PENDING });
    expect(b.body).toEqual({ n: 'b' });
  });
});

describe('end to end through the real createApiRoute', () => {
  test('a handler whose billed work reports pending answers 200 + settlementPending', async () => {
    const { createApiRoute } = jest.requireActual('../../../lib/platform/routeFactory');
    const route = createApiRoute(async (_req: any, res: any) => {
      await new Promise((r) => setImmediate(r));
      reportSettlementPending();
      return res.status(200).json({ ok: true });
    }, { route: '/api/test/pending' });
    const res = fakeRes();
    res.end = () => res; res.getHeader = () => undefined; res.on = () => res; res.once = () => res;
    await route({ method: 'POST', url: '/api/test/pending', headers: {}, query: {}, body: {}, socket: {} } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, settlementPending: PENDING });
  });
});

describe('structural pin: no wirePhase2Route caller can drop settlementPending', () => {
  const ROOT = process.cwd();
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  function walk(dir: string, out: string[]) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'tests' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  }
  const files: string[] = [];
  for (const d of ['pages', 'backend', 'lib']) walk(path.join(ROOT, d), files);
  const callers = files
    .filter((f) => !f.endsWith(path.join('billing', 'phase2RouteWiring.ts')))
    .filter((f) => /\bwirePhase2Route\s*\(/.test(strip(fs.readFileSync(f, 'utf8'))));

  test('the caller set is non-empty (a scan over nothing passes vacuously)', () => {
    expect(callers.length).toBeGreaterThanOrEqual(21);
  });
  test('every caller is an API route that opens the surface (createApiRoute or runWithSettlementSurface)', () => {
    const bad = callers.filter((f) => {
      const s = strip(fs.readFileSync(f, 'utf8'));
      const isRoute = f.includes(`${path.sep}pages${path.sep}api${path.sep}`);
      return !isRoute || !(/export default\s+(__)?createApiRoute\s*\(/.test(s) || /runWithSettlementSurface\s*\(/.test(s));
    }).map((f) => path.relative(ROOT, f));
    expect(bad).toEqual([]);
  });
  test('wirePhase2Route reports to the surface on an ambiguous settle', () => {
    const s = fs.readFileSync(path.join(ROOT, 'backend/services/billing/phase2RouteWiring.ts'), 'utf8');
    const executed = s.slice(s.indexOf("case 'executed':"), s.indexOf("case 'already_settled':"));
    expect(executed).toMatch(/if \(result\.settlementPending\)[\s\S]*reportSettlementPending\(/);
  });
  test('the route factory runs every handler inside the surface', () => {
    const s = strip(fs.readFileSync(path.join(ROOT, 'lib/platform/routeFactory.ts'), 'utf8'));
    expect(s).toMatch(/runWithSettlementSurface\(res, \(\) => composed\(req, res\)\)/);
  });
});
