/**
 * shared/auth/* are the ONE role source the server gates and the UI share (04/89/7c 2026-11-19). Two properties:
 *
 * 1. DEPENDENCY-FREE (safe from client AND server bundles, like lib/shared/domain/companyDomain.ts): a module may import
 *    nothing, or only another shared/auth module (which this same check covers). No server code, supabase, next, env.
 * 2. The dependency-free normaliser (shared/auth/roleNormalization.ts) gives EXACTLY the server's answer
 *    (backend/services/rbacPrimitives.ts normalizeRole - what getUserRole and TenantGuard requireNormalizedRoleIn use)
 *    over every known role and every spelling variant, so a predicate built on it decides what the server decides.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeRole } = require('../../services/rbacPrimitives');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeRoleName, KNOWN_ROLE_NAMES } = require('../../../shared/auth/roleNormalization');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Role } = require('../../services/rbacPrimitives');

const DIR = path.resolve(__dirname, '../../../shared/auth');

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) specs.push(m[1] || m[2] || m[3] || m[4]);
  return specs;
}

/** Violations: any import that is not a relative path to another file in shared/auth. */
function dependencyViolations(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, src] of Object.entries(files)) {
    for (const spec of importSpecifiers(src)) {
      const ok = /^\.\/[A-Za-z0-9_]+$/.test(spec) && `${spec.slice(2)}.ts` in files;
      if (!ok) out.push(`${name} -> ${spec}`);
    }
  }
  return out.sort();
}

const files: Record<string, string> = Object.fromEntries(
  fs.readdirSync(DIR).filter((f) => f.endsWith('.ts')).map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]),
);

/** Every known role plus the spellings the server must agree on. */
const CORPUS: Array<string | null | undefined> = [
  ...KNOWN_ROLE_NAMES,
  ...KNOWN_ROLE_NAMES.map((r: string) => r.toLowerCase()),
  ...KNOWN_ROLE_NAMES.map((r: string) => r.toLowerCase().replace(/_/g, ' ')),
  ...KNOWN_ROLE_NAMES.map((r: string) => `  ${r}\t`),
  'Company_Admin', 'COMPANYADMIN', 'companyadmin', 'company admin', 'company  admin', 'admin', 'Admin',
  'CONTENTPLANNER', 'content planner', 'content  manager', 'viewer', 'Content_Engager',
  'CONTENT_ARCHITECT', 'content_architect', 'CAMPAIGN_ARCHITECT', 'OWNER', 'garbage-role', 'SUPER ADMIN', 'super-admin',
  '', '   ', null, undefined,
];

describe('shared/auth role modules', () => {
  it('non-vacuity: the directory holds the normaliser and at least one role module', () => {
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['roleNormalization.ts']));
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(2);
  });

  it('every module is dependency-free (imports only other shared/auth modules)', () => {
    expect(dependencyViolations(files)).toEqual([]);
  });

  it('the normaliser imports nothing at all', () => {
    expect(importSpecifiers(files['roleNormalization.ts'])).toEqual([]);
  });

  it('KNOWN_ROLE_NAMES is exactly the server Role table', () => {
    expect([...KNOWN_ROLE_NAMES].sort()).toEqual(Object.values(Role).sort());
  });

  it.each(CORPUS.map((r) => [JSON.stringify(r), r]))('normalizeRoleName(%s) === rbacPrimitives.normalizeRole', (_l, r) => {
    expect(normalizeRoleName(r)).toBe(normalizeRole(r));
  });

  describe('mutant controls', () => {
    it('a server import is reported', () => {
      const m = { ...files, 'x.ts': "import { supabase } from '../../backend/db/supabaseClient';\n" };
      expect(dependencyViolations(m)).toEqual(['x.ts -> ../../backend/db/supabaseClient']);
    });
    it('a package import (next) and a require are reported', () => {
      const m = { ...files, 'y.ts': "import type { NextApiRequest } from 'next';\nconst e = require('../../config');\n" };
      expect(dependencyViolations(m)).toEqual(['y.ts -> ../../config', 'y.ts -> next']);
    });
    it('an import of a shared/auth module that does not exist is reported', () => {
      const m = { ...files, 'z.ts': "import { a } from './nope';\n" };
      expect(dependencyViolations(m)).toEqual(['z.ts -> ./nope']);
    });
  });
});
