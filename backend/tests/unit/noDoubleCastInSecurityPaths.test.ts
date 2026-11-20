/**
 * No double cast in security paths (b3 2026-11-20). `supabase.auth.admin as unknown as { signOut: (uid, …) }` hid a
 * call that could NEVER work - auth.admin.signOut takes the user's JWT, it was given a user id - behind a
 * "best-effort" log, so force-logout never revoked refresh tokens. A double cast re-types a value the compiler would
 * otherwise check; on an auth / security path it can hide a wrong argument exactly like that.
 * Keyed on the SHAPE (`as unknown as`) over backend/security, backend/services/lifecycleGovernance.ts,
 * pages/api/auth and pages/api/super-admin (non-test). Zero allowance.
 */
export {};
/* eslint-disable @typescript-eslint/no-var-requires */
import fs from 'fs';
import path from 'path';

const ROOTS = ['backend/security', 'backend/services/lifecycleGovernance.ts', 'pages/api/auth', 'pages/api/super-admin'];

function offenders(files: Array<{ rel: string; src: string }>): string[] {
  const out: string[] = [];
  for (const { rel, src } of files) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
    const re = /\bas\s+unknown\s+as\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) out.push(`${rel}:${code.slice(0, m.index).split('\n').length}`);
  }
  return out;
}

describe('no double cast on security paths', () => {
  it('no `as unknown as` in the security / auth / super-admin paths', () => {
    const { execFileSync } = require('child_process');
    const rels: string[] = execFileSync('git', ['ls-files', ...ROOTS], { encoding: 'utf8' })
      .split('\n').filter((p: string) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !/(^|\/)tests?\//.test(p));
    expect(rels.length).toBeGreaterThan(50);
    const files = rels.map((rel) => ({ rel, src: fs.readFileSync(path.join(process.cwd(), rel), 'utf8') }));
    expect(offenders(files)).toEqual([]);
  });

  it('control: the removed shape is caught; a single typed cast and a comment are not', () => {
    expect(offenders([{ rel: 'x.ts', src: "await (supabase.auth.admin as unknown as { signOut: (u: string) => P }).signOut(uid, 'global');" }])).toEqual(['x.ts:1']);
    expect(offenders([{ rel: 'x.ts', src: 'const row = data as UserRow;' }])).toEqual([]);
    expect(offenders([{ rel: 'x.ts', src: '// was: as unknown as { signOut }' }])).toEqual([]);
  });
});
