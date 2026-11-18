/**
 * GATE-404 (owner + coordinator ruling, 2026-11-18) — static pin on the ONE opt-in that lets
 * enforceCompanyAccess admit a campaign id that matches no campaign.
 *
 * A deleted campaign leaves its child rows behind, so "this campaign does not exist" is not proof the id is
 * nobody's. The gate therefore answers 404 for a missing campaign unless the caller passes the LITERAL
 * `allowMissingCampaign: true`. This test pins:
 *   - every use outside the two definitions is exactly `allowMissingCampaign: true` (never derived from request
 *     data such as `req.body.x`);
 *   - the files that opt in are exactly ['pages/api/campaigns/create-12week-plan.ts'], by NAME;
 *   - the definitions themselves only declare the field, test it against the literal, and forward the literal.
 */
import fs from 'fs';
import path from 'path';

const REPO = path.resolve(__dirname, '../../..');
const ROOTS = ['pages', 'backend', 'lib'];
const TOKEN = 'allowMissingCampaign';

/** Files that DEFINE the option (the gate, and the wrapper that forwards it). */
const DEFINITION_FILES: Record<string, RegExp[]> = {
  'backend/services/userContextService.ts': [
    /^\s*allowMissingCampaign\?: true;$/, // input type
    /input\.allowMissingCampaign === true\)/, // the only check
    /^\s*\* opts in with the LITERAL `allowMissingCampaign: true` \(never derived from$/, // doc comment
    /backend\/tests\/unit\/allowMissingCampaignLiteral\.test\.ts\.$/, // doc comment pointer to this test
  ],
  'backend/services/companyContextGuardService.ts': [
    /^\s*allowMissingCampaign\?: true;$/,
    /^\s*\.\.\.\(input\.allowMissingCampaign === true \? \{ allowMissingCampaign: true \} : \{\}\),$/,
  ],
};
const EXPECTED_USERS = ['pages/api/campaigns/create-12week-plan.ts'];

/** A use site: the token must appear only as the literal property `allowMissingCampaign: true` (optional comma). */
export function isLiteralUse(line: string): boolean {
  const occurrences = line.split(TOKEN).length - 1;
  if (occurrences !== 1) return false;
  return /^\s*allowMissingCampaign: true,?\s*$/.test(line) || /[{,]\s*allowMissingCampaign: true\s*[,}]/.test(line);
}

function isTestPath(rel: string): boolean {
  return /(^|\/)(tests?|__tests__|__mocks__)\//.test(rel) || /\.(test|spec)\.tsx?$/.test(rel);
}

function walk(dir: string, out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.next') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(ent.name)) out.push(full);
  }
}

type Hit = { file: string; line: number; text: string };
function scan(): Hit[] {
  const files: string[] = [];
  for (const root of ROOTS) walk(path.join(REPO, root), files);
  const hits: Hit[] = [];
  for (const full of files) {
    const rel = path.relative(REPO, full).split(path.sep).join('/');
    if (isTestPath(rel)) continue;
    const src = fs.readFileSync(full, 'utf8');
    if (!src.includes(TOKEN)) continue;
    src.split(/\r?\n/).forEach((text, i) => { if (text.includes(TOKEN)) hits.push({ file: rel, line: i + 1, text }); });
  }
  return hits;
}

const hits = scan();

describe('allowMissingCampaign is a literal opt-in with exactly one user', () => {
  it('positive control: the scan finds the create-12week-plan opt-in', () => {
    expect(hits.some((h) => h.file === 'pages/api/campaigns/create-12week-plan.ts')).toBe(true);
  });

  it('every use outside the definitions is exactly `allowMissingCampaign: true`', () => {
    const bad = hits.filter((h) => !DEFINITION_FILES[h.file] && !isLiteralUse(h.text));
    expect(bad).toEqual([]);
  });

  it('the definitions only declare, test and forward the literal', () => {
    const bad = hits.filter((h) => DEFINITION_FILES[h.file] && !DEFINITION_FILES[h.file].some((re) => re.test(h.text)));
    expect(bad).toEqual([]);
    for (const file of Object.keys(DEFINITION_FILES)) expect(hits.some((h) => h.file === file)).toBe(true);
  });

  it('the files that opt in are exactly create-12week-plan.ts, by name', () => {
    const users = Array.from(new Set(hits.filter((h) => !DEFINITION_FILES[h.file]).map((h) => h.file))).sort();
    expect(users).toEqual(EXPECTED_USERS);
  });

  it('create-12week-plan opts in once, in the new-campaign branch only', () => {
    const src = fs.readFileSync(path.join(REPO, 'pages/api/campaigns/create-12week-plan.ts'), 'utf8');
    expect(src.split(TOKEN).length - 1).toBe(1);
    const at = src.indexOf(TOKEN);
    const branch = src.lastIndexOf("} else if (typeof companyId === 'string' && companyId.trim()) {", at);
    expect(branch).toBeGreaterThan(-1);
    // The existing-campaign branch (`if (campaign) {`) precedes the new-campaign branch and does not opt in.
    expect(src.slice(src.lastIndexOf('if (campaign) {', branch), branch)).not.toContain(TOKEN);
    expect(src.slice(branch, at)).toContain('requireCompanyContext({');
  });

  describe('fixture controls (the matcher is not vacuous)', () => {
    it.each([
      ['allowMissingCampaign: req.body.x,'],
      ['  allowMissingCampaign: Boolean(req.query.create),'],
      ['  allowMissingCampaign: allow,'],
      ['  allowMissingCampaign,'],
      ['  ...{ allowMissingCampaign: req.body.allowMissingCampaign },'],
      ['  allowMissingCampaign: true || req.body.x,'],
    ])('flags %s', (line) => {
      expect(isLiteralUse(line)).toBe(false);
    });
    it.each([
      ['        allowMissingCampaign: true,'],
      ['  requireCompanyContext({ req, res, companyId, campaignId, allowMissingCampaign: true })'],
    ])('accepts %s', (line) => {
      expect(isLiteralUse(line)).toBe(true);
    });
  });
});
