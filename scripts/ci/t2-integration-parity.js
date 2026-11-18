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
 * Quarantine (--quarantine <file>, lines `backend/tests/integration/<file> # expires=YYYY-MM-DD owner=<who> <reason>`):
 * a regression of a quarantined suite is REPORTED, not failed, until its expiry; an entry without expires= or owner=,
 * or past its expiry, FAILS the gate (a flaky suite gets a dated escape hatch, never a permanent one).
 * ERRORED = ran, assertions passed, but the suite failed (afterAll/teardown error): labelled apart from NOT-RUN.
 * Usage: t2-integration-parity.js --head <json> --base <json> [--ack <file>] [--quarantine <file>] [--min-suites N]
 */
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? acc.concat([[a.slice(2), arr[i + 1]]]) : acc), []));
const minSuites = Number(args['min-suites'] || 100);

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
    else if (passed > 0 && r.status === 'failed') status = 'ERRORED';
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

const quarantine = new Map();
const quarantineErrors = [];
if (args.quarantine && fs.existsSync(args.quarantine)) {
  const today = new Date().toISOString().slice(0, 10);
  for (const line of fs.readFileSync(args.quarantine, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(\S+)\s*#(.*)$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const exp = /expires=(\d{4}-\d{2}-\d{2})/.exec(m[2]); const own = /owner=(\S+)/.exec(m[2]);
    if (!exp || !own) { quarantineErrors.push(`quarantine entry without expires= and owner=: ${m[1]}`); continue; }
    if (exp[1] < today) { quarantineErrors.push(`quarantine EXPIRED ${exp[1]} (owner ${own[1]}): ${m[1]}`); continue; }
    quarantine.set(m[1], { expires: exp[1], owner: own[1] });
  }
}
const head = load(args.head);
const base = load(args.base);
const bad = [];
const info = [];
const flag = (name, msg) => { const q = quarantine.get(name); if (q) info.push(`QUARANTINED (owner ${q.owner}, expires ${q.expires}): ${msg}`); else bad.push(msg); };
for (const [name, b] of base) {
  const h = head.get(name);
  if (!h) { if (acks.has(name)) info.push(`REMOVED (acknowledged) ${name}`); else bad.push(`REMOVED (not acknowledged) ${name}`); continue; }
  if (b.status === 'PASS' && h.status !== 'PASS') flag(name, `${h.status} on head, PASS on base: ${name} (${h.failed} failed / ${h.total})${h.msg ? ' :: ' + h.msg : ''}`);
  else if (b.status === 'FAIL' && h.status === 'FAIL' && h.failed > b.failed) flag(name, `MORE failures on head: ${name} (${b.failed} -> ${h.failed})`);
  else if (b.status === 'FAIL' && h.status === 'NOT-RUN') flag(name, `NOT-RUN on head, ran (red) on base: ${name}${h.msg ? ' :: ' + h.msg : ''}`);
  else if (b.status === 'NOT-RUN' && (h.status === 'FAIL' || h.status === 'ERRORED')) info.push(`now RUNS and is RED (was NOT-RUN at base): ${name} (${h.failed} failed / ${h.total})`);
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
for (const e of quarantineErrors) bad.push(e);
for (const [q] of quarantine) if (!head.has(q) && !base.has(q)) info.push(`STALE quarantine (suite in neither run): ${q}`);
if (ran < minSuites) bad.push(`only ${ran} integration suites RAN on head (< ${minSuites}): the job did not really run`);
if (bad.length) {
  console.log(`\nINTEGRATION PARITY FAILED (${bad.length}):`);
  for (const l of bad) console.log('  ' + l);
  process.exit(1);
}
console.log('\nINTEGRATION PARITY: OK (no suite regressed, stopped running or disappeared vs base)');
