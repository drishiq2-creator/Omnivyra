/**
 * c6 2026-11-19 (b3 / a9): the super-admin manual grant must send ONE Idempotency-Key per LOGICAL grant. The server
 * resolves a repeated key to the same grant; that protects nothing if the page mints a fresh key on every click - a
 * lost or failed response followed by a re-submit of the same form granted the credits twice.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createLogicalGrantKey } from '../../../lib/billing/logicalGrantKey';

const payload = { organizationId: 'org-1', creditsAmount: 100, category: 'manual', reason: 'comp' };
let n = 0;
const mint = () => `k${++n}`;
beforeEach(() => { n = 0; });

test('a re-submit of the SAME grant (no success recorded) reuses the key', () => {
  const g = createLogicalGrantKey(mint);
  expect(g.keyFor(payload)).toBe('k1');
  expect(g.keyFor({ ...payload })).toBe('k1');   // lost response -> the admin submits the same form again
});

test('a confirmed success ends the grant: the next submit is a NEW grant with a new key', () => {
  const g = createLogicalGrantKey(mint);
  g.keyFor(payload);
  g.settle();
  expect(g.keyFor(payload)).toBe('k2');
});

test('a changed payload is a different grant (new key) - never reuses a key for another amount/org', () => {
  const g = createLogicalGrantKey(mint);
  expect(g.keyFor(payload)).toBe('k1');
  expect(g.keyFor({ ...payload, creditsAmount: 200 })).toBe('k2');
});

describe('the page uses it (source pins)', () => {
  const s = fs.readFileSync(path.join(process.cwd(), 'pages/super-admin/free-credits.tsx'), 'utf8');
  test('the key comes from the logical-grant holder, not a per-click mint', () => {
    expect(s).toMatch(/const idempotencyKey = grantKey\.current\.keyFor\(payload\);/);
    expect(s).not.toMatch(/const idempotencyKey = typeof crypto/);
  });
  test('settle() only on a confirmed success; a thrown fetch keeps the key and says re-submitting is safe', () => {
    const ok = s.indexOf('if (r.ok) {');
    expect(ok).toBeGreaterThan(-1);
    expect(s.indexOf('grantKey.current.settle()')).toBeGreaterThan(ok);
    expect(s.match(/grantKey\.current\.settle\(\)/g)).toHaveLength(1);
    expect(s).toMatch(/\} catch \{[\s\S]{0,500}the grant may already have gone through/);
  });
  test('a 2xx carrying a warning (partial: credits granted, role step not done) KEEPS the key - settle() comes after it', () => {
    const warn = s.indexOf('if (r.ok && okBody?.warning) {');
    expect(warn).toBeGreaterThan(-1);
    const block = s.slice(warn, s.indexOf('if (r.ok) {', warn));
    expect(block).toMatch(/return;/);
    expect(block).not.toMatch(/settle\(\)/);
    expect(s.indexOf('grantKey.current.settle()')).toBeGreaterThan(warn);
  });
});

test("7c rule: the server's partial-success warnings describe STATE only - the retry instruction is the client's", () => {
  const api = fs.readFileSync(path.join(process.cwd(), 'pages/api/super-admin/free-credits/grant.ts'), 'utf8');
  const warnings = [...api.matchAll(/roleWarning = '([^']*)'/g)].map((m) => m[1]);
  expect(warnings.length).toBeGreaterThanOrEqual(2);          // non-vacuous: both partial-success warnings are found
  for (const w of warnings) expect([w, /retry|re-?send|resubmit|submit again/i.test(w)]).toEqual([w, false]);
});
