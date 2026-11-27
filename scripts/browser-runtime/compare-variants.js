#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * Reads the lifecycle-soak JSON summaries written by the CI matrix and states
 * the two hypotheses' verdicts. Usage: node compare-variants.js <dir>
 *
 * REQUIRED (production-shaped, must pass or this exits 1):
 *   tini          image ENTRYPOINT (tini is PID 1) - the shipped configuration
 *   docker-init   docker --init (docker-init is PID 1)
 *   shm-small     --shm-size=16m with the launcher's default args (--disable-dev-shm-usage)
 * EXPERIMENTS (reported, never fail the job - a failure there is the evidence):
 *   no-init       node is PID 1 (the configuration before this change)
 *   shm-small-noflag  --shm-size=16m WITHOUT --disable-dev-shm-usage
 */
const fs = require('fs');
const path = require('path');

const REQUIRED = ['tini', 'docker-init', 'shm-small'];

function load(dir, variant) {
  const f = path.join(dir, `${variant}.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function failedChecks(s) {
  return s ? (s.checks || []).filter((c) => !c.ok).map((c) => `${c.scenario}: ${c.name}`) : ['summary missing'];
}

function main() {
  const dir = process.argv[2] || '.';
  const v = {};
  for (const name of [...REQUIRED, 'no-init', 'shm-small-noflag']) v[name] = load(dir, name);

  const required = REQUIRED.map((name) => ({
    variant: name,
    present: Boolean(v[name]),
    ok: Boolean(v[name] && v[name].ok),
    pid1: v[name] && v[name].env ? v[name].env.pid1 : null,
    zombie_growth: v[name] ? v[name].zombie_growth : null,
    failed: v[name] && v[name].ok ? [] : failedChecks(v[name]),
  }));

  const noInit = v['no-init'];
  const tini = v.tini;
  let pid1 = 'INCONCLUSIVE (a summary is missing)';
  if (noInit && tini && !noInit.harness_error && !tini.harness_error) {
    if (noInit.zombie_growth > 0 && tini.zombie_growth === 0) pid1 = 'CONFIRMED: zombies accumulate with node as PID 1 and not under tini';
    else if (noInit.zombie_growth === 0) pid1 = 'NOT REPRODUCED: no zombie growth with node as PID 1 in this run';
    else pid1 = 'MIXED: zombies grew under tini too';
  }

  const noflag = v['shm-small-noflag'];
  const flag = v['shm-small'];
  let shm = 'INCONCLUSIVE (a summary is missing)';
  if (noflag && flag) {
    if (!noflag.ok && flag.ok) shm = 'CONFIRMED: 16m /dev/shm fails without --disable-dev-shm-usage and passes with it';
    else if (noflag.ok && flag.ok) shm = 'NOT REPRODUCED: 16m /dev/shm passed even without --disable-dev-shm-usage';
    else shm = 'MIXED: the run with --disable-dev-shm-usage failed too';
  }

  const verdict = {
    required,
    required_ok: required.every((r) => r.present && r.ok),
    pid1_hypothesis: pid1,
    pid1_evidence: {
      no_init: noInit && { pid1: noInit.env && noInit.env.pid1, zombie_growth: noInit.zombie_growth, chromium_zombie_growth: noInit.chromium_zombie_growth, ok: noInit.ok },
      tini: tini && { pid1: tini.env && tini.env.pid1, zombie_growth: tini.zombie_growth, chromium_zombie_growth: tini.chromium_zombie_growth, ok: tini.ok },
    },
    shm_hypothesis: shm,
    shm_evidence: {
      with_flag: flag && { ok: flag.ok, failed: failedChecks(flag).slice(0, 5) },
      without_flag: noflag && { ok: noflag.ok, failed: noflag.ok ? [] : failedChecks(noflag).slice(0, 5) },
    },
  };
  const json = JSON.stringify(verdict, null, 2);
  fs.writeFileSync(path.join(dir, 'ab-verdict.json'), json);
  console.log(json);
  process.exit(verdict.required_ok ? 0 : 1);
}

main();
