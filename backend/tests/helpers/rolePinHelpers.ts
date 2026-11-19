/** Helpers for the shared/auth role pins (not a suite). */
import * as fs from 'fs';
import * as path from 'path';

export const REPO = path.resolve(__dirname, '../../..');

export function readRepo(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

/** Source with block and line comments removed (prose may name roles; code may not list them). */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

/** An array or Set literal that LISTS role names: ['X', ...] / [Role.X, ...] / new Set(['X', ...]). */
export const ROLE_LITERAL_LIST = /\[\s*(?:['"][A-Z][A-Z_]{2,}['"]|Role\.[A-Z_]+)\s*[,\]]/;

export function hasRoleLiteralList(source: string): boolean {
  return ROLE_LITERAL_LIST.test(stripComments(source));
}

/** Admin spellings (raw) that normalise to COMPANY_ADMIN; every admin-accepting gate must accept them. */
export const ADMIN_SPELLINGS = ['COMPANY_ADMIN', 'ADMIN', 'admin', 'COMPANYADMIN', 'company admin', 'Company_Admin', ' company_admin '];
