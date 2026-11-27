'use strict';
// GI-07 worker init/reaper harness (CI only; see run.sh). Runs INSIDE the real
// image built from Dockerfile.worker and uses that image's own bullmq and
// playwright (/app/node_modules), so the Chromium build, Node version and base
// image are exactly production's. Synthetic 127.0.0.1 pages only: every
// non-local request is aborted. No secrets, no production services.
//
//   node harness.js worker                         BullMQ consumer (the "worker")
//   node harness.js produce <kind> <n> [holdMs] [completed|active]
//   node harness.js state <jobId>
//   node harness.js wait <jobId> <timeoutMs>
//
// Job kinds: cycle (launch, load page, close), hold (same, holding the browser
// open for holdMs), crash (SIGKILL the browser's main process, then close).
//
// The worker's signal handling mirrors backend/workers/main.ts: handlers are
// installed before the consumer starts, the first SIGTERM/SIGINT drains the
// consumer (worker.close() waits for the in-flight job) under a hard-exit
// backstop, later signals join that shutdown, and the process exits 0.
const fs = require('fs');
const http = require('http');
const { Worker, Queue, QueueEvents, Job } = require('/app/node_modules/bullmq');

const QUEUE = process.env.HARNESS_QUEUE || 'gi07';
const connection = { host: process.env.REDIS_HOST || 'redis', port: 6379, maxRetriesPerRequest: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function runWorker() {
  const { chromium } = require('/app/node_modules/playwright');
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body><p id="x">gi07</p></body></html>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  let shuttingDown = false;
  let worker = null;
  const signals = [];
  const shutdown = async (sig) => {
    signals.push(sig);
    log(`HARNESS_SIGNAL ${sig} n=${signals.length} pid=${process.pid}`);
    if (shuttingDown) return;
    shuttingDown = true;
    const hardExit = setTimeout(() => { log('HARNESS_HARD_EXIT'); process.exit(0); }, 20000);
    hardExit.unref();
    if (worker) await worker.close();
    log('HARNESS_DRAINED');
    server.close();
    clearTimeout(hardExit);
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  worker = new Worker(QUEUE, async (job) => {
    const { kind, holdMs = 0 } = job.data;
    log(`HARNESS_JOB_START ${job.id} ${kind}`);
    // 'hold' uses Playwright's defaults, as production's chromium.launch() calls
    // do (handleSIGTERM: true closes every browser on SIGTERM). 'holdnohandler'
    // opts out, so the worker's own drain decides when the browser closes.
    const launchOpts = kind === 'holdnohandler'
      ? { headless: true, handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false }
      : { headless: true };
    const browser = await chromium.launch(launchOpts);
    try {
      const context = await browser.newContext();
      await context.route('**/*', (route) => {
        const host = new URL(route.request().url()).hostname;
        return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      await page.goto(url, { timeout: 15000 });
      if (kind === 'crash') {
        // The browser main process is this process's direct Chromium child.
        for (const p of procs()) {
          if (p.ppid === process.pid && /chrom|headless_shell/i.test(p.comm) && p.state !== 'Z') {
            try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
          }
        }
        await sleep(1500);
      }
      if (holdMs) {
        log(`HARNESS_HOLDING ${job.id}`);
        await sleep(holdMs);
        // A real job keeps using its page after a wait; so does this one.
        await page.evaluate(() => document.getElementById('x').textContent);
      }
      return { pid: process.pid };
    } finally {
      await browser.close().catch(() => {});
      log(`HARNESS_JOB_END ${job.id} ${kind}`);
    }
  }, { connection, concurrency: 1, lockDuration: 5000, stalledInterval: 3000, maxStalledCount: 3 });
  worker.on('ready', () => log(`HARNESS_READY pid=${process.pid} pid1=${comm(1)}`));
  worker.on('error', (e) => log(`HARNESS_WORKER_ERROR ${e.message}`));
  worker.on('failed', (job, err) => log(`HARNESS_JOB_FAILED ${job ? job.id : '?'} ${err ? (err.stack || err.message).split('\n').slice(0, 4).join(' | ') : '?'}`));
}

function comm(pid) { try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return '?'; } }
function procs() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const m = fs.readFileSync(`/proc/${d}/stat`, 'utf8').match(/^(\d+) \((.*)\) (\S) (\d+)/);
      if (m) out.push({ pid: Number(m[1]), comm: m[2], state: m[3], ppid: Number(m[4]) });
    } catch { /* raced exit */ }
  }
  return out;
}

async function produce(kind, n, holdMs, waitFor) {
  const queue = new Queue(QUEUE, { connection });
  const events = new QueueEvents(QUEUE, { connection });
  await events.waitUntilReady();
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const job = await queue.add(kind, { kind, holdMs }, { removeOnComplete: false, removeOnFail: false });
    ids.push(job.id);
    if (waitFor === 'completed') await job.waitUntilFinished(events, 120000);
  }
  if (waitFor === 'active') {
    const deadline = Date.now() + 60000;
    for (;;) {
      const state = await queue.getJobState(ids[ids.length - 1]);
      if (state === 'active') break;
      if (Date.now() > deadline) throw new Error(`job ${ids[ids.length - 1]} never became active (${state})`);
      await sleep(200);
    }
  }
  log(`PRODUCED ${kind} ${ids.join(',')}`);
  await events.close(); await queue.close();
}

async function state(id) {
  const queue = new Queue(QUEUE, { connection });
  const job = await Job.fromId(queue, id);
  const s = job ? await job.getState() : 'missing';
  log(`STATE ${id} ${s} attemptsMade=${job ? job.attemptsMade : '-'} stalledCounter=${job ? job.stalledCounter : '-'} failedReason=${job && job.failedReason ? JSON.stringify(job.failedReason).slice(0, 300) : '-'}`);
  await queue.close();
}

async function wait(id, timeoutMs) {
  const queue = new Queue(QUEUE, { connection });
  const deadline = Date.now() + timeoutMs;
  let s = 'unknown';
  while (Date.now() < deadline) {
    s = await queue.getJobState(id);
    if (s === 'completed' || s === 'failed') break;
    await sleep(500);
  }
  const job = await Job.fromId(queue, id);
  log(`WAITED ${id} ${s} stalledCounter=${job ? job.stalledCounter : '-'}`);
  await queue.close();
}

const [mode, ...args] = process.argv.slice(2);
const main = {
  worker: () => runWorker(),
  produce: () => produce(args[0], Number(args[1] || 1), Number(args[2] || 0), args[3] || 'completed'),
  state: () => state(args[0]),
  wait: () => wait(args[0], Number(args[1] || 60000)),
}[mode];
if (!main) { console.error(`unknown mode ${mode}`); process.exit(2); }
main().catch((e) => { console.error(`HARNESS_ERROR ${e.stack || e.message}`); process.exit(1); });
