/**
 * ZERO ALLOWANCE (b3 2026-11-20): every postgrest statement under backend/security checks its error, and a checked
 * error is never answered as absence. ownedDbTable / supabase never throw on a postgrest error; a security repository
 * that ignored `error` turned a FAILED read into "no row" and decisions failed OPEN (login without MFA, revoked
 * sessions/devices/codes staying live).
 *
 * Keyed on the SHAPE, over every non-test .ts file under backend/security. COVERAGE IS EXACTLY these shapes - not
 * "every dropped error" (this guard's green means "none of (a)-(f) here", nothing broader; the same class elsewhere
 * in the repo is the repo-wide detector's job):
 *   (a) an awaited query whose result is destructured WITHOUT `error`;
 *   (b) a bare awaited query (the statement starts with `await`) whose result is discarded;
 *   (c) an `if (<cond mentioning an error>) { ... }` block (combined conditions such as `error || !data` included,
 *       a NEGATED test such as `if (!error) ...` excluded - that is a predicate) that does NOT throw and answers
 *       ABSENCE: `return null | [] | {} | 0 | false | undefined` or a 4xx status (e.g. 404 "not found");
 *   (d) a `try` that performs a query and whose `catch` answers absence;
 *   (e) a query chain with `.catch(() => null | [] | false | {})`;
 *   (f) an `if (<error>) { ... }` block that neither throws nor returns - the error is tested, then execution falls
 *       through as if it succeeded.
 * (c)-(f) are the SECOND shape (7c/04/cb 2026-11-20): the error IS seen and then its meaning is discarded.
 * EXEMPTION, by rule not by file name: a block containing a `security-read-exempt: <reason>` comment (the reason
 * must be written there - e.g. best-effort cleanup that is never an authentication decision). Catches around
 * NON-query code (token decode, JSON.parse, signature checks: null = "invalid, reject") are not (d) by construction.
 */
export {};
/* eslint-disable @typescript-eslint/no-var-requires */
import fs from 'fs';
import path from 'path';

const VERB = /\.(select|update|insert|upsert|delete|rpc)\s*\(/;
const EXEMPT = /security-read-exempt:\s*\S/;

function stripComments(src: string): string {
  // Comments are BLANKED to the same length (never removed) so offsets stay aligned with the original source.
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, (m) => ' '.repeat(m.length));
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

/** From an opening '(' at `i`, the index just past its matching ')'. */
function matchParen(code: string, i: number): number {
  let depth = 0;
  for (let e = i; e < code.length; e++) {
    if (code[e] === '(') depth++;
    else if (code[e] === ')') { depth--; if (depth === 0) return e + 1; }
  }
  return code.length;
}
/** From an opening '{' at `i`, [bodyStart, bodyEnd). */
function blockAt(code: string, i: number): [number, number] {
  let depth = 0;
  for (let e = i; e < code.length; e++) {
    if (code[e] === '{') depth++;
    else if (code[e] === '}') { depth--; if (depth === 0) return [i + 1, e]; }
  }
  return [i + 1, code.length];
}

const ERR_IN_COND = /(^|[^!\w.])(error|err|\w+Err(or)?|\w+\.error)\b/;
const NEGATED_ONLY = /^\s*!\s*[\w.]*[eE]rr\w*\s*$/;
const ABSENCE = /\breturn\s+(null|\[\s*\]|\{\s*\}|0|false|undefined)\s*;|\.status\(\s*4\d\d\s*\)/;

export function offenders(files: Array<{ rel: string; src: string }>): string[] {
  const out: string[] = [];
  for (const { rel, src } of files) {
    const code = stripComments(src);
    const lineOf = (idx: number) => code.slice(0, idx).split('\n').length;
    let m: RegExpExecArray | null;
    // (a)
    const destr = /\b(?:const|let)\s*\{([^}]*)\}\s*=\s*await\b/g;
    while ((m = destr.exec(code))) {
      if (VERB.test(chainFrom(code, m.index + m[0].length)) && !/\berror\b/.test(m[1])) {
        out.push(`${rel}:${lineOf(m.index)} destructure-without-error`);
      }
    }
    // (b)
    const bare = /(^|[;{}])\s*await\b/gm;
    while ((m = bare.exec(code))) {
      const at = m.index + m[0].length;
      if (VERB.test(chainFrom(code, at))) out.push(`${rel}:${lineOf(at)} result-discarded`);
    }
    // (c) + (f): every `if (...)` whose condition mentions an error; the block is read from the ORIGINAL source so
    // an exemption comment inside it is visible.
    const ifRe = /\bif\s*\(/g;
    while ((m = ifRe.exec(code))) {
      const condStart = m.index + m[0].length - 1;
      const condEnd = matchParen(code, condStart);
      const cond = code.slice(condStart + 1, condEnd - 1);
      if (!ERR_IN_COND.test(cond) || NEGATED_ONLY.test(cond)) continue;
      if (/===|!==/.test(cond)) continue; // comparisons on an error CODE (e.g. auth.error === 'X') are routing, not this
      let k = condEnd;
      while (k < code.length && /\s/.test(code[k])) k++;
      let body: string;
      let rawBody: string;
      if (code[k] === '{') {
        const [b0, b1] = blockAt(code, k);
        body = code.slice(b0, b1);
        rawBody = src.slice(b0, b1);
      } else {
        const end = code.indexOf(';', k);
        body = code.slice(k, end + 1);
        rawBody = src.slice(k, end + 1);
      }
      if (EXEMPT.test(rawBody)) continue;
      if (/\bthrow\b/.test(body)) continue;
      if (/\.status\(\s*5\d\d\s*\)/.test(body)) continue; // an honest 5xx response (then `return null` = "response sent")
      if (ABSENCE.test(body)) out.push(`${rel}:${lineOf(m.index)} error-answered-as-absence`);
      else if (!/\breturn\b/.test(body) && !/\bcontinue\b|\bbreak\b/.test(body)) out.push(`${rel}:${lineOf(m.index)} error-falls-through`);
    }
    // (d)
    const tryRe = /\btry\s*\{/g;
    while ((m = tryRe.exec(code))) {
      const [b0, b1] = blockAt(code, m.index + m[0].length - 1);
      const body = code.slice(b0, b1);
      const after = code.slice(b1 + 1, b1 + 400);
      const isQuery = /\bawait\b[\s\S]*?\.(select|update|insert|upsert|delete|rpc)\s*\(/.test(body);
      if (isQuery && /^\s*catch\s*(\([^)]*\))?\s*\{[^{}]*?return\s+(null|\[\s*\]|false|\{\s*\})\s*;/.test(after)) {
        out.push(`${rel}:${lineOf(m.index)} query-catch-returns-absence`);
      }
    }
    // (e)
    const dotCatch = /\.(select|update|insert|upsert|delete|rpc)\s*\([^;]*?\.catch\(\s*\(?\s*\w*\s*\)?\s*=>\s*(null|\[\s*\]|false|\{\s*\})\s*\)/g;
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
    // (a) (b)
    expect(f("async function a() { const { data } = await ownedDbTable('t').select('*').eq('id', i).maybeSingle(); return data; }"))
      .toEqual(['backend/security/x.ts:1 destructure-without-error']);
    expect(f("async function a() { const { data } = await q.select('id'); return data; }"))
      .toEqual(['backend/security/x.ts:1 destructure-without-error']);
    expect(f("async function a() {\n  await ownedDbTable('t').update({ a: 1 }).eq('id', i);\n}"))
      .toEqual(['backend/security/x.ts:2 result-discarded']);
    // (c): immediate, LOGGED-then-absence (readVaultSecret's old shape), combined condition + 4xx (TenantGuard's)
    expect(f("async function a() { const { data, error } = await db.from('t').select('*'); if (error) return {}; return data; }"))
      .toEqual(['backend/security/x.ts:1 error-answered-as-absence']);
    expect(f("async function a() { const { data, error } = await db.rpc('f', { p }); if (error) { logger.warn('x', { id, m: error.message }); return null; } return data; }"))
      .toEqual(['backend/security/x.ts:1 error-answered-as-absence']);
    expect(f("async function a() { const { data, error } = await db.from('t').select('*'); if (error || !data) { res.status(404).json({ e: 1 }); return null; } return data; }"))
      .toEqual(['backend/security/x.ts:1 error-answered-as-absence']);
    // (f): tested then falls through
    expect(f("async function a() { const { error } = await db.rpc('f', {}); if (error) { logger.warn('x', {}); } done(); }"))
      .toEqual(['backend/security/x.ts:1 error-falls-through']);
    // (d) (e)
    expect(f("async function a() { try { const { data, error } = await db.from('t').select('*'); throwOnSecurityReadError({ error }, 'a', 't'); return data; } catch { return null; } }"))
      .toEqual(['backend/security/x.ts:1 query-catch-returns-absence']);
    expect(f("async function a() { const r = await db.from('t').select('*').then((x) => x).catch(() => null); return r; }"))
      .toContain('backend/security/x.ts:1 query-dotcatch-returns-absence');
    // handled / excluded shapes
    expect(f("async function a() { const { data, error } = await db.from('t').select('*'); throwOnSecurityReadError({ error }, 'a', 't'); return data; }")).toEqual([]);
    expect(f("async function a() { const { data, error } = await db.from('t').insert({}); if (error || !data) { logger.error('x', {}); throw new Error('y'); } return data; }")).toEqual([]);
    expect(f("function p(error) { if (!error) return false; return true; }")).toEqual([]);
    expect(f("function r(auth) { if (auth.error === 'ACCOUNT_DELETED') return { ok: false }; }")).toEqual([]);
    expect(f("async function a() { const { error } = await db.rpc('del', {}); if (error) {\n // security-read-exempt: best-effort cleanup, never an auth decision\n logger.warn('x', {}); } }")).toEqual([]);
    expect(f("function d(s) { try { return JSON.parse(s); } catch { return null; } }")).toEqual([]);
    expect(f("async function a() { await argon2.hash(code); await sleep(5); }")).toEqual([]);
  });
});
