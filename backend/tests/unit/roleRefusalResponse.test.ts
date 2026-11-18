/**
 * c6 2026-11-18 (error-echo class; 89/a9/7c): every route answers a getUserRole refusal through respondRoleRefusal.
 *   - a FAILED role read (ROLE_LOOKUP_FAILED) is a retryable 503 - never a final 403;
 *   - the one known denial code keeps its existing 403 contract;
 *   - anything else is the generic 403 FORBIDDEN_ROLE - getUserRole's error is never echoed.
 * Static guard: no route under pages/ or backend/ answers `error: roleError ?? ...` any more.
 */
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => { throw new Error('no db'); } } }));
import * as fs from 'fs';
import * as path from 'path';
import { respondRoleRefusal, ROLE_LOOKUP_FAILED } from '../../services/rbacService';

function res() {
  const r: any = { statusCode: 0, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

describe('respondRoleRefusal', () => {
  test('ROLE_LOOKUP_FAILED -> 503 retryable (unknown, not denied)', () => {
    const r = res(); respondRoleRefusal(r, ROLE_LOOKUP_FAILED);
    expect([r.statusCode, r.body]).toEqual([503, { error: 'ROLE_LOOKUP_FAILED', retryable: true }]);
  });
  test('COMPANY_ACCESS_DENIED keeps its 403 contract', () => {
    const r = res(); respondRoleRefusal(r, 'COMPANY_ACCESS_DENIED');
    expect([r.statusCode, r.body]).toEqual([403, { error: 'COMPANY_ACCESS_DENIED' }]);
  });
  test.each([[null], [undefined], ['some unexpected internal text']])('%p -> generic 403 FORBIDDEN_ROLE (never echoed)', (e) => {
    const r = res(); respondRoleRefusal(r, e as any);
    expect([r.statusCode, r.body]).toEqual([403, { error: 'FORBIDDEN_ROLE' }]);
  });
});

describe('no route echoes getUserRole\'s error (static)', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.next', 'tests'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(process.cwd(), 'pages'));
  walk(path.join(process.cwd(), 'backend'));
  const src = (f: string) => fs.readFileSync(f, 'utf8');

  test('positive control: the scan reaches the routes that refuse through the helper', () => {
    const users = files.filter((f) => /respondRoleRefusal\(res, roleError\)/.test(src(f)));
    expect(users.length).toBeGreaterThanOrEqual(50);
  });

  test('no `error: roleError ??` / `error: roleError }` response remains', () => {
    const echo = files.filter((f) => /json\(\{\s*error:\s*roleError\s*(\?\?|\})/.test(src(f)))
      .map((f) => path.relative(process.cwd(), f));
    expect(echo).toEqual([]);
  });
});
