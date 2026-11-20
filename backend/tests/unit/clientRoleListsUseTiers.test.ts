/**
 * Roles Approach A (R4): CONTENT_MANAGER / CONTENT_PLANNER / CONTENT_ENGAGER / VIEWER keep their identity on the
 * client (CompanyContext no longer rewrites them to CONTENT_CREATOR / VIEW_ONLY). A raw `[...].includes(role)`
 * membership test against an allow-list naming CONTENT_CREATOR or VIEW_ONLY therefore silently STOPS matching
 * the four - it must go through roleSatisfies (the role OR its base tier, shared/rbac/tenantRoles), as the
 * server does. (b3/89 scan, 2026-11-20: useRecommendationsState x4 + discovered-users canEditRole.)
 *
 * Keyed on the SHAPE, across every client file (pages, components, hooks, utils, lib) - not on the instances found.
 */
export {};
/* eslint-disable @typescript-eslint/no-var-requires */
import fs from 'fs';
import path from 'path';

// An array literal that names CONTENT_CREATOR or VIEW_ONLY, immediately followed by `.includes(` / `.indexOf(`.
const RAW_MEMBERSHIP = /\[[^\][]*'(?:CONTENT_CREATOR|VIEW_ONLY)'[^\][]*\]\s*\.\s*(?:includes|indexOf)\s*\(/g;

function offenders(files: Array<{ rel: string; src: string }>): string[] {
  const out: string[] = [];
  for (const { rel, src } of files) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (RAW_MEMBERSHIP.test(code)) out.push(rel);
    RAW_MEMBERSHIP.lastIndex = 0;
  }
  return out;
}

describe('client role allow-lists use the tier model', () => {
  it('no raw [...CONTENT_CREATOR / VIEW_ONLY...].includes(role) in client code', () => {
    const { execFileSync } = require('child_process');
    const rels: string[] = execFileSync('git', ['ls-files', 'pages', 'components', 'hooks', 'utils', 'lib'], { encoding: 'utf8' })
      .split('\n')
      .filter((p: string) => /\.(ts|tsx)$/.test(p) && !/(^|\/)(tests?|__tests__)\//.test(p) && !/\.test\.tsx?$/.test(p) && !p.startsWith('pages/api/'));
    expect(rels.length).toBeGreaterThan(100);
    const files = rels.map((rel) => ({ rel, src: fs.readFileSync(path.join(process.cwd(), rel), 'utf8') }));
    expect(offenders(files)).toEqual([]);
  });

  it('control: the shape the fix removed IS caught; the roleSatisfies form and a comment are not', () => {
    expect(offenders([{ rel: 'a.tsx', src: "return ['COMPANY_ADMIN', 'CONTENT_CREATOR', 'SUPER_ADMIN'].includes(role);" }])).toEqual(['a.tsx']);
    expect(offenders([{ rel: 'b.tsx', src: "const ok = [\n  'VIEW_ONLY', 'X',\n].indexOf(r) >= 0;" }])).toEqual(['b.tsx']);
    expect(offenders([{ rel: 'c.tsx', src: "return roleSatisfies(role, ['COMPANY_ADMIN', 'CONTENT_CREATOR']);" }])).toEqual([]);
    expect(offenders([{ rel: 'd.tsx', src: "// ['CONTENT_CREATOR'].includes(role)" }])).toEqual([]);
  });

  it('the fixed sites: the four content roles get exactly the pre-R4 answers where they were collapsed', () => {
    const { roleSatisfies } = require('../../../shared/rbac/tenantRoles');
    const MANAGE = ['COMPANY_ADMIN', 'CONTENT_CREATOR', 'SUPER_ADMIN'];
    const EDIT = ['CONTENT_CREATOR', 'CONTENT_REVIEWER', 'CONTENT_PUBLISHER', 'COMPANY_ADMIN', 'SUPER_ADMIN'];
    for (const r of ['CONTENT_MANAGER', 'CONTENT_PLANNER']) { expect(roleSatisfies(r, MANAGE)).toBe(true); expect(roleSatisfies(r, EDIT)).toBe(true); }
    for (const r of ['CONTENT_ENGAGER', 'VIEWER']) { expect(roleSatisfies(r, MANAGE)).toBe(false); expect(roleSatisfies(r, EDIT)).toBe(false); }
  });
});
