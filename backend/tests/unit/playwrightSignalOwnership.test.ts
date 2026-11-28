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

const LAUNCH_CALL = /\b(chromium|firefox|webkit|puppeteer)\s*\??\.\s*(launch|launchPersistentContext|launchServer)\s*\(/g;
const EXEMPT_MARKER = /signal-ownership-exempt:\s*\S/;

/**
 * Indirect launches the call scan cannot see. Any of these in server code fails
 * the repo scan outright (route the launch through a direct, wrapped call instead):
 *   - a launch method taken as a VALUE: `const l = chromium.launch`, `fn(pw.chromium.launch)`,
 *     `chromium.launch.bind(...)` (an assignment / argument / return position, not a call);
 *   - a COMPUTED receiver: `pw[name].launch(...)`;
 *   - DESTRUCTURING the method: `const { launch } = chromium`.
 * Guards and types (`if (!pw?.chromium?.launch)`, `typeof chromium.launch`) are not aliases.
 */
const ALIAS_PATTERNS: Array<[string, RegExp]> = [
  ['method-as-value', /(?:=|:|\(|,|\breturn)\s*[\w$.?]*\b(?:chromium|firefox|webkit|puppeteer)\s*\??\.\s*launch\w*\b(?!\s*\()/g],
  ['computed-receiver', /\]\s*\??\.\s*launch(?:PersistentContext|Server)?\s*\(/g],
  ['destructured-method', /\{[^{}]*\blaunch(?:PersistentContext|Server)?\b[^{}]*\}\s*=\s*[\w$.?]*\b(?:chromium|firefox|webkit|puppeteer)\b/g],
];

/**
 * Receiver aliases: the browser TYPE itself bound to another name, after which
 * `<alias>.launch(...)` is invisible to the call scan:
 *   - `const bt = pw.chromium;` / `let c = chromium;` (a declaration whose value ends in the type);
 *   - `const { chromium: c } = require('playwright');` (a renamed destructure).
 * Binding under the SAME name (`const chromium = pw.chromium`, `const { chromium } = ...`)
 * is fine: the call scan still sees `chromium.launch(`.
 */
const RECEIVER_ALIAS_PATTERNS: Array<[string, RegExp]> = [
  // Value ends in the type by dot access (`pw.chromium`, `<BrowserType>pw.chromium`) or by
  // quoted bracket access (`pw['chromium']`, any quote style), optionally with `as <Type>`.
  ['receiver-alias', /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;\n]+)?=\s*[^;\n]*?(?:\b(chromium|firefox|webkit)|\[\s*['"`](chromium|firefox|webkit)['"`]\s*\])(?:\s+as\s+[^;\n]+?)?\s*;?[ \t]*$/gm],
  ['renamed-destructure', /\{[^{}]*?\b(chromium|firefox|webkit)\s*:\s*([\w$]+)[^{}]*\}\s*=/g],
];

function scanAliases(file: string, src: string): string[] {
  const hits: string[] = [];
  const lineOf = (i: number) => src.slice(0, i).split('\n').length;
  for (const [kind, re] of ALIAS_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) hits.push(`${file}:${lineOf(m.index)} ${kind}`);
  }
  for (const [kind, re] of RECEIVER_ALIAS_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const [alias, type] = kind === 'receiver-alias' ? [m[1], m[2] ?? m[3]] : [m[2], m[1]];
      if (alias !== type) hits.push(`${file}:${lineOf(m.index)} ${kind}`);
    }
  }
  return hits;
}

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

function repoSources(): Array<[string, string]> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO, root);
    if (fs.existsSync(abs)) walk(abs, files);
  }
  return files.map((f) => [
    path.relative(REPO, f).replace(/\\/g, '/'),
    fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'),
  ]);
}

describe('planted controls — the alias scanner catches indirect launches', () => {
  it.each([
    ['const l = chromium.launch;', 'method-as-value'],
    ['const l = pw.chromium.launch.bind(pw.chromium);', 'method-as-value'],
    ['run(pw?.chromium?.launchPersistentContext, dir);', 'method-as-value'],
    ['return chromium.launch', 'method-as-value'],
    ["const b = await pw[name].launch({ headless: true });", 'computed-receiver'],
    ['const { launch } = chromium;', 'destructured-method'],
    ['const { launchPersistentContext: lpc } = pw.chromium;', 'destructured-method'],
  ])('flags %s', (src, kind) => {
    expect(scanAliases('fixture.ts', src)).toEqual([`fixture.ts:1 ${kind}`]);
  });

  it.each([
    'if (!pw?.chromium?.launch) return null;',
    "if (!chromium || typeof chromium.launch !== 'function') throw new Error('x');",
    'let b: Awaited<ReturnType<typeof chromium.launch>> | null = null;',
    'browser = await pw.chromium.launch(withWorkerSignalOwnership({ headless: true }));',
  ])('does not flag a guard, type or direct call: %s', (src) => {
    expect(scanAliases('fixture.ts', src)).toEqual([]);
  });

  it.each([
    ['const bt = pw.chromium;\nawait bt.launch({});', 'receiver-alias'],
    ['let c = chromium\nc.launch();', 'receiver-alias'],
    ['const ff: BrowserType = playwright.firefox;', 'receiver-alias'],
    ["const bt = pw['chromium'];", 'receiver-alias'],
    ['const bt = pw["webkit"];', 'receiver-alias'],
    ['const bt = pw[`firefox`]', 'receiver-alias'],
    ["const bt = pw?.[ 'chromium' ];", 'receiver-alias'],
    ['const bt = pw.chromium as BrowserType;', 'receiver-alias'],
    ["const bt = pw['chromium'] as BrowserType<{}>;", 'receiver-alias'],
    ['const bt = <BrowserType>pw.chromium;', 'receiver-alias'],
    ["const { chromium: c } = require('playwright');\nc.launch();", 'renamed-destructure'],
    ["const { webkit: wk, devices } = await import('playwright');", 'renamed-destructure'],
  ])('flags a receiver alias: %s', (src, kind) => {
    expect(scanAliases('fixture.ts', src)).toEqual([`fixture.ts:1 ${kind}`]);
  });

  it.each([
    "const { chromium } = require('playwright');\nawait chromium.launch(withWorkerSignalOwnership({}));",
    'const chromium = pw.chromium;',
    "const { chromium, type Browser } = await import('playwright');",
    "const chromium = (await import('@sparticuz/chromium')).default;",
    'const usesChromium = true;',
    "const chromium = pw['chromium'] as BrowserType;",
    "const engine = 'chromium';",
    'const n = pw.chromium.name();',
  ])('does not flag a same-name binding or unrelated line: %s', (src) => {
    expect(scanAliases('fixture.ts', src)).toEqual([]);
  });

  it('the call scan also sees optional-chained calls', () => {
    const [s] = scanSource('fixture.ts', 'await pw?.chromium?.launch({ headless: true });');
    expect(s).toMatchObject({ call: 'chromium.launch', ok: false });
  });
});

function scanRepo(): Site[] {
  return repoSources().flatMap(([f, src]) => scanSource(f, src));
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

  it('no indirect (aliased / computed / destructured) launch exists in server code', () => {
    expect(repoSources().flatMap(([f, src]) => scanAliases(f, src))).toEqual([]);
  });

  it('exemptions are reserved for the serverless Puppeteer path — no Playwright site is exempt', () => {
    const exempt = sites.filter((s) => s.exempt).map((s) => `${s.file} ${s.call}`);
    expect(exempt).toEqual(['backend/services/export/htmlToPdfRenderer.ts puppeteer.launch']);
  });
});
