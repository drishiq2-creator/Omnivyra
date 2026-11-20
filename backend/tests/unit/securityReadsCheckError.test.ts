/**
 * ZERO ALLOWANCE (b3 2026-11-20): every postgrest statement under backend/security checks its error.
 * ownedDbTable / supabase never throw on a postgrest error; a security repository that ignored `error` turned a FAILED
 * read into "no row" and decisions failed OPEN (login without MFA, revoked sessions/devices/codes staying live).
 * Keyed on the SHAPE, over every non-test .ts file under backend/security:
 *   (a) an awaited query whose result is destructured WITHOUT `error`;
 *   (b) a bare awaited query (the statement starts with `await`) whose result is discarded;
 *   (c) an error branch answering absence: `if (<err>) return null | [] | 0 | false` (a NEGATED test such as
 *       `if (!error) return false` is a predicate, not this).
 * A "query" is an awaited chain containing a postgrest verb (.select/.update/.insert/.upsert/.delete/.rpc).
 * Intentional handling is explicit: throwOnSecurityReadError / throw / a logged best-effort branch.
 */
export {};
/* eslint-disable @typescript-eslint/no-var-requires */
import fs from 'fs';
import path from 'path';

const VERB = /\.(select|update|insert|upsert|delete|rpc)\s*\(/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
}

/** The awaited chain from index `i` (just after `await`) to the next ';' at depth 0. */
function chainFrom(code: string, i: number): string {
  let depth = 0;
  let e = i;
  for (; e < code.length; e++) {
    const c = code[e];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
    else if (c === ';' && depth === 0) break;
  }
  return code.slice(i, e);
}

export function offenders(files: Array<{ rel: string; src: string }>): string[] {
  const out: string[] = [];
  for (const { rel, src } of files) {
    const code = stripComments(src);
    const lineOf = (idx: number) => code.slice(0, idx).split('\n').length;
    let m: RegExpExecArray | null;
    const destr = /\b(?:const|let)\s*\{([^}]*)\}\s*=\s*await\b/g;
    while ((m = destr.exec(code))) {
      if (VERB.test(chainFrom(code, m.index + m[0].length)) && !/\berror\b/.test(m[1])) {
        out.push(`${rel}:${lineOf(m.index)} destructure-without-error`);
      }
    }
    const bare = /(^|[;{}])\s*await\b/gm;
    while ((m = bare.exec(code))) {
      const at = m.index + m[0].length;
      if (VERB.test(chainFrom(code, at))) out.push(`${rel}:${lineOf(at)} result-discarded`);
    }
    const absent = /if\s*\(\s*\w*[eE]rr\w*\s*\)\s*\{?\s*return\s+(null|\[\]|0|false)\s*;/g;
    while ((m = absent.exec(code))) out.push(`${rel}:${lineOf(m.index)} error-returns-absence`);
  }
  return out;
}

describe('backend/security: every postgrest statement checks its error (zero allowance)', () => {
  it('no security repository ignores a postgrest error or answers a failure as absence', () => {
    const { execFileSync } = require('child_process');
    const rels: string[] = execFileSync('git', ['ls-files', 'backend/security'], { encoding: 'utf8' })
      .split('\n').filter((p: string) => /\.ts$/.test(p) && !/\.test\.ts$/.test(p));
    expect(rels.length).toBeGreaterThan(20);
    const files = rels.map((rel) => ({ rel, src: fs.readFileSync(path.join(process.cwd(), rel), 'utf8') }));
    expect(offenders(files)).toEqual([]);
  });

  it('control: each forbidden shape is caught, the handled shapes are not', () => {
    const f = (src: string) => offenders([{ rel: 'backend/security/x.ts', src }]);
    expect(f("async function a() { const { data } = await ownedDbTable('t').select('*').eq('id', i).maybeSingle(); return data; }"))
      .toEqual(['backend/security/x.ts:1 destructure-without-error']);
    expect(f("async function a() { const { data } = await q.select('id'); return data; }"))
      .toEqual(['backend/security/x.ts:1 destructure-without-error']);
    expect(f("async function a() {\n  await ownedDbTable('t').update({ a: 1 }).eq('id', i);\n}"))
      .toEqual(['backend/security/x.ts:2 result-discarded']);
    expect(f("async function a() { const { data, error } = await db.from('t').select('*'); if (error) return null; return data; }"))
      .toEqual(['backend/security/x.ts:1 error-returns-absence']);
    expect(f("async function a() { const { data, error } = await db.from('t').select('*'); throwOnSecurityReadError({ error }, 'a', 't'); return data; }")).toEqual([]);
    expect(f("async function a() { const { error } = await ownedDbTable('t').update({ a: 1 }); if (error) logger.warn('x', {}); }")).toEqual([]);
    expect(f("function p(error) { if (!error) return false; return true; }")).toEqual([]);
    expect(f("async function a() { await argon2.hash(code); await sleep(5); }")).toEqual([]);
  });
});
