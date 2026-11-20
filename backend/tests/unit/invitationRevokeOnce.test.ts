/**
 * invitations.revoked_at is set ONCE (7c 2026-11-20): an update that sets revoked_at must be conditioned on
 * `.is('revoked_at', null)`, so an already-revoked row keeps its original revocation time (audit history; and
 * forensic queries such as "email sent after revocation" depend on it). Keyed on the SHAPE across pages/backend/lib.
 * EXEMPT (stated): the accept / set-password paths revoke as part of CONSUMING a live invitation the caller just
 * used - a row that was already revoked cannot be consumed there.
 */
export {};
/* eslint-disable @typescript-eslint/no-var-requires */
import fs from 'fs';
import path from 'path';

const EXEMPT = new Set(['pages/api/auth/accept-invite.ts', 'pages/api/auth/set-password.ts']);

function offenders(files: Array<{ rel: string; src: string }>): string[] {
  const out: string[] = [];
  for (const { rel, src } of files) {
    if (EXEMPT.has(rel)) continue;
    const re = /\.from\(\s*'invitations'\s*\)|ownedDbTable\(\s*'invitations'\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const end = src.indexOf(';', m.index);
      const chain = src.slice(m.index, end < 0 ? undefined : end);
      if (/\.update\(\s*\{[^}]*\brevoked_at\s*:/.test(chain) && !/\.is\(\s*'revoked_at'\s*,\s*null\s*\)/.test(chain)) {
        out.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  return out;
}

describe('invitations.revoked_at is set once', () => {
  it('every update setting revoked_at is conditioned on revoked_at IS NULL (outside the consume paths)', () => {
    const { execFileSync } = require('child_process');
    const rels: string[] = execFileSync('git', ['ls-files', 'pages', 'backend', 'lib'], { encoding: 'utf8' })
      .split('\n').filter((p: string) => /\.(ts|tsx)$/.test(p) && !/(^|\/)tests?\//.test(p) && !/\.test\.tsx?$/.test(p));
    const files = rels.map((rel) => ({ rel, src: fs.readFileSync(path.join(process.cwd(), rel), 'utf8') }));
    const writers = files.filter((f) => /revoked_at\s*:/.test(f.src) && /'invitations'/.test(f.src)).map((f) => f.rel);
    expect(writers).toEqual(expect.arrayContaining(['pages/api/auth/resend-invitation.ts', 'backend/services/invitationService.ts']));
    expect(offenders(files)).toEqual([]);
  });

  it('control: the unguarded shape is caught; the guarded shape and the exempt consume paths are not', () => {
    const bad = "await supabase.from('invitations').update({ revoked_at: now }).eq('id', id).is('accepted_at', null);";
    const good = "await supabase.from('invitations').update({ revoked_at: now }).eq('id', id).is('accepted_at', null).is('revoked_at', null);";
    expect(offenders([{ rel: 'pages/api/x.ts', src: bad }])).toEqual(['pages/api/x.ts:1']);
    expect(offenders([{ rel: 'pages/api/x.ts', src: good }])).toEqual([]);
    expect(offenders([{ rel: 'pages/api/auth/accept-invite.ts', src: bad }])).toEqual([]);
  });
});
