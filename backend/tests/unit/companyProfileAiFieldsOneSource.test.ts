/**
 * 7c (2026-11-19): the company-profile AI output-field lists are ONE definition. The server's merge
 * (the routes' mergeAiScalarFields) is the authoritative data-loss guard; the client's merge reads the
 * same lists, so the two layers can never protect different fields.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as shared from '../../../lib/companyProfile/aiOutputFields';
import * as client from '../../../utils/mergeCampaignPurposeIntent';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const FIELD_NAMES = [...shared.TARGET_CUSTOMER_FIELDS, ...shared.MARKETING_INTELLIGENCE_FIELDS];
/** A line that is just `'field',` (an array element). Built with String.raw so `\s` stays a regex escape. */
const relistedLine = (field: string) => new RegExp(String.raw`^\s*'` + field + String.raw`',\s*$`, 'm');

describe('company-profile AI output fields: one source', () => {
  it('the client merge uses the SAME arrays (identity, not a copy)', () => {
    expect(client.TARGET_CUSTOMER_FIELDS).toBe(shared.TARGET_CUSTOMER_FIELDS);
    expect(client.MARKETING_INTELLIGENCE_FIELDS).toBe(shared.MARKETING_INTELLIGENCE_FIELDS);
  });

  it.each([
    ['pages/api/company-profile/define-target-customer.ts', 'TARGET_CUSTOMER_FIELDS'],
    ['pages/api/company-profile/generate-marketing-intelligence.ts', 'MARKETING_INTELLIGENCE_FIELDS'],
    ['pages/api/company-profile/define-marketing-intelligence.ts', 'MARKETING_INTELLIGENCE_FIELDS'],
  ])('%s imports the shared list and keeps no private copy', (file, name) => {
    const src = read(file);
    expect(src).toContain(`import { ${name} } from '../../../lib/companyProfile/aiOutputFields';`);
    // A private copy would re-list the field names as string literals in an array.
    const relisted = FIELD_NAMES.filter((f) => relistedLine(f).test(src));
    expect(relisted).toEqual([]);
  });

  it('control: the field-literal detector does see a private array copy', () => {
    const copy = "const X = [\n  'marketing_channels',\n  'content_strategy',\n] as const;";
    expect(FIELD_NAMES.filter((f) => relistedLine(f).test(copy))).toEqual(['marketing_channels', 'content_strategy']);
  });
});
