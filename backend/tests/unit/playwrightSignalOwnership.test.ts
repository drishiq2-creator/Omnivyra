/**
 * GI-NEW-1 — STRUCTURAL scan: every browser launch in server code hands
 * shutdown-signal ownership to the worker drain (backend/workers/main.ts).
 *
 * Playwright's default handleSIGTERM/SIGINT/SIGHUP = true closes every browser
 * on the first SIGTERM, while the worker is still draining the job that uses
 * it. The scan is keyed from the CALL PATTERN (chromium/firefox/webkit/puppeteer
 * .launch / .launchPersistentContext / .launchServer), never from a file list,
 * so a new launch site anywhere under backend/, lib/ or pages/ is covered the
 * day it is written. A site passes only when its argument is
 * `withWorkerSignalOwnership(...)` or the three lines above it carry a
 * `signal-ownership-exempt: <reason>` marker.
 *
 * The planted controls run the SAME scanner over fixture strings and prove it
 * flags a missing option — so a green repo scan is not a scanner that matches
 * nothing.
 */
import fs from 'fs';
import path from 'path';

const REPO = path.resolve(__dirname, '..', '..', '..');
const SCAN_ROOTS = ['backend', 'lib', 'pages'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'tests', '__tests__']);
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

const LAUNCH_CALL = /\b(chromium|firefox|webkit|puppeteer)\s*\.\s*(launch|launchPersistentContext|launchServer)\s*\(/g;
const EXEMPT_MARKER = /signal-ownership-exempt:\s*\S/;

type Site = { file: string; line: number; call: string; ok: boolean; exempt: boolean };

/** Scans one source text. The repo scan and the planted controls share it. */
function scanSource(file: string, src: string): Site[] {
  const sites: Site[] = [];
  LAUNCH_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LAUNCH_CALL.exec(src)) !== null) {
    const argStart = m.index + m[0].length;
    const arg = src.slice(argStart).trimStart();
    const line = src.slice(0, m.index).split('\n').length;
    const above = src.split('\n').slice(Math.max(0, line - 4), line - 1).join('\n');
    const wrapped = arg.startsWith('withWorkerSignalOwnership(');
    const exempt = !wrapped && EXEMPT_MARKER.test(above);
    sites.push({ file, line, call: `${m[1]}.${m[2]}`, ok: wrapped || exempt, exempt });
  }
  return sites;
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SOURCE_EXT.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function scanRepo(): Site[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO, root);
    if (fs.existsSync(abs)) walk(abs, files);
  }
  return files.flatMap((f) =>
    scanSource(path.relative(REPO, f).replace(/\\/g, '/'), fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')),
  );
}

describe('planted controls — the scanner catches a missing option', () => {
  it('flags a bare chromium.launch', () => {
    const [s] = scanSource('fixture.ts', "const b = await chromium.launch({ headless: true });");
    expect(s).toMatchObject({ call: 'chromium.launch', ok: false });
  });

  it('flags pw.chromium.launch and a multi-line launch even with the flags spelled inline', () => {
    const src = [
      'browser = await pw.chromium.launch({ headless: true });',
      'browser = await chromium.launch({',
      '  headless: true,',
      '  handleSIGTERM: false,',
      '});',
    ].join('\n');
    const sites = scanSource('fixture.ts', src);
    expect(sites).toHaveLength(2);
    expect(sites.every((s) => !s.ok)).toBe(true);
  });

  it('flags launchPersistentContext, launchServer, firefox, webkit and puppeteer', () => {
    const src = [
      "chromium.launchPersistentContext('/tmp/x', { headless: true });",
      'chromium.launchServer({});',
      'firefox.launch();',
      'webkit . launch ( {} );',
      'puppeteer.launch({ headless: true });',
    ].join('\n');
    const sites = scanSource('fixture.ts', src);
    expect(sites.map((s) => s.call)).toEqual([
      'chromium.launchPersistentContext', 'chromium.launchServer', 'firefox.launch', 'webkit.launch', 'puppeteer.launch',
    ]);
    expect(sites.filter((s) => s.ok)).toHaveLength(0);
  });

  it('passes a wrapped launch (single- and multi-line) and an exempt-marked one', () => {
    const src = [
      'await chromium.launch(withWorkerSignalOwnership({ headless: true }));',
      'await pw.chromium.launch(',
      '  withWorkerSignalOwnership({ headless: true }),',
      ');',
      '// signal-ownership-exempt: serverless only',
      'await puppeteer.launch({});',
    ].join('\n');
    const sites = scanSource('fixture.ts', src);
    expect(sites).toHaveLength(3);
    expect(sites.every((s) => s.ok)).toBe(true);
    expect(sites[2].exempt).toBe(true);
  });

  it('an empty marker (no reason) is not an exemption', () => {
    const [s] = scanSource('fixture.ts', '// signal-ownership-exempt:\nawait chromium.launch({});');
    expect(s.ok).toBe(false);
  });

  it('a type reference (typeof chromium.launch) is not a call site', () => {
    expect(scanSource('fixture.ts', 'let b: Awaited<ReturnType<typeof chromium.launch>> | null = null;')).toHaveLength(0);
  });
});

describe('repo scan — every server-code browser launch defers shutdown signals to the worker', () => {
  const sites = scanRepo();

  it('the scan finds the launch sites (non-vacuous)', () => {
    // 8 Playwright launches + 1 Puppeteer launch at the time of writing. A floor,
    // not an exact count, so a new (wrapped) site does not need a test edit.
    expect(sites.length).toBeGreaterThanOrEqual(9);
    expect(sites.some((s) => s.file === 'backend/services/rpaWorker/rpaPlaywrightRunner.ts')).toBe(true);
  });

  it('no launch site lacks withWorkerSignalOwnership() or a reasoned exemption', () => {
    const offenders = sites.filter((s) => !s.ok).map((s) => `${s.file}:${s.line} ${s.call}`);
    expect(offenders).toEqual([]);
  });

  it('exemptions are reserved for the serverless Puppeteer path — no Playwright site is exempt', () => {
    const exempt = sites.filter((s) => s.exempt).map((s) => `${s.file} ${s.call}`);
    expect(exempt).toEqual(['backend/services/export/htmlToPdfRenderer.ts puppeteer.launch']);
  });
});
