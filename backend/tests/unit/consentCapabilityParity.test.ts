/**
 * PARITY (7c, 2026-11-21): CONSENT_CAPABILITIES (backend/types/consent.ts) must be EXACTLY the value set of
 * consent_records_capability_check as defined by the LATEST migration that (re)creates it. A capability added to the
 * database without the type - or written through a cast - fails here, instead of compiling.
 * Also pins the deliberate separation: the acknowledgements are NOT integration capabilities (that list is a route
 * input allowlist, isIntegrationCapability).
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { CONSENT_ACK_CAPABILITIES, CONSENT_CAPABILITIES } from '../../types/consent';
import { INTEGRATION_CAPABILITIES, isIntegrationCapability } from '../../types/integrationCapabilities';

const DIR = join(process.cwd(), 'supabase/migrations');

/** The value set of the LAST migration (by version) that ADDs consent_records_capability_check. Pure over the text. */
export function latestCapabilityCheck(files: Array<{ name: string; sql: string }>): { file: string; values: string[] } {
  const defs = files
    .filter((f) => /^\d{14}_.*\.sql$/.test(f.name) && /ADD CONSTRAINT consent_records_capability_check\s+CHECK/.test(f.sql))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!defs.length) throw new Error('no migration defines consent_records_capability_check');
  const last = defs[defs.length - 1];
  const block = /ADD CONSTRAINT consent_records_capability_check\s+CHECK\s*\(capability IN \(([^)]*)\)\)/.exec(last.sql);
  if (!block) throw new Error(`cannot parse the CHECK in ${last.name}`);
  return { file: last.name, values: [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort() };
}

const files = readdirSync(DIR).filter((n) => n.endsWith('.sql')).map((name) => ({ name, sql: readFileSync(join(DIR, name), 'utf8') }));

describe('consent capability parity: TypeScript == the database CHECK', () => {
  it('CONSENT_CAPABILITIES is exactly the latest CHECK value set (075: 9 values)', () => {
    const { file, values } = latestCapabilityCheck(files);
    expect(file).toBe('20270217000075_consent_records_salesnav_ack.sql');
    expect([...CONSENT_CAPABILITIES].sort()).toEqual(values);
    expect(values).toHaveLength(9);
  });

  it('CONTROL: a value added to the database only is caught', () => {
    const drifted = files.map((f) => (f.name.startsWith('20270217000075') ? {
      ...f, sql: f.sql.replace("'salesnav_linkedin_restriction_ack'\n  )) NOT VALID", "'salesnav_linkedin_restriction_ack', 'a_tenth_value'\n  )) NOT VALID"),
    } : f));
    expect(drifted.find((f) => f.name.startsWith('20270217000075'))!.sql).toContain('a_tenth_value');
    expect([...CONSENT_CAPABILITIES].sort()).not.toEqual(latestCapabilityCheck(drifted).values);
  });

  it('the acknowledgements are NOT integration capabilities (the integration list is a route INPUT allowlist)', () => {
    for (const c of CONSENT_ACK_CAPABILITIES) {
      expect(INTEGRATION_CAPABILITIES as readonly string[]).not.toContain(c);
      expect(isIntegrationCapability(c)).toBe(false);
    }
  });
});
