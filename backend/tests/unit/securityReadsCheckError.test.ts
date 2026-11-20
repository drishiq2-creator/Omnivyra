/**
 * ZERO ALLOWANCE (b3 2026-11-20): every postgrest statement under backend/security checks its error.
 * ownedDbTable / supabase never throw on a postgrest error; a security repository that ignored `error` turned a FAILED
 * read into "no row" and decisions failed OPEN (login without MFA, revoked sessions/devices/codes staying live).
 * Keyed on the SHAPE, over every non-test .ts file under backend/security:
 *   (a) an awaited query whose result is destructured WITHOUT `error`;
 *   (b) a bare awaited query (the statement starts with `await`) whose result is discarded;
 *   (c) an error branch answering absence: `if (<err>) return null | [] | 0 | false | {}` (a NEGATED test such as
 *       `if (!error) return false` is a predicate, not this);
 *   (d) a `try` that performs a query and whose `catch` answers absence (`catch { return null | [] | false | {} }`);
 *   (e) a query chain with `.catch(() => null | [] | false | {})`.
 * (c)-(e) are the SECOND shape (7c/04 2026-11-20): the error IS seen and then its meaning is discarded - identical
 * defect to (a), invisible to a destructure-keyed detector. Catches around NON-query code (token decode, JSON.parse,
 * signature checks: null = "invalid, reject") are not this and are not flagged.
 * COVERAGE IS EXACTLY (a)-(e) - not "every dropped error".
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
    const absent = /if\s*\(\s*\w*[eE]rr\w*\s*\)\s*\{?\s*return\s+(null|\[\]|0|false|\{\s*\})\s*;/g;
    while ((m = absent.exec(code))) out.push(`${rel}:${lineOf(m.index)} error-returns-absence`);
    // (d) try { ...awaited query... } catch { return <absence> }
    const tryRe = /\btry\s*\{/g;
    while ((m = tryRe.exec(code))) {
      const bodyStart = m.index + m[0].length;
      let depth = 1;
      let e = bodyStart;
      for (; e < code.length && depth > 0; e++) { if (code[e] === '{') depth++; else if (code[e] === '}') depth--; }
      const body = code.slice(bodyStart, e - 1);
      const after = code.slice(e, e + 400);
      const isQuery = /\bawait\b[\s\S]*?\.(select|update|insert|upsert|delete|rpc)\s*\(/.test(body);
      if (isQuery && /^\s*catch\s*(\([^)]*\))?\s*\{[^{}]*?return\s+(null|\[\]|false|\{\s*\})\s*;/.test(after)) {
        out.push(`${rel}:${lineOf(m.index)} query-catch-returns-absence`);
      }
    }
    // (e) <query>.catch(() => <absence>)
    const dotCatch = /\.(select|update|insert|upsert|delete|rpc)\s*\([^;]*?\.catch\(\s*\(?\s*\w*\s*\)?\s*=>\s*(null|\[\]|false|\{\s*\})\s*\)/g;
    while ((m = dotCatch.exec(code))) out.push(`${rel}:${lineOf(m.index)} query-dotcatch-returns-absence`);
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
    // second shape (7c/04): the error is seen, then answered with absence
    expect(f("async function a() { const { data, error } = await db.from('t').select('*'); if (error) return {}; return data; }"))
      .toEqual(['backend/security/x.ts:1 error-returns-absence']);
    expect(f("async function a() { try { const { data, error } = await db.from('t').select('*'); throwOnSecurityReadError({ error }, 'a', 't'); return data; } catch { return null; } }"))
      .toEqual(['backend/security/x.ts:1 query-catch-returns-absence']);
    expect(f("async function a() { const r = await db.from('t').select('*').then((x) => x).catch(() => null); return r; }"))
      .toContain('backend/security/x.ts:1 query-dotcatch-returns-absence');
    // a catch around NON-query code (decode / parse: null = invalid, reject) is not this shape
    expect(f("function d(s) { try { return JSON.parse(s); } catch { return null; } }")).toEqual([]);
    expect(f("async function a() { await argon2.hash(code); await sleep(5); }")).toEqual([]);
  });
});
