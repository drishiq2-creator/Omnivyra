#!/usr/bin/env node
/**
 * No-raw-db-push gate (b3/owner, 2026-11-21).
 *
 * Production holds 38+ migration versions applied by owner-approved runners WITHOUT ledger rows
 * (release-gates/APPLIED-WITHOUT-LEDGER.md), and the repo has duplicate version prefixes, so `supabase db push` /
 * `supabase migration up` against production would re-run applied files or skip unapplied ones.
 * The ONLY sanctioned invocation is scripts/operator/db/db-push.sh, which refuses target-env=production outright and
 * runs scripts/guard-no-prod-push.sh (which resolves the LINKED project too). This gate fails if any script, workflow,
 * or package.json script invokes the CLI directly, so nobody adds a path that skips the guard.
 *
 * REACH (what is scanned): package.json "scripts"; scripts/**, backend/scripts/** and tools/** (sh, js, mjs, cjs, ts);
 * .github/workflows/** (yml/yaml); repo-root *.sh and Dockerfile* (RUN lines). 7c 2026-11-21: backend/scripts/ (19
 * operational scripts) and tools/ were outside the first version, which is exactly where someone would add one.
 * NOT SCANNED (named so the gap is visible): any other directory (app code under backend/services, pages, lib, worker,
 * src: runtime code has no business invoking the Supabase CLI), docs/markdown, and node_modules. If a new location for
 * operational scripts appears, add it to WALK below.
 * Comment lines (#, //, *) are ignored, so documentation of the hazard is allowed.
 * Limit: a command assembled at runtime from fragments is invisible to a text scan.
 * Exit: 0 clean; 1 violation(s); 2 nothing scanned (refuses a vacuous pass).
 */
const fs = require('fs');
const path = require('path');

const root = (() => { const i = process.argv.indexOf('--root'); return i > 0 ? path.resolve(process.argv[i + 1]) : process.cwd(); })();
const SANCTIONED = new Set(['scripts/operator/db/db-push.sh', 'scripts/ci/check-no-raw-db-push.js']);
// The CLI verb, optionally via npx / pnpm dlx / yarn.
const CLI = String.raw`(?:(?:npx|pnpm\s+dlx|yarn)\s+)?supabase\s+(?:db\s+push|migration\s+up)\b`;
// An INVOCATION, not a mention: per file type (messages and warnings that name the command are not invocations).
const SHELL_CMD = new RegExp(String.raw`(?:^|&&|\|\||;|\$\(|\brun:\s*|\bexec\s+|^RUN\s+)\s*` + CLI); // sh / yml / npm / Dockerfile
const JS_EXEC = new RegExp(String.raw`\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|execa)\s*\(\s*[\x60'"]\s*` + CLI);
const JS_ARGV = /\b(?:spawn|spawnSync|execFile|execFileSync|execa)\s*\(\s*['"](?:npx|supabase)['"]\s*,\s*\[[^\]]*['"](?:db|migration)['"]\s*,\s*['"](?:push|up)['"]/;
const COMMENT = /^\s*(#|\/\/|\*|\/\*)/;

const hits = [];
let scanned = 0;
const scanText = (rel, text) => {
  scanned++;
  if (SANCTIONED.has(rel)) return;
  const js = /\.(js|mjs|cjs|ts)$/.test(rel);
  text.split(/\r?\n/).forEach((line, i) => {
    if (COMMENT.test(line)) return;
    const hit = js ? (JS_EXEC.test(line) || JS_ARGV.test(line)) : SHELL_CMD.test(line.trim());
    if (hit) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
  });
};
const walk = (dir, exts) => {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel, exts); continue; }
    if (exts.test(e.name)) scanText(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
  }
};

const pkgPath = path.join(root, 'package.json');
if (fs.existsSync(pkgPath)) {
  const scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts || {};
  scanned++;
  for (const [name, cmd] of Object.entries(scripts)) if (SHELL_CMD.test(cmd.trim())) hits.push(`package.json scripts.${name}: ${cmd}`);
}
const WALK = [['scripts', /\.(sh|js|mjs|cjs|ts)$/], ['backend/scripts', /\.(sh|js|mjs|cjs|ts)$/], ['tools', /\.(sh|js|mjs|cjs|ts)$/],
  ['.github/workflows', /\.ya?ml$/]];
for (const [d, re] of WALK) walk(d, re);
// Repo-root shell scripts and Dockerfiles (not recursive).
for (const e of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
  if (e.isFile() && (/\.sh$/.test(e.name) || /^Dockerfile/.test(e.name))) scanText(e.name, fs.readFileSync(path.join(root, e.name), 'utf8'));
}

if (scanned === 0) { console.log('no-raw-db-push: NOTHING SCANNED - refusing a vacuous pass'); process.exit(2); }
if (hits.length) {
  console.log(`no-raw-db-push: FAIL - ${hits.length} direct supabase db push / migration up invocation(s) outside the guarded wrapper:`);
  for (const h of hits) console.log('  ' + h);
  console.log('Use `npm run db:push -- --target-env=local|staging --apply` (scripts/operator/db/db-push.sh). Production is never a db push target.');
  process.exit(1);
}
console.log(`no-raw-db-push: PASS (${scanned} files scanned; only the guarded wrapper invokes the CLI)`);
