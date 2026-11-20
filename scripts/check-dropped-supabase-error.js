#!/usr/bin/env node
/**
 * Dropped-`error` Supabase read gate (b3 class ruling 2026-11-20; owner cb).
 *
 * WHAT IT CATCHES - THREE SHAPES of one class (a database read failure that comes out as a legitimate-looking answer):
 *   A: `const|let { data ... } = await <expr>` with NO `error` key, where <expr> (to the end of the statement, at most
 *      12 lines) is a database call: `.from(`, `ownedDbTable(`, `tenantTable(`, `tenantChildTable(` or `.rpc(`.
 *   B: the error IS read (`if (error ...)` / `if (r.error ...)`, a DB call within the 15 lines before) and the branch
 *      answers an ABSENCE value: null / undefined / [] / {} / false / 0 / ''; also `catch { return <absence> }` whose
 *      try block contains a DB call (7c, from websiteService.getWebsite).
 *   C: the error IS tested and the branch neither refuses (throw / return / break / continue / else) nor answers - it
 *      logs and FALLS THROUGH, so the code continues as if the read answered (c6/7c, from findMatchingCompany).
 * COVERAGE CLAIM: a clean result means "no instance of shapes A, B or C", NEVER "no dropped errors" - other shapes
 * exist (e.g. a lenient resolver that maps any error to a default: PL-104). The ratchet is per file AND per shape, so
 * fixing one shape cannot net off a new instance of another. KNOWN GAP: an error answered with a non-literal
 * "absent" response (e.g. `if (error || !data) return res.status(404)...`) is not keyed by B.
 * EXEMPTION: `dropped-error-exempt: <reason>` (or `security-read-exempt: <reason>`) on the line or the line above;
 * the reason must be non-empty. Exempt instances are not counted.
 *
 * HOW IT GATES (a per-FILE count ratchet, reduce-only): scripts/dropped-supabase-error-baseline.json maps
 * file -> allowed count. The gate FAILS when a file's count is ABOVE its baseline (a new instance, even in an
 * already-listed file) or when a file not in the baseline has any instance. Counts BELOW baseline pass and are
 * reported, so the fix's own commit lowers the entry (`--write-baseline` regenerates; review the diff - it may
 * only go DOWN). Line numbers are deliberately not part of the key, so edits that move lines never trip it.
 *
 * LIMITS (stated, not hidden): NOT flagged - an error read via the whole result object
 * (`const r = await ...; if (r.error) ...`); reads with no destructure (`await q.then(...)`); non-awaited promise
 * chains; a destructure that renames data but omits error IS flagged. `.single()` / `.maybeSingle()` are not
 * distinguished. The scope is backend/, pages/api/, lib/ (.ts/.tsx), excluding tests (backend/tests, __tests__,
 * *.test.*, *.spec.*). backend/scripts are counted (ops scripts, lowest fix priority).
 *
 * Usage: node scripts/check-dropped-supabase-error.js [--write-baseline] [--root <dir>] [--baseline <file>]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const ROOT = path.resolve(opt('--root', path.join(__dirname, '..')));
const BASELINE = path.resolve(ROOT, opt('--baseline', 'scripts/dropped-supabase-error-baseline.json'));
const WRITE = args.includes('--write-baseline');
const SCOPES = ['backend', 'pages/api', 'lib'];
const EXCLUDE = /(^|\/)(backend\/tests\/|__tests__\/)|\.(test|spec)\.tsx?$/;
const DB = /(\.from\(|ownedDbTable\(|tenantTable\(|tenantChildTable\(|\.rpc\()/;

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // deterministic across filesystems
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}


// EXEMPTION (written, auditable - never a heuristic exclusion): a comment on the flagged line or the line above
// carrying `dropped-error-exempt: <reason>` (or 89's `security-read-exempt: <reason>`) with a NON-EMPTY reason.
const EXEMPT = /\b(?:dropped-error-exempt|security-read-exempt):\s*\S/;
function notExempt(src, hits) {
  return hits.filter((n) => !(EXEMPT.test(src[n - 1] || '') || EXEMPT.test(src[n - 2] || '')));
}

/** SHAPE A - instances in one source text: `{ data }` destructured from a DB read with no `error` key. */
function scanSource(text) {
  const src = text.split('\n');
  const hits = [];
  for (let i = 0; i < src.length; i++) {
    const m = src[i].match(/\b(const|let)\s*\{([^}]*)\}\s*=\s*await\b/);
    if (!m) continue;
    const keys = m[2].split(',').map((k) => k.trim().split(':')[0].trim());
    if (!keys.includes('data') || keys.includes('error')) continue;
    let stmt = src[i].slice(src[i].indexOf('await'));
    for (let k = i + 1; k < Math.min(src.length, i + 12) && !/;\s*$/.test(stmt.trimEnd()); k++) stmt += ' ' + src[k].trim();
    if (DB.test(stmt)) hits.push(i + 1);
  }
  return notExempt(src, hits);
}

// SHAPE B (7c 2026-11-20, from websiteService.getWebsite): the error IS read, then answered with an ABSENCE value,
// so a failure still reads as "nothing there". Absence = null / undefined / [] / {} / false / 0 / '' (or a bare return).
const ABSENCE = String.raw`(?:null|undefined|\[\s*\]|\{\s*\}|false|0|''|""|)`;
const RETURN_ABSENCE = new RegExp(String.raw`^\s*return\s*` + ABSENCE + String.raw`\s*;?\s*(?:\/\/.*)?$`);
const RETURN_ABSENCE_INLINE = new RegExp(String.raw`\breturn\s*` + ABSENCE + String.raw`\s*;?\s*\}?\s*(?:\/\/.*)?$`);
// `if (error)`, `if (r.error)`, `if (error || !data)`, `if (res.error || ...)` - NOT `if (!error)`.
const IF_ERROR = /\bif\s*\(\s*(?:\w+\.)?error\b(?:\s*(?:\|\||&&)[^)]*)?\)\s*(\{)?\s*(.*)$/;

/** The next statement lines of a block opened at line i (skips logging), up to `n` lines or the closing brace. */
function blockReturnsAbsence(src, i, n) {
  for (let k = i + 1; k < Math.min(src.length, i + 1 + n); k++) {
    const l = src[k];
    if (/\bthrow\b/.test(l)) return false;
    // The block already ANSWERED the HTTP request (e.g. res.status(503).json(...)); the trailing `return null` is the
    // guard's "response sent" convention, not an absence answer (false positive found on TenantGuard.ts:672, 2026-11-20).
    if (/\bres\.(status|json|send|end|writeHead)\s*\(/.test(l)) return false;
    if (RETURN_ABSENCE.test(l)) return true;
    if (/^\s*\}/.test(l)) return false;
    if (/\breturn\b/.test(l)) return false; // returns something real (a result object, a Response, a typed error)
    // anything else (logging, metrics, state) is skipped: what decides the shape is how the block ANSWERS
  }
  return false;
}

/**
 * SHAPE C (c6/7c 2026-11-20, from companyMatchService.findMatchingCompany): the error IS tested, and the branch
 * neither refuses (throw / return) nor answers - it logs and FALLS THROUGH, so the code continues as if the read
 * had answered. `if (error) { logger.warn(...) }` / `if (error) console.error(...)`.
 */
function scanSourceC(text) {
  const src = text.split('\n');
  const hits = [];
  for (let i = 0; i < src.length; i++) {
    const m = src[i].match(IF_ERROR);
    if (!m) continue;
    if (!DB.test(src.slice(Math.max(0, i - 15), i + 1).join(' '))) continue;
    const rest = (m[2] || '').trim();
    if (!m[1]) {
      // single statement on the same line: a call that is not throw / return / break / continue
      if (rest && !/\b(throw|return|break|continue)\b/.test(rest) && /^[\w.$]+\s*\(/.test(rest)) hits.push(i + 1);
      continue;
    }
    // a block: walk to its closing brace; a refusal anywhere at the block's own depth means it is not shape C
    let depth = 1, refuses = /\b(throw|return|break|continue)\b/.test(rest), k = i;
    depth += (rest.match(/\{/g) || []).length - (rest.match(/\}/g) || []).length;
    while (depth > 0 && ++k < Math.min(src.length, i + 40)) {
      if (depth === 1 && /^\s*\}\s*else\b/.test(src[k])) { refuses = true; break; } // if/else: the data path is guarded
      if (/\b(throw|return|break|continue)\b/.test(src[k])) refuses = true;
      depth += (src[k].match(/\{/g) || []).length - (src[k].match(/\}/g) || []).length;
    }
    if (depth <= 0 && !refuses && !/\belse\b/.test(src[k] || '')) hits.push(i + 1);
  }
  return notExempt(src, hits);
}

/** SHAPE B - instances in one source text: an error that is tested and then answered with an absence value. */
function scanSourceB(text) {
  const src = text.split('\n');
  const hits = [];
  for (let i = 0; i < src.length; i++) {
    const m = src[i].match(IF_ERROR);
    if (m) {
      if (!DB.test(src.slice(Math.max(0, i - 15), i + 1).join(' '))) continue; // not a DB read's error
      const rest = m[2] || '';
      if (RETURN_ABSENCE_INLINE.test(rest) && !/\bthrow\b/.test(rest)) { hits.push(i + 1); continue; }
      if (m[1] === '{' && rest.trim() === '' && blockReturnsAbsence(src, i, 6)) { hits.push(i + 1); continue; }
      if (!m[1] && rest.trim() === '' && i + 1 < src.length && RETURN_ABSENCE.test(src[i + 1])) { hits.push(i + 1); continue; }
      continue;
    }
    // `catch { return null }` around a DB read: the catch answers absence and its try block contains a DB call.
    const c = src[i].match(/\bcatch\s*(?:\(\s*\w*\s*\))?\s*\{\s*(.*)$/);
    if (!c) continue;
    const absent = RETURN_ABSENCE_INLINE.test(c[1]) || (c[1].trim() === '' && blockReturnsAbsence(src, i, 6));
    if (!absent) continue;
    let depth = 0, tryAt = -1;
    for (let k = i; k >= Math.max(0, i - 60); k--) {
      const l = src[k];
      depth += (l.match(/\}/g) || []).length - (l.match(/\{/g) || []).length;
      if (/\btry\s*\{/.test(l) && depth <= 1) { tryAt = k; break; }
    }
    if (tryAt >= 0 && DB.test(src.slice(tryAt, i).join('\n'))) hits.push(i + 1);
  }
  return notExempt(src, hits);
}

function countAll(root) {
  const counts = {}; // file -> { A, B }
  for (const s of SCOPES) {
    for (const abs of walk(path.join(root, s), [])) {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (EXCLUDE.test(rel)) continue;
      const text = fs.readFileSync(abs, 'utf8');
      const a = scanSource(text).length, b = scanSourceB(text).length, c = scanSourceC(text).length; // after exemptions
      if (a || b || c) counts[rel] = { A: a, B: b, C: c };
    }
  }
  return counts;
}

function main() {
  const counts = countAll(ROOT);
  const tot = (m, k) => Object.values(m).reduce((n, v) => n + ((v && v[k]) || 0), 0);
  const files = Object.keys(counts).length;
  if (files === 0) { console.error('dropped-error gate: scanned 0 instances - refusing a vacuous pass (wrong --root?)'); process.exit(2); }
  if (WRITE) {
    const sorted = Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]]));
    fs.writeFileSync(BASELINE, JSON.stringify({ _comment: 'Dropped-error reads allowed per file and SHAPE (reduce-only). A = { data } without error; B = error tested then answered with an absence value; C = error tested, the branch neither refuses nor answers (falls through). Generated by scripts/check-dropped-supabase-error.js --write-baseline; review: entries may only go DOWN.', totalA: tot(counts, 'A'), totalB: tot(counts, 'B'), totalC: tot(counts, 'C'), files: sorted }, null, 2) + '\n');
    console.log(`dropped-error baseline written: shape A ${tot(counts, 'A')}, shape B ${tot(counts, 'B')}, shape C ${tot(counts, 'C')}, in ${files} file(s)`);
    return;
  }
  let base;
  try { base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).files || {}; } catch (e) { console.error(`dropped-error gate: cannot read baseline ${BASELINE}: ${e.message}`); process.exit(2); }
  const over = [], reduced = [];
  for (const f of new Set([...Object.keys(counts), ...Object.keys(base)])) {
    for (const k of ['A', 'B', 'C']) {
      const n = (counts[f] && counts[f][k]) || 0, was = (base[f] && base[f][k]) || 0;
      if (n > was) over.push(`${f} [shape ${k}]: ${n} (baseline ${was})`);
      else if (n < was) reduced.push(`${f} [shape ${k}]: ${n} (baseline ${was})`);
    }
  }
  console.log(`dropped-error gate: shape A ${tot(counts, 'A')}, shape B ${tot(counts, 'B')}, shape C ${tot(counts, 'C')} in ${files} file(s); baseline A ${tot(base, 'A')}, B ${tot(base, 'B')}, C ${tot(base, 'C')}`);
  console.log('COVERAGE: three shapes only (A, B, C). A clean file means "no instance of these shapes", not "no dropped errors".');
  if (reduced.length) { console.log(`REDUCED (lower the baseline in the fixing commit with --write-baseline): ${reduced.length}`); for (const r of reduced.slice(0, 30)) console.log('  ' + r); }
  if (over.length) {
    console.log(`NEW dropped-error read(s): handle the error honestly (a failure must never read as an empty answer): ${over.length}`);
    for (const o of over) console.log('  ' + o);
    process.exit(1);
  }
  console.log('PASS: no new dropped-error reads');
}

if (require.main === module) main();
module.exports = { scanSource, scanSourceB, scanSourceC, countAll };
