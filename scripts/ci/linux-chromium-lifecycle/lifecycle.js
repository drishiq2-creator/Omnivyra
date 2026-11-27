// Linux Chromium lifecycle tests (CI only). Runs as PID 1 inside a container that
// mirrors the production worker image (see Dockerfile). Synthetic 127.0.0.1 pages
// only; every non-local request is aborted and counted.
//
// Tests: T1 repeated launch/shutdown, T2 child-process cleanup, T3 orphan detection
// (hard-killed owner), T4 worker restart recovery (SIGTERM exit without close, then a
// fresh launch), T5 memory/process behaviour, T6 forced-crash cleanup (renderer crash
// and SIGKILL of the browser main process).
//
// The job itself succeeds when the script runs to completion; findings are reported
// in the SUMMARY line and as ::warning:: annotations, not hidden behind exit codes.
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const results = {};
let nonLocalAllowed = 0;
let nonLocalBlocked = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── /proc helpers ────────────────────────────────────────────────────────────
function procs() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const m = stat.match(/^(\d+) \((.*)\) (\S) (\d+)/);
      if (!m) continue;
      let rssKb = 0;
      try {
        const st = fs.readFileSync(`/proc/${d}/status`, 'utf8').match(/VmRSS:\s+(\d+)/);
        rssKb = st ? Number(st[1]) : 0;
      } catch { /* zombie: no status memory */ }
      out.push({ pid: Number(m[1]), comm: m[2], state: m[3], ppid: Number(m[4]), rssKb });
    } catch { /* raced exit */ }
  }
  return out;
}
const isChrome = (p) => /chrom|headless_shell/i.test(p.comm);
function chromeCensus() {
  const all = procs().filter(isChrome);
  const zombies = all.filter((p) => p.state === 'Z');
  const live = all.filter((p) => p.state !== 'Z');
  return { live: live.length, zombies: zombies.length, rssMb: Math.round(live.reduce((s, p) => s + p.rssKb, 0) / 1024) };
}
function killLiveChrome() {
  let n = 0;
  for (const p of procs().filter(isChrome)) {
    if (p.state === 'Z') continue;
    try { process.kill(p.pid, 'SIGKILL'); n += 1; } catch { /* gone */ }
  }
  return n;
}

// ── synthetic localhost site ─────────────────────────────────────────────────
function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body><form><input id="q"><button id="b" type="button">Go</button></form>' +
      '<img src="http://192.0.2.1/x.png"></body></html>');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}
async function guardedContext(browser) {
  const context = await browser.newContext();
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.continue();
    nonLocalBlocked += 1;
    return route.abort();
  });
  context.on('request', (req) => {
    const host = new URL(req.url()).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost' && req.failure() === null) {
      // counted as allowed only if it later finishes
      req.response().then((resp) => { if (resp) nonLocalAllowed += 1; }).catch(() => {});
    }
  });
  return context;
}

function spawnChild(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['child.js', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = false;
    child.stdout.on('data', (d) => { if (!ready && String(d).includes('READY')) { ready = true; resolve(child); } });
    child.on('exit', (code) => { if (!ready) reject(new Error(`child exited ${code} before READY`)); });
    setTimeout(() => { if (!ready) reject(new Error('child READY timeout')); }, 30000);
  });
}
const waitExit = (child) => new Promise((r) => { if (child.exitCode !== null || child.signalCode) r(); else child.on('exit', () => r()); });

(async () => {
  const server = await startServer();
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`pid=${process.pid} (expect 1 = worker-like PID 1) node=${process.version}`);
  results.pid1 = process.pid === 1;

  // T1 + T2 + T5: repeated launch/shutdown, cleanup, memory trend
  const cycles = [];
  for (let i = 0; i < 20; i += 1) {
    const t0 = Date.now();
    const browser = await chromium.launch({ headless: true });
    const launchMs = Date.now() - t0;
    const context = await guardedContext(browser);
    const page = await context.newPage();
    await page.goto(url, { timeout: 15000 });
    await page.fill('#q', `cycle-${i}`);
    await page.click('#b');
    const during = chromeCensus();
    const c0 = Date.now();
    await browser.close();
    const closeMs = Date.now() - c0;
    await sleep(300);
    const after = chromeCensus();
    cycles.push({ i, launchMs, closeMs, rssMbDuring: during.rssMb, procsDuring: during.live, liveAfter: after.live, zombiesAfter: after.zombies });
  }
  const avg = (a) => Math.round(a.reduce((s, x) => s + x, 0) / a.length);
  results.T1_repeated = {
    cycles: cycles.length,
    launchMsAvg: avg(cycles.map((c) => c.launchMs)),
    launchMsMax: Math.max(...cycles.map((c) => c.launchMs)),
    closeMsAvg: avg(cycles.map((c) => c.closeMs)),
    maxLiveAfterClose: Math.max(...cycles.map((c) => c.liveAfter)),
    zombiesAfterLast: cycles[cycles.length - 1].zombiesAfter,
  };
  results.T2_cleanup = { liveChromeAfterAllCycles: chromeCensus().live, zombies: chromeCensus().zombies };
  results.T5_memory = {
    rssMbFirst5Avg: avg(cycles.slice(0, 5).map((c) => c.rssMbDuring)),
    rssMbLast5Avg: avg(cycles.slice(-5).map((c) => c.rssMbDuring)),
    procsPerBrowser: avg(cycles.map((c) => c.procsDuring)),
    nodeRssMb: Math.round(process.memoryUsage().rss / 1048576),
  };

  // T3: orphan detection - the owning process is hard-killed
  {
    const child = await spawnChild(url);
    const before = chromeCensus();
    child.kill('SIGKILL');
    await waitExit(child);
    await sleep(3000);
    const after = chromeCensus();
    const cleaned = killLiveChrome();
    await sleep(500);
    results.T3_orphans_after_SIGKILL = { liveBefore: before.live, liveAfter: after.live, zombiesAfter: after.zombies, cleanedUp: cleaned, zombiesAfterCleanup: chromeCensus().zombies };
  }

  // T4: worker restart recovery - SIGTERM exit without close, then a fresh launch
  {
    const child = await spawnChild(url);
    child.kill('SIGTERM');
    await waitExit(child);
    await sleep(3000);
    const afterExit = chromeCensus();
    const t0 = Date.now();
    const browser = await chromium.launch({ headless: true });
    const ctx = await guardedContext(browser);
    const page = await ctx.newPage();
    await page.goto(url, { timeout: 15000 });
    await browser.close();
    const relaunchMs = Date.now() - t0;
    await sleep(300);
    const cleaned = killLiveChrome();
    await sleep(500);
    results.T4_restart_recovery = { liveAfterSigtermExit: afterExit.live, zombiesAfterSigtermExit: afterExit.zombies, relaunchOk: true, relaunchMs, leftoverCleanedUp: cleaned, zombiesAtEnd: chromeCensus().zombies };
  }

  // T6: forced crash - renderer crash, then SIGKILL of the browser main process
  {
    const browser = await chromium.launch({ headless: true });
    const ctx = await guardedContext(browser);
    const page = await ctx.newPage();
    await page.goto(url, { timeout: 15000 });
    let rendererCrashed = false;
    page.on('crash', () => { rendererCrashed = true; });
    await page.goto('chrome://crash').catch(() => {});
    await sleep(1500);
    const mainPids = procs().filter((p) => isChrome(p) && p.ppid === process.pid && p.state !== 'Z').map((p) => p.pid);
    let disconnected = false;
    browser.on('disconnected', () => { disconnected = true; });
    for (const pid of mainPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(3000);
    const after = chromeCensus();
    try { await browser.close(); } catch { /* already gone */ }
    const cleaned = killLiveChrome();
    await sleep(500);
    results.T6_forced_crash = { rendererCrashEvent: rendererCrashed, killedMainPids: mainPids.length, disconnectedEvent: disconnected, liveAfterKill: after.live, zombiesAfterKill: after.zombies, leftoverCleanedUp: cleaned, zombiesAtEnd: chromeCensus().zombies };
  }

  results.network = { nonLocalBlocked, nonLocalAllowed };
  results.finalCensus = chromeCensus();
  server.close();

  for (const [k, v] of Object.entries(results)) console.log(`RESULT ${k} ${JSON.stringify(v)}`);
  const findings = [];
  if (results.T1_repeated.maxLiveAfterClose > 0) findings.push('T1: live Chromium processes remained after browser.close()');
  if (results.T2_cleanup.liveChromeAfterAllCycles > 0) findings.push('T2: live Chromium processes after all cycles');
  if (results.T3_orphans_after_SIGKILL.liveAfter > 0) findings.push(`T3: ${results.T3_orphans_after_SIGKILL.liveAfter} live Chromium processes orphaned after the owner was SIGKILLed`);
  if (results.T4_restart_recovery.liveAfterSigtermExit > 0) findings.push(`T4: ${results.T4_restart_recovery.liveAfterSigtermExit} live Chromium processes orphaned after SIGTERM exit without close`);
  if (results.finalCensus.zombies > 0) findings.push(`zombies: ${results.finalCensus.zombies} defunct Chromium processes never reaped (PID 1 = ${results.pid1 ? 'node' : 'init'})`);
  if (results.network.nonLocalAllowed > 0) findings.push('network: a non-local request was allowed');
  for (const f of findings) console.log(`::warning::${f}`);
  console.log(`SUMMARY ${JSON.stringify({ pid1Node: results.pid1, findings })}`);
  process.exit(0);
})().catch((e) => { console.error(`SCRIPT_ERROR ${e && e.stack || e}`); process.exit(2); });
