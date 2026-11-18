/**
 * 83 2026-11-13: the billing counter registry is a CLOSED set at compile time. Under `Record<string, number>`
 * BillingCounter resolved to `string`, so two unregistered route-wiring counters compiled through three CI runs.
 * The @ts-expect-error lines are the NEGATIVE control: if BillingCounter widens back to `string`, they become unused
 * directives and the backend-tests typecheck FAILS (TS2578). Never executed at runtime.
 */
import { incrCounter, getCounter, snapshotBillingMetrics, type BillingCounter } from '../../services/billing/billingMetrics';

function neverCalled(): void {
  // @ts-expect-error - an unregistered counter name must not compile
  incrCounter('not_a_registered_counter_total');
  // @ts-expect-error - an unregistered counter name must not compile
  getCounter('not_a_registered_counter_total');
}
void neverCalled;

it('registered names compile and are exported in the snapshot', () => {
  const names: BillingCounter[] = ['phase2_route_without_idempotency_key_total', 'phase2_route_reclaim_cap_exhausted_total'];
  for (const n of names) expect(snapshotBillingMetrics()).toHaveProperty(n);
});

// c6 2026-11-18: ts-jest is transpile-only, so an unregistered name passes every jest run and fails only cb's
// typecheck. Scan the literal incrCounter('...') call sites and require each to be a registry key.
test('every literal incrCounter(...) name in backend/ is a registered counter', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const names = new Set<string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'tests' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name)) for (const m of fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').matchAll(/\bincrCounter\(\s*'([a-z0-9_]+)'/g)) names.add(m[1]);
    }
  };
  walk(path.join(process.cwd(), 'backend'));
  expect(names.size).toBeGreaterThan(10);   // non-vacuous
  const registered = new Set(Object.keys(snapshotBillingMetrics() as Record<string, number>));
  expect([...names].filter((n) => !registered.has(n)).sort()).toEqual([]);
});
