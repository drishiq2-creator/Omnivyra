// Child "worker" for the lifecycle tests: launches Chromium, opens a synthetic
// localhost page, reports READY, then waits. On SIGTERM it exits immediately
// WITHOUT closing the browser - the same outcome as the production worker's
// drain timeout followed by process.exit.
const { chromium } = require('playwright');

const url = process.argv[2];
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  await page.goto(url, { timeout: 15000 });
  process.on('SIGTERM', () => process.exit(0));
  process.stdout.write('READY\n');
  setInterval(() => {}, 1000);
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(3); });
