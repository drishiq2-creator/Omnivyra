#!/usr/bin/env node
/**
 * T2 integration parity: backend/tests/integration, HEAD vs BASE, judged by SUITE (not test name).
 *
 * Why by suite: until 2026-11-18 every one of these 133 suites refused to start in CI (non-local SUPABASE_URL)
 * and produced no test names, so the by-name parity gate could not see them; a guard that broke 7 of them stayed
 * green (cb finding, owner rule "every finding fixed"). A suite that fails to start emits no names, so it must be
 * counted as a suite.
 *
 * Per suite, status is PASS (ran, >= 1 passed, 0 failed), FAIL (ran, >= 1 failed), NOT-RUN (failed to start:
 * 0 assertions; or every test skipped; or absent from the run). NOT-RUN is never evidence of a pass.
 *
 * Verdict (exit 1 on any):
 *   - a suite PASS on base and FAIL or NOT-RUN on head  (regression / guard broken / suite stopped running);
 *   - a suite FAIL on both whose failing-test count GREW on head;
 *   - a suite present on base and missing on head, unless acknowledged in --ack (`suite # reason`);
 *   - fewer than --min-suites suites ran (PASS or FAIL) on head (the job itself did not run: never a pass).
 * Reported, not failing: suites red on BOTH sides with the same or fewer failures (known red at base), suites NEW
 * on head, suites fixed on head.
 * Usage: t2-integration-parity.js --head <json> --base <json> [--ack <file>] [--min-suites N]
 */
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? acc.concat([[a.slice(2), arr[i + 1]]]) : acc), []));
const minSuites = Number(args['min-suites'] || 50);

function load(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const m = new Map();
  for (const r of j.testResults || []) {
    const name = path.relative(process.cwd(), r.name).split(path.sep).join('/').replace(/^.*?(backend\/tests\/integration\/)/, '$1');
    const a = r.assertionResults || [];
    const failed = a.filter((x) => x.status === 'failed').length;
    const passed = a.filter((x) => x.status === 'passed').length;
    let status;
    if (failed > 0) status = 'FAIL';
    else if (passed > 0 && r.status === 'passed') status = 'PASS';
    else status = 'NOT-RUN';
    const msg = String(r.message || '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 2).join(' | ').slice(0, 160);
    m.set(name, { status, failed, passed, total: a.length, msg });
  }
  return m;
}

const acks = new Set();
if (args.ack && fs.existsSync(args.ack)) {
  for (const line of fs.readFileSync(args.ack, 'utf8').split(/\r?\n/)) {
    const s = line.replace(/#.*$/, '').trim();
    if (s) acks.add(s);
  }
}

const head = load(args.head);
const base = load(args.base);
const bad = [];
const info = [];
for (const [name, b] of base) {
  const h = head.get(name);
  if (!h) { if (acks.has(name)) info.push(`REMOVED (acknowledged) ${name}`); else bad.push(`REMOVED (not acknowledged) ${name}`); continue; }
  if (b.status === 'PASS' && h.status !== 'PASS') bad.push(`${h.status} on head, PASS on base: ${name} (${h.failed} failed / ${h.total})${h.msg ? ' :: ' + h.msg : ''}`);
  else if (b.status === 'FAIL' && h.status === 'FAIL' && h.failed > b.failed) bad.push(`MORE failures on head: ${name} (${b.failed} -> ${h.failed})`);
  else if (b.status === 'FAIL' && h.status === 'NOT-RUN') bad.push(`NOT-RUN on head, ran (red) on base: ${name}${h.msg ? ' :: ' + h.msg : ''}`);
  else if (b.status !== 'PASS' && h.status === 'PASS') info.push(`FIXED on head: ${name}`);
  else if (b.status === 'FAIL') info.push(`known red at base (unchanged or better): ${name} (${b.failed} -> ${h.failed})`);
  else if (b.status === 'NOT-RUN' && h.status === 'NOT-RUN') info.push(`NOT-RUN on both: ${name}`);
}
for (const [name, h] of head) if (!base.has(name)) {
  if (h.status === 'PASS') info.push(`NEW on head: ${name} (${h.passed} passed)`);
  else bad.push(`NEW on head and ${h.status}: ${name}${h.msg ? ' :: ' + h.msg : ''}`);
}

const ran = [...head.values()].filter((v) => v.status !== 'NOT-RUN').length;
const count = (m, s) => [...m.values()].filter((v) => v.status === s).length;
console.log(JSON.stringify({ event: 't2.integration_parity', head_suites: head.size, base_suites: base.size, head_ran: ran,
  head: { pass: count(head, 'PASS'), fail: count(head, 'FAIL'), not_run: count(head, 'NOT-RUN') },
  base: { pass: count(base, 'PASS'), fail: count(base, 'FAIL'), not_run: count(base, 'NOT-RUN') }, violations: bad.length }));
for (const l of info.sort()) console.log('  ' + l);
if (ran < minSuites) bad.push(`only ${ran} integration suites RAN on head (< ${minSuites}): the job did not really run`);
if (bad.length) {
  console.log(`\nINTEGRATION PARITY FAILED (${bad.length}):`);
  for (const l of bad) console.log('  ' + l);
  process.exit(1);
}
console.log('\nINTEGRATION PARITY: OK (no suite regressed, stopped running or disappeared vs base)');
