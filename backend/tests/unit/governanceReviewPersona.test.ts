/**
 * The governance approval routes' role -> creative-review persona map (b3/7c 2026-11-20): every canonical role is
 * mapped EXPLICITLY, the personas are exactly those in force before roles Approach A, both routes use the one map,
 * and changing the fallback cannot move a known role.
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
import fs from 'fs';
import path from 'path';

const MOD = 'backend/services/creator/governanceReviewPersona';
const PINNED: Record<string, string> = {
  SUPER_ADMIN:       'executive_reviewer',
  COMPANY_ADMIN:     'campaign_manager',
  CONTENT_REVIEWER:  'compliance_reviewer',
  CONTENT_PUBLISHER: 'campaign_manager',
  CONTENT_CREATOR:   'creative_operator',
  CONTENT_MANAGER:   'compliance_reviewer',
  CONTENT_PLANNER:   'creative_operator',
  CONTENT_ENGAGER:   'creative_operator',
  VIEWER:            'creative_operator',
  VIEW_ONLY:         'creative_operator',
  CONTENT_ARCHITECT: 'creative_operator',
};

describe('governance review persona', () => {
  const { governanceReviewPersona, GOVERNANCE_REVIEW_PERSONA } = require(`../../../${MOD}`);

  it('every canonical role is mapped explicitly, to exactly the pinned persona', () => {
    expect({ ...GOVERNANCE_REVIEW_PERSONA }).toEqual(PINNED);
    for (const [role, persona] of Object.entries(PINNED)) expect(governanceReviewPersona(role)).toBe(persona);
  });

  it('only a non-canonical value takes the fallback (least privileged)', () => {
    for (const v of [null, undefined, '', 'ADMIN', 'admin', 'super_admin', 'toString', '__proto__']) {
      expect(governanceReviewPersona(v)).toBe('creative_operator');
    }
  });

  it('control: changing the FALLBACK moves no known role (only the unknown values)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), `${MOD}.ts`), 'utf8');
    const anchor = "export const GOVERNANCE_REVIEW_PERSONA_FALLBACK: CreativeReviewRole = 'creative_operator';";
    expect(src.split(anchor).length).toBe(2); // the anchor matches exactly once (a disarmed control fails here)
    const mutated = src.replace(anchor, "export const GOVERNANCE_REVIEW_PERSONA_FALLBACK: CreativeReviewRole = 'admin';");
    const tmp = path.join(process.cwd(), `${MOD}.fallbackcontrol.tmp.ts`);
    fs.writeFileSync(tmp, mutated);
    try {
      jest.isolateModules(() => {
        const m = require(tmp);
        for (const [role, persona] of Object.entries(PINNED)) expect(m.governanceReviewPersona(role)).toBe(persona);
        expect(m.governanceReviewPersona('ADMIN')).toBe('admin'); // the mutation took effect
      });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('both approval routes use the one map (no local switch / default left behind)', () => {
    for (const route of ['comment', 'decide']) {
      const src = fs.readFileSync(path.join(process.cwd(), `pages/api/enterprise-governance/approvals/${route}.ts`), 'utf8');
      expect(src).toMatch(/const rbacRoleToReviewRole = \(role: string \| null\): CreativeReviewRole => governanceReviewPersona\(role\);/);
      expect(src).not.toMatch(/switch \(role\)/);
    }
  });
});
