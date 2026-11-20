/**
 * Roles Approach A closes a CLASS (b3 ruling 2026-11-20): before R1, normalizeRole folded CONTENT_MANAGER /
 * CONTENT_PLANNER into CONTENT_CREATOR and VIEWER / CONTENT_ENGAGER into VIEW_ONLY. Any code that compares a
 * (normalized) role NAME against one of those two collapse targets therefore silently changes meaning under R1:
 * wr448's campaignWriteDecision (`normalizeRole(raw) !== Role.VIEW_ONLY` -> allow) let a VIEWER write once both
 * landed. Access must be decided on the TIER (roleSatisfies / roleAndTiers, shared/rbac/tenantRoles).
 *
 * This guard is keyed on the SHAPE across server code (backend, pages/api, lib, shared), so a branch that lands after
 * roles-A and brings the old form back goes red. The client half is clientRoleListsUseTiers.
 *
 * SHAPES caught (comments stripped): a comparison whose operand IS a collapse target - `=== / !== X`, `X === / !==`,
 * `case X:` - and an array literal naming a target followed by `.includes(` / `.indexOf(`.
 * LIMITS (stated, not hidden): a Set/array held in a variable and tested later (`ROLES.has(r)`) is not followed -
 * such lists are legitimately passed to roleSatisfies; a role lowercased before comparison is caught only if the
 * literal is upper-case.
 * EXEMPT: the rbac core that DEFINES the mapping (rbacPrimitives, capabilityRegistry, shared/rbac/*) and the separate
 * campaign-scoped role domain (`CampaignRole.*`, campaign_user_roles), which has no collapse.
 */
export {};
/* eslint-disable @typescript-eslint/no-var-requires */
import fs from 'fs';
import path from 'path';

const T = '(?:VIEW_ONLY|CONTENT_CREATOR)';
const OPERAND = `(?:Role\\.${T}\\b|'${T}'|"${T}")`;
const SHAPES: RegExp[] = [
  new RegExp(`(?:===|!==)\\s*${OPERAND}`),
  new RegExp(`${OPERAND}\\s*(?:===|!==)`),
  new RegExp(`\\bcase\\s+${OPERAND}\\s*:`),
  new RegExp(`\\[[^\\][]*${OPERAND}[^\\][]*\\]\\s*\\.\\s*(?:includes|indexOf)\\s*\\(`),
];
const EXEMPT_FILES = [/^backend\/services\/rbacPrimitives\.ts$/, /^backend\/security\/capabilityRegistry\.ts$/, /^shared\/rbac\//];

export function offenders(files: Array<{ rel: string; src: string }>): string[] {
  const out: string[] = [];
  for (const { rel, src } of files) {
    if (EXEMPT_FILES.some((re) => re.test(rel))) continue;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/CampaignRole\.\w+/g, 'CAMPAIGN_ROLE');
    code.split('\n').forEach((line, i) => {
      if (SHAPES.some((re) => re.test(line))) out.push(`${rel}:${i + 1}`);
    });
  }
  return out;
}

describe('server code decides access on the tier, never on a collapse-target name', () => {
  it('no normalized-name comparison against VIEW_ONLY / CONTENT_CREATOR outside the rbac core', () => {
    const { execFileSync } = require('child_process');
    const rels: string[] = execFileSync('git', ['ls-files', 'backend', 'pages/api', 'lib', 'shared'], { encoding: 'utf8' })
      .split('\n')
      .filter((p: string) => /\.(ts|tsx)$/.test(p) && !/\.d\.ts$/.test(p) && !/(^|\/)(tests?|__tests__)\//.test(p) && !/\.test\.tsx?$/.test(p));
    expect(rels.length).toBeGreaterThan(500);
    const files = rels.map((rel) => ({ rel, src: fs.readFileSync(path.join(process.cwd(), rel), 'utf8') }));
    expect(offenders(files)).toEqual([]);
  });

  it('control: wr448\'s old campaignWriteDecision form IS caught; the tier form, a returned value and CampaignRole are not', () => {
    const caught = [
      "  if (normalized !== Role.VIEW_ONLY) return 'allow';",
      "  if (role === 'CONTENT_CREATOR') ok = true;",
      '    case Role.VIEW_ONLY: return false;',
      "  return ['COMPANY_ADMIN', 'CONTENT_CREATOR'].includes(normalizeRole(raw));",
    ];
    for (const src of caught) expect(offenders([{ rel: 'backend/services/x.ts', src }])).toEqual(['backend/services/x.ts:1']);
    const clean = [
      "  if (!roleSatisfies(raw, [Role.CONTENT_CREATOR, Role.COMPANY_ADMIN])) return 'forbid';",
      "  if (normalized === 'USER') return Role.CONTENT_CREATOR;",
      '    u === CampaignRole.CONTENT_CREATOR',
      "  // if (normalized !== Role.VIEW_ONLY) return 'allow';",
      "  if (normalized !== Role.VIEW_ONLY) return 'allow';",
    ];
    expect(offenders(clean.slice(0, 4).map((src, i) => ({ rel: `backend/services/c${i}.ts`, src })))).toEqual([]);
    expect(offenders([{ rel: 'backend/services/rbacPrimitives.ts', src: clean[4] }])).toEqual([]); // the core is exempt
  });
});
