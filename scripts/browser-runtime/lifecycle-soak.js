#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * Synthetic Chromium lifecycle soak for the worker image (Dockerfile.worker).
 *
 * Plain node, no build step: run it INSIDE the built image with the repo's
 * scripts/browser-runtime directory mounted, cwd /app, so `playwright` and the
 * compiled launcher (dist/backend/services/browserRuntime/browserLauncher.js)
 * resolve exactly as they do for the worker:
 *
 *   docker run --rm --network none -v "$PWD/scripts/browser-runtime:/harness:ro" \
 *     -v "$PWD/out:/out" <image> node /harness/lifecycle-soak.js --variant=tini --out=/out/tini.json
 *
 * NETWORK: every page is served by this process on 127.0.0.1. Three independent
 * guards keep Chromium off any real network: (1) a dead proxy
 * (--proxy-server=127.0.0.1:9, bypass only 127.0.0.1); (2) a context.route
 * allowlist that aborts every request whose host is not 127.0.0.1; (3) CI runs
 * the container with --network none. The `network` scenario is the red control:
 * it proves (1) and (2) each block a request to a reserved `.invalid` name
 * (RFC 6761: can never resolve), and that the positive 127.0.0.1 load works.
 *
 * SCENARIOS (--scenarios=a,b,...; default all):
 *   network     positive + red controls for the guards above
 *   sequential  N launch/context/page/goto/close cycles (--cycles, default 200)
 *   concurrent  K parallel launches per round (--concurrency=3,8 --rounds=3)
 *   contexts    one browser, M contexts opened/closed (--contexts=30): no context leak
 *   crash       SIGKILL the browser process mid-run (--crashes=5), next launch must work
 *   shutdown    child node process with an open browser gets SIGTERM; no orphan may remain
 *
 * MEASURED per cycle (from /proc, Linux only): live chromium processes, zombie
 * (state Z) processes, total tasks (threads - what --pids-limit counts), chromium
 * RSS, node RSS, /dev/shm bytes used. PID 1's name is recorded, so an A/B of
 * "node is PID 1" (no init) vs tini / docker --init shows whether orphaned
 * Chromium children accumulate as zombies.
 *
 * EXIT: 0 all checks passed; 1 a check failed (leak, zombie growth, failure);
 * 2 the harness itself could not run. A JSON summary goes to stdout and --out.
 *
 * Options: --variant=<label> --out=<file> --zombie-tolerance=0 --heavy (large
 * page + full-page screenshot, for the /dev/shm run) --drop-arg=<switch>
 * (launch WITHOUT one of the launcher's default switches, e.g.
 * --drop-arg=--disable-dev-shm-usage; uses the raw launch path) --selftest.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BLOCKED_URL = 'http://blocked.invalid/';
const DEAD_PROXY = { server: 'http://127.0.0.1:9', bypass: '127.0.0.1' };
const CHROMIUM_COMMS = new Set(['chrome', 'headless_shell', 'chrome_crashpad', 'chrome_crashpa', 'chromium']);

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const k = m[1];
    const v = m[2] === undefined ? true : m[2];
    if (k === 'drop-arg') (o.dropArgs = o.dropArgs || []).push(v);
    else o[k] = v;
  }
  return o;
}
const intOpt = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── /proc sampling ───────────────────────────────────────────────────────────
/** Parse /proc/<pid>/stat: comm may contain spaces/parens, so split at the LAST ')'. */
function parseStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const rest = text.slice(close + 2).split(' ');
  return { pid: Number(text.slice(0, open).trim()), comm: text.slice(open + 1, close), state: rest[0], ppid: Number(rest[1]) };
}
function parseStatusField(text, field) {
  const m = new RegExp(`^${field}:\\s+(\\d+)`, 'm').exec(text);
  return m ? Number(m[1]) : 0;
}
function isChromium(comm, cmd0) {
  return CHROMIUM_COMMS.has(comm) || /chrom|headless_shell/i.test(cmd0 || '');
}
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function scanProcs(procRoot = '/proc') {
  const out = { processes: 0, tasks: 0, zombies: 0, zombieComms: {}, chromiumLive: 0, chromiumZombie: 0, chromiumRssKb: 0, procs: [] };
  let names = [];
  try { names = fs.readdirSync(procRoot); } catch { return out; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const st = readText(path.join(procRoot, name, 'stat'));
    const parsed = st && parseStat(st);
    if (!parsed) continue;
    const status = readText(path.join(procRoot, name, 'status')) || '';
    const cmd0 = (readText(path.join(procRoot, name, 'cmdline')) || '').split('\0')[0];
    out.processes += 1;
    out.tasks += parseStatusField(status, 'Threads') || 1;
    const chromium = isChromium(parsed.comm, cmd0);
    if (parsed.state === 'Z') {
      out.zombies += 1;
      out.zombieComms[parsed.comm] = (out.zombieComms[parsed.comm] || 0) + 1;
      if (chromium) out.chromiumZombie += 1;
    } else if (chromium) {
      out.chromiumLive += 1;
      out.chromiumRssKb += parseStatusField(status, 'VmRSS');
    }
    out.procs.push({ pid: parsed.pid, ppid: parsed.ppid, comm: parsed.comm, state: parsed.state, chromium });
  }
  return out;
}
function shmUsedBytes() {
  try {
    const s = fs.statfsSync('/dev/shm');
    return (s.blocks - s.bfree) * s.bsize;
  } catch { return null; }
}
function sample(label) {
  const p = scanProcs();
  return {
    label,
    t: Date.now(),
    chromium_live: p.chromiumLive,
    chromium_zombie: p.chromiumZombie,
    zombies: p.zombies,
    tasks: p.tasks,
    processes: p.processes,
    chromium_rss_kb: p.chromiumRssKb,
    node_rss_kb: Math.round(process.memoryUsage().rss / 1024),
    shm_used_bytes: shmUsedBytes(),
  };
}
/** Direct chromium children of this process (the browser main process(es)). */
function childBrowserPids() {
  return scanProcs().procs.filter((p) => p.chromium && p.ppid === process.pid && p.state !== 'Z').map((p) => p.pid);
}
function cgroupFacts() {
  const r = (f) => { const t = readText(f); return t == null ? null : t.trim(); };
  return {
    pid1: r('/proc/1/comm'),
    pids_max: r('/sys/fs/cgroup/pids.max'),
    pids_current: r('/sys/fs/cgroup/pids.current'),
    memory_max: r('/sys/fs/cgroup/memory.max'),
    shm_total_bytes: (() => { try { const s = fs.statfsSync('/dev/shm'); return s.blocks * s.bsize; } catch { return null; } })(),
  };
}

// ── loopback guard ──────────────────────────────────────────────────────────
function isLoopbackUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname === '127.0.0.1';
  } catch { return false; }
}
function assertGotoAllowed(url) {
  if (isLoopbackUrl(url) || url === 'about:blank' || url.startsWith('data:')) return;
  if (url === BLOCKED_URL) return; // red control only: reserved name, never resolvable
  throw new Error(`HARNESS_REFUSES_NON_LOOPBACK_URL ${url}`);
}

// ── synthetic site ──────────────────────────────────────────────────────────
function startServer() {
  const hits = { total: 0, byPath: {} };
  const server = http.createServer((req, res) => {
    hits.total += 1;
    hits.byPath[req.url] = (hits.byPath[req.url] || 0) + 1;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/heavy') {
      res.end(`<!doctype html><title>heavy</title><body style="margin:0">
<canvas id="c" width="4000" height="4000"></canvas>
${'<div style="height:200px;background:linear-gradient(90deg,#123,#abc)">row</div>'.repeat(60)}
<script>const g=document.getElementById('c').getContext('2d');for(let i=0;i<400;i++){g.fillStyle='hsl('+i+',70%,50%)';g.fillRect((i*37)%4000,(i*91)%4000,600,600);}document.title='heavy-ok';</script></body>`);
      return;
    }
    if (req.url === '/external') {
      res.end(`<!doctype html><title>external</title><img src="${BLOCKED_URL}pixel.png"><script>document.title='external-ok'</script>`);
      return;
    }
    res.end(`<!doctype html><title>soak</title><ul>${'<li>item</li>'.repeat(200)}</ul><script>document.title='soak-ok'</script>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// ── browser plumbing ────────────────────────────────────────────────────────
function loadRuntime(opts) {
  const appRoot = process.env.APP_ROOT || process.cwd();
  const pw = require(require.resolve('playwright', { paths: [appRoot, __dirname] }));
  let launcher = null;
  const launcherPath = path.join(appRoot, 'dist/backend/services/browserRuntime/browserLauncher.js');
  if (opts.launcher !== 'raw' && fs.existsSync(launcherPath)) launcher = require(launcherPath);
  if (opts.launcher === 'dist' && !launcher) throw new Error(`launcher not found at ${launcherPath}`);
  let pwVersion = null;
  try { pwVersion = require(require.resolve('playwright/package.json', { paths: [appRoot, __dirname] })).version; } catch { /* ignore */ }
  return { pw, launcher, pwVersion };
}

function makeBrowserApi(rt, opts) {
  const drop = opts.dropArgs || [];
  const raw = drop.length > 0 || !rt.launcher;
  return {
    mode: raw ? 'raw' : 'launcher',
    async open() {
      if (!raw) return rt.launcher.launchBrowser({ purpose: 'soak', playwright: rt.pw, proxy: DEAD_PROXY, timeoutMs: 30_000 });
      const base = rt.launcher
        ? rt.launcher.buildLaunchOptions(`raw-${process.pid}-${Date.now()}`, { proxy: DEAD_PROXY, timeoutMs: 30_000 })
        : { headless: true, chromiumSandbox: false, timeout: 30_000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
            args: ['--disable-dev-shm-usage', '--disable-gpu'], proxy: DEAD_PROXY };
      return rt.pw.chromium.launch({ ...base, args: base.args.filter((a) => !drop.includes(a)) });
    },
    async release(t) {
      if (rt.launcher) return rt.launcher.releaseBrowserResources(t, 10_000);
      for (const k of ['page', 'context', 'browser']) { try { if (t[k]) await t[k].close(); } catch { /* counted by caller */ } }
      return null;
    },
    openCount() { return rt.launcher ? rt.launcher.openBrowserCount() : null; },
  };
}

async function guardedContext(browser, counters) {
  const context = await browser.newContext();
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (isLoopbackUrl(url)) return route.continue();
    counters.blocked += 1;
    return route.abort('blockedbyclient');
  });
  return context;
}

async function goto(page, url, opts = {}) {
  assertGotoAllowed(url);
  return page.goto(url, { waitUntil: 'load', timeout: 30_000, ...opts });
}

async function oneCycle(api, site, counters, heavy) {
  let browser = null; let context = null; let page = null;
  try {
    browser = await api.open();
    context = await guardedContext(browser, counters);
    page = await context.newPage();
    await goto(page, `${site.base}${heavy ? '/heavy' : '/'}`);
    const title = await page.title();
    const want = heavy ? 'heavy-ok' : 'soak-ok';
    if (title !== want) throw new Error(`unexpected title ${title}`);
    if (heavy) await page.screenshot({ fullPage: true });
  } finally {
    await api.release({ page, context, browser });
  }
}

// ── scenarios ───────────────────────────────────────────────────────────────
function check(results, name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); }

function endStateChecks(results, prefix, baseline, final, api, tol) {
  check(results, `${prefix}: no live chromium left`, final.chromium_live <= baseline.chromium_live,
    { baseline: baseline.chromium_live, final: final.chromium_live });
  check(results, `${prefix}: zombie growth <= ${tol}`, final.zombies - baseline.zombies <= tol,
    { baseline: baseline.zombies, final: final.zombies });
  const open = api.openCount();
  if (open !== null) check(results, `${prefix}: launcher registry empty`, open === 0, { open });
}

async function scenarioNetwork(api, site, ctx) {
  const results = [];
  const counters = { blocked: 0 };
  let browser = null; let context = null; let page = null;
  try {
    browser = await api.open();
    context = await guardedContext(browser, counters);
    page = await context.newPage();
    const before = site.hits.total;
    await goto(page, `${site.base}/`);
    check(results, 'positive: 127.0.0.1 page loads', (await page.title()) === 'soak-ok' && site.hits.total > before, {});

    const blockedBefore = counters.blocked;
    let navErr = null;
    try { await goto(page, BLOCKED_URL, { timeout: 10_000 }); } catch (e) { navErr = String(e.message || e).split('\n')[0]; }
    check(results, 'red control: route allowlist aborts a non-loopback navigation', navErr !== null && counters.blocked > blockedBefore,
      { error: navErr, aborted: counters.blocked - blockedBefore });

    const subBefore = counters.blocked;
    await goto(page, `${site.base}/external`);
    await sleep(500);
    check(results, 'red control: route allowlist aborts a non-loopback subresource', counters.blocked > subBefore,
      { aborted: counters.blocked - subBefore });

    // Dead proxy alone (no route on this context): the request must still fail.
    const bare = await browser.newContext();
    const barePage = await bare.newPage();
    let proxyErr = null;
    try { await goto(barePage, BLOCKED_URL, { timeout: 10_000 }); } catch (e) { proxyErr = String(e.message || e).split('\n')[0]; }
    check(results, 'red control: dead proxy blocks a non-loopback request without the route', proxyErr !== null, { error: proxyErr });
    await bare.close().catch(() => undefined);
  } catch (e) {
    check(results, 'network scenario ran', false, { error: String(e.message || e).split('\n')[0] });
  } finally {
    await api.release({ page, context, browser });
  }
  ctx.samples.push(sample('network:end'));
  return results;
}

async function scenarioSequential(api, site, ctx) {
  const results = [];
  const counters = { blocked: 0 };
  const baseline = sample('sequential:baseline');
  const failures = [];
  const perCycle = [];
  for (let i = 0; i < ctx.cycles; i++) {
    const t0 = Date.now();
    try { await oneCycle(api, site, counters, ctx.heavy); } catch (e) { failures.push({ cycle: i, error: String(e.message || e).split('\n')[0] }); }
    const s = sample(`sequential:${i}`);
    s.cycle_ms = Date.now() - t0;
    perCycle.push(s);
  }
  await sleep(2000);
  const final = sample('sequential:final');
  check(results, `sequential: ${ctx.cycles} cycles without failure`, failures.length === 0, { failures: failures.slice(0, 10), failed: failures.length });
  endStateChecks(results, 'sequential', baseline, final, api, ctx.tol);
  const tasks = perCycle.map((s) => s.tasks);
  const half = Math.floor(perCycle.length / 2);
  return { results, metrics: { baseline, final, failed: failures.length,
    max_tasks: Math.max(...tasks, 0), first_half_max_zombies: Math.max(0, ...perCycle.slice(0, half).map((s) => s.zombies)),
    second_half_max_zombies: Math.max(0, ...perCycle.slice(half).map((s) => s.zombies)),
    max_shm_used_bytes: Math.max(0, ...perCycle.map((s) => s.shm_used_bytes || 0)),
    mean_cycle_ms: Math.round(perCycle.reduce((a, s) => a + s.cycle_ms, 0) / Math.max(1, perCycle.length)) },
  samples: perCycle };
}

async function scenarioConcurrent(api, site, ctx) {
  const results = [];
  const counters = { blocked: 0 };
  const baseline = sample('concurrent:baseline');
  const perLevel = {};
  for (const k of ctx.concurrency) {
    let failed = 0; let peak = 0;
    for (let r = 0; r < ctx.rounds; r++) {
      const runs = Array.from({ length: k }, () => oneCycle(api, site, counters, false).then(() => null, (e) => String(e.message || e).split('\n')[0]));
      const poll = setInterval(() => { peak = Math.max(peak, scanProcs().chromiumLive); }, 100);
      const errs = (await Promise.all(runs)).filter(Boolean);
      clearInterval(poll);
      failed += errs.length;
      if (errs.length) perLevel[`errors_${k}`] = errs.slice(0, 5);
    }
    perLevel[k] = { rounds: ctx.rounds, failed, peak_chromium_live: peak };
    check(results, `concurrent x${k}: ${ctx.rounds} rounds without failure`, failed === 0, perLevel[k]);
  }
  await sleep(2000);
  const final = sample('concurrent:final');
  endStateChecks(results, 'concurrent', baseline, final, api, ctx.tol);
  return { results, metrics: { baseline, final, perLevel } };
}

async function scenarioContexts(api, site, ctx) {
  const results = [];
  const counters = { blocked: 0 };
  const baseline = sample('contexts:baseline');
  let browser = null;
  try {
    browser = await api.open();
    const afterLaunch = scanProcs().chromiumLive;
    for (let i = 0; i < ctx.contexts; i++) {
      const c = await guardedContext(browser, counters);
      const p = await c.newPage();
      await goto(p, `${site.base}/`);
      await c.close();
    }
    await sleep(1500);
    const afterContexts = scanProcs().chromiumLive;
    check(results, 'contexts: browser reports zero open contexts', browser.contexts().length === 0, { open: browser.contexts().length });
    // A spare renderer may be kept warm; more than one extra process is a leak.
    check(results, 'contexts: chromium process count back to post-launch level', afterContexts <= afterLaunch + 1,
      { after_launch: afterLaunch, after_contexts: afterContexts });
  } catch (e) {
    check(results, 'contexts scenario ran', false, { error: String(e.message || e).split('\n')[0] });
  } finally {
    await api.release({ browser });
  }
  await sleep(1500);
  const final = sample('contexts:final');
  endStateChecks(results, 'contexts', baseline, final, api, ctx.tol);
  return { results, metrics: { baseline, final } };
}

async function scenarioCrash(api, site, ctx) {
  const results = [];
  const counters = { blocked: 0 };
  const baseline = sample('crash:baseline');
  const rounds = [];
  for (let i = 0; i < ctx.crashes; i++) {
    const round = { killed: null, disconnected: false, recovered: false };
    let browser = null;
    try {
      const before = new Set(childBrowserPids());
      browser = await api.open();
      const context = await guardedContext(browser, counters);
      const page = await context.newPage();
      await goto(page, `${site.base}/`);
      const pid = childBrowserPids().find((p) => !before.has(p));
      if (!pid) throw new Error('browser process not found');
      const gone = new Promise((r) => browser.once('disconnected', () => r(true)));
      process.kill(pid, 'SIGKILL'); // the main process only: its children are orphaned, as in a real crash
      round.killed = pid;
      round.disconnected = await Promise.race([gone, sleep(10_000).then(() => false)]);
      await api.release({ browser }); // must not throw or hang on a dead browser
      browser = null;
      await sleep(1000);
      round.after_kill = sample(`crash:${i}:after`);
      await oneCycle(api, site, counters, false); // next launch must work
      round.recovered = true;
    } catch (e) {
      round.error = String(e.message || e).split('\n')[0];
    } finally {
      if (browser) await api.release({ browser });
    }
    rounds.push(round);
  }
  await sleep(2000);
  const final = sample('crash:final');
  check(results, `crash: ${ctx.crashes} kills detected as disconnects`, rounds.every((r) => r.disconnected), {});
  check(results, 'crash: every next launch recovered', rounds.every((r) => r.recovered), { errors: rounds.map((r) => r.error).filter(Boolean) });
  endStateChecks(results, 'crash', baseline, final, api, ctx.tol);
  return { results, metrics: { baseline, final, rounds } };
}

function runChild(site, mode) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, `--child=${mode}`, `--server=${site.base}`], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = ''; let err = ''; let ready = null;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 60_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /READY (\d+)/.exec(out);
      if (m && !ready) { ready = Number(m[1]); setTimeout(() => child.kill('SIGTERM'), 300); }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, ready, stdout: out.slice(-2000), stderr: err.slice(-2000) }); });
  });
}

async function scenarioShutdown(api, site, ctx) {
  const results = [];
  const baseline = sample('shutdown:baseline');
  const runs = [];
  for (let i = 0; i < ctx.shutdowns; i++) runs.push(await runChild(site, 'shutdown'));
  await sleep(2000);
  const final = sample('shutdown:final');
  check(results, 'shutdown: child reached READY with an open browser', runs.every((r) => r.ready), { runs: runs.map((r) => ({ code: r.code, ready: r.ready, stderr: r.stderr.slice(-300) })) });
  check(results, 'shutdown: child exited 0 on SIGTERM', runs.every((r) => r.code === 0), { codes: runs.map((r) => r.code) });
  const browserGone = (pid) => {
    const st = readText(`/proc/${pid}/stat`);
    return st === null || /\) Z /.test(st); // exited (a zombie is counted by the zombie check)
  };
  check(results, 'shutdown: browser pid gone after exit', runs.every((r) => r.ready && browserGone(r.ready)),
    { pids: runs.map((r) => r.ready) });
  check(results, 'shutdown: no orphan chromium remains', final.chromium_live <= baseline.chromium_live, { baseline: baseline.chromium_live, final: final.chromium_live });
  check(results, `shutdown: zombie growth <= ${ctx.tol}`, final.zombies - baseline.zombies <= ctx.tol, { baseline: baseline.zombies, final: final.zombies });
  return { results, metrics: { baseline, final } };
}

/** Child: mirrors backend/workers/main.ts - SIGTERM -> closeAllBrowsers -> exit(0). */
async function childMain(opts) {
  const rt = loadRuntime({ launcher: 'dist' });
  const api = makeBrowserApi(rt, {});
  const counters = { blocked: 0 };
  process.on('SIGTERM', () => {
    rt.launcher.closeAllBrowsers(2000).then((o) => { console.log(`CLOSED ${JSON.stringify(o)}`); process.exit(0); }, () => process.exit(3));
  });
  const browser = await api.open();
  const context = await guardedContext(browser, counters);
  const page = await context.newPage();
  await goto(page, `${opts.server}/`);
  const pid = childBrowserPids()[0] || 0;
  console.log(`READY ${pid}`);
  setInterval(() => undefined, 1000);
}

// ── selftest (no browser; runs on any OS) ───────────────────────────────────
function selftest() {
  const assert = require('assert');
  assert.deepStrictEqual(parseStat('123 (headless_shell) S 1 123 123 0'), { pid: 123, comm: 'headless_shell', state: 'S', ppid: 1 });
  assert.deepStrictEqual(parseStat('9 (a (b) c) Z 7 9'), { pid: 9, comm: 'a (b) c', state: 'Z', ppid: 7 });
  assert.strictEqual(parseStatusField('Name:\tx\nThreads:\t17\nVmRSS:\t  2048 kB\n', 'Threads'), 17);
  assert.strictEqual(parseStatusField('Name:\tx\nVmRSS:\t  2048 kB\n', 'VmRSS'), 2048);
  assert.ok(isChromium('chrome', ''));
  assert.ok(isChromium('x', '/ms-playwright/chromium_headless_shell-1217/chrome-linux/headless_shell'));
  assert.ok(!isChromium('node', 'node'));
  assert.ok(isLoopbackUrl('http://127.0.0.1:4000/x'));
  for (const bad of ['http://localhost/', 'https://www.linkedin.com/', 'http://127.0.0.1.nip.io/', BLOCKED_URL, 'file:///etc/passwd']) {
    assert.ok(!isLoopbackUrl(bad), bad);
  }
  assert.throws(() => assertGotoAllowed('https://example.com/'), /HARNESS_REFUSES_NON_LOOPBACK_URL/);
  assert.doesNotThrow(() => assertGotoAllowed(BLOCKED_URL));
  assert.ok(BLOCKED_URL.includes('.invalid'));
  assert.deepStrictEqual(parseArgs(['--cycles=5', '--heavy', '--drop-arg=--disable-dev-shm-usage']),
    { cycles: '5', heavy: true, dropArgs: ['--disable-dev-shm-usage'] });
  // A fake /proc with one zombie chromium and one live one.
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-proc-'));
  const mk = (pid, stat, status, cmd) => {
    fs.mkdirSync(path.join(root, String(pid)));
    fs.writeFileSync(path.join(root, String(pid), 'stat'), stat);
    fs.writeFileSync(path.join(root, String(pid), 'status'), status);
    fs.writeFileSync(path.join(root, String(pid), 'cmdline'), cmd);
  };
  mk(1, '1 (node) S 0 1 1', 'Threads:\t11\n', 'node\0x.js\0');
  mk(20, '20 (headless_shell) S 1 20 20', 'Threads:\t30\nVmRSS:\t100 kB\n', '/x/headless_shell\0--headless\0');
  mk(21, '21 (chrome) Z 1 20 20', '', '');
  const s = scanProcs(root);
  fs.rmSync(root, { recursive: true, force: true });
  assert.strictEqual(s.processes, 3);
  assert.strictEqual(s.zombies, 1);
  assert.strictEqual(s.chromiumZombie, 1);
  assert.strictEqual(s.chromiumLive, 1);
  assert.strictEqual(s.chromiumRssKb, 100);
  assert.strictEqual(s.tasks, 11 + 30 + 1);
  console.log(JSON.stringify({ selftest: 'ok' }));
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) return selftest();
  if (opts.child) return childMain(opts);
  if (process.platform !== 'linux') {
    console.error('lifecycle-soak measures /proc and must run on Linux (inside the worker image).');
    process.exit(2);
  }
  const ctx = {
    cycles: intOpt(opts.cycles, 200),
    concurrency: String(opts.concurrency || '3,8').split(',').map((n) => intOpt(n, 0)).filter((n) => n > 0),
    rounds: intOpt(opts.rounds, 3),
    contexts: intOpt(opts.contexts, 30),
    crashes: intOpt(opts.crashes, 5),
    shutdowns: intOpt(opts.shutdowns, 3),
    tol: intOpt(opts['zombie-tolerance'], 0),
    heavy: Boolean(opts.heavy),
    samples: [],
  };
  const scenarios = String(opts.scenarios || 'network,sequential,concurrent,contexts,crash,shutdown').split(',');
  const summary = {
    variant: opts.variant || 'unnamed',
    started_at: new Date().toISOString(),
    node: process.version,
    pid: process.pid,
    env: cgroupFacts(),
    config: { ...ctx, samples: undefined, scenarios, drop_args: opts.dropArgs || [] },
    scenarios: {},
    checks: [],
    ok: false,
  };
  let site = null;
  try {
    const rt = loadRuntime(opts);
    const api = makeBrowserApi(rt, opts);
    summary.playwright = rt.pwVersion;
    summary.launch_mode = api.mode;
    summary.browser_runtime_env = process.env.OMNIVYRA_BROWSER_RUNTIME || null;
    site = await startServer();
    summary.start = sample('start');
    const run = { network: scenarioNetwork, sequential: scenarioSequential, concurrent: scenarioConcurrent,
      contexts: scenarioContexts, crash: scenarioCrash, shutdown: scenarioShutdown };
    for (const name of scenarios) {
      if (!run[name]) throw new Error(`unknown scenario ${name}`);
      const t0 = Date.now();
      const r = await run[name](api, site, ctx);
      const results = Array.isArray(r) ? r : r.results;
      summary.scenarios[name] = { ms: Date.now() - t0, ok: results.every((c) => c.ok), checks: results,
        ...(Array.isArray(r) ? {} : { metrics: r.metrics }) };
      if (!Array.isArray(r) && r.samples && opts['keep-samples']) summary.scenarios[name].samples = r.samples;
      summary.checks.push(...results.map((c) => ({ scenario: name, ...c })));
      console.error(`[soak] ${name}: ${summary.scenarios[name].ok ? 'ok' : 'FAILED'} (${summary.scenarios[name].ms} ms)`);
    }
    summary.server_hits = site.hits.total;
    summary.final = sample('end');
    summary.zombie_growth = summary.final.zombies - summary.start.zombies;
    summary.chromium_zombie_growth = summary.final.chromium_zombie - summary.start.chromium_zombie;
    summary.ok = summary.checks.length > 0 && summary.checks.every((c) => c.ok);
  } catch (e) {
    summary.harness_error = String((e && e.stack) || e);
  } finally {
    if (site) site.server.close();
  }
  summary.finished_at = new Date().toISOString();
  const json = JSON.stringify(summary, null, 2);
  if (opts.out) { fs.mkdirSync(path.dirname(opts.out), { recursive: true }); fs.writeFileSync(opts.out, json); }
  console.log(json);
  process.exit(summary.harness_error ? 2 : summary.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
module.exports = { parseStat, parseStatusField, isChromium, isLoopbackUrl, scanProcs };
