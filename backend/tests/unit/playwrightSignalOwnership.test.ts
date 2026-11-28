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
 * `withWorkerSignalOwnership(...)`, or (register T-4) it is in a file on
 * EXEMPT_FILE_ALLOWLIST and the comment block directly above it carries a
 * `signal-ownership-exempt: <reason>` marker with a real reason. Every
 * allowlisted file must be unreachable from the worker entry
 * (backend/workers/main.ts) through the static import graph, so an exemption
 * can never hide a worker-side launch.
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
/** `signal-ownership-exempt: <reason>`; the reason is everything after the colon on that line. */
const EXEMPT_MARKER = /signal-ownership-exempt:([^\n]*)/;
/** A reason is at least this many non-space characters ("web-only" alone is not a reason). */
const MIN_REASON_CHARS = 12;
/**
 * The ONLY files whose launches may be exempted (register T-4). Each must be
 * unreachable from EVERY worker entry (EXPECTED_WORKER_ENTRIES; asserted below on
 * the real import graph).
 */
const EXEMPT_FILE_ALLOWLIST = new Set(['backend/services/export/htmlToPdfRenderer.ts']);
/**
 * Every separately launched worker-side entry, DERIVED from what is actually
 * launched (deriveWorkerEntries) and pinned here, so a new entry fails until it
 * is added (and therefore walked).
 */
const EXPECTED_WORKER_ENTRIES = [
  'backend/queue/startWorkers.ts', // package.json worker:bolt / start:workers
  'backend/scheduler/cron.ts', // Dockerfile.cron CMD, package.json worker:cron / start:cron
  'backend/workers/campaignPlanningWorker.ts', // top-level start() in backend/workers/
  'backend/workers/main.ts', // Dockerfile.worker CMD (railway.json), package.json worker:all
];

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

type Site = {
  file: string; line: number; call: string; ok: boolean; exempt: boolean;
  /** Why a marker present above the site was NOT honoured, if one was. */
  markerRejected?: 'file-not-allowlisted' | 'no-reason';
};

/** The contiguous comment block (//, /*, *) directly above 1-based `line`. */
function commentBlockAbove(lines: string[], line: number): string {
  const out: string[] = [];
  for (let i = line - 2; i >= 0; i -= 1) {
    if (!/^\s*(\/\/|\/\*|\*)/.test(lines[i])) break;
    out.unshift(lines[i]);
  }
  return out.join('\n');
}

/** Scans one source text. The repo scan and the planted controls share it. */
function scanSource(file: string, src: string): Site[] {
  const sites: Site[] = [];
  const lines = src.split('\n');
  LAUNCH_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LAUNCH_CALL.exec(src)) !== null) {
    const argStart = m.index + m[0].length;
    const arg = src.slice(argStart).trimStart();
    const line = src.slice(0, m.index).split('\n').length;
    const wrapped = arg.startsWith('withWorkerSignalOwnership(');
    const marker = EXEMPT_MARKER.exec(commentBlockAbove(lines, line));
    let exempt = false;
    let markerRejected: Site['markerRejected'];
    if (!wrapped && marker) {
      if (!EXEMPT_FILE_ALLOWLIST.has(file)) markerRejected = 'file-not-allowlisted';
      else if (marker[1].replace(/\s/g, '').length < MIN_REASON_CHARS) markerRejected = 'no-reason';
      else exempt = true;
    }
    sites.push({ file, line, call: `${m[1]}.${m[2]}`, ok: wrapped || exempt, exempt, ...(markerRejected ? { markerRejected } : {}) });
  }
  return sites;
}

/**
 * Static import graph walk from `entry`: `... from '<spec>'`, `import('<spec>')`,
 * `require('<spec>')` and `import '<spec>'`, for relative and `@/` (tsconfig
 * `@/*` -> `./*`) specifiers. Over-approximates (type-only imports and specifiers
 * inside comments count as edges), which can only make the check stricter. It
 * cannot see a specifier computed at runtime (e.g. `new Function(...)('playwright')`
 * in rpaEnv), which is used only for external packages.
 * Returns reachable file -> the file that first imported it.
 */
function workerReachable(
  entry: string,
  read: (file: string) => string | null,
  isFile: (file: string) => boolean,
): Map<string, string | null> {
  const SPECS = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  const EXTS = ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx', '/index.js'];
  const resolve = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith('.')) base = path.posix.join(path.posix.dirname(from), spec);
    else if (spec.startsWith('@/')) base = spec.slice(2);
    else return null;
    for (const e of EXTS) {
      const p = path.posix.normalize(base + e);
      if (isFile(p)) return p;
    }
    return null;
  };
  const seen = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift() as string;
    const src = read(f);
    if (src === null) continue;
    for (const re of SPECS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const r = resolve(f, m[1]);
        if (r && !seen.has(r)) { seen.set(r, f); queue.push(r); }
      }
    }
  }
  return seen;
}

function chainTo(seen: Map<string, string | null>, target: string): string {
  const chain: string[] = [];
  for (let c: string | null | undefined = target; c; c = seen.get(c)) chain.unshift(c);
  return chain.join(' -> ');
}

type RepoView = {
  read: (file: string) => string | null;
  isFile: (file: string) => boolean;
  /** File names (not paths) directly inside `dir`, or [] when it does not exist. */
  list: (dir: string) => string[];
};

/** A backend source path from a launch command token: dist/x.js -> x.ts. */
function toSourceEntry(token: string, view: RepoView): string {
  const p = token.replace(/^\.\//, '').replace(/^dist\//, '');
  const ts = p.replace(/\.js$/, '.ts');
  return view.isFile(ts) ? ts : p;
}
const BACKEND_PATH = /(?:^|[\s"'=])((?:\.\/)?(?:dist\/)?backend\/[\w/.-]+\.(?:js|ts))/g;
function backendPaths(text: string): string[] {
  BACKEND_PATH.lastIndex = 0;
  return [...text.matchAll(BACKEND_PATH)].map((m) => m[1]);
}
/** A statement at column 0 that CALLS something (`start().catch(...)`, `main();`, `void run()`). */
const TOP_LEVEL_CALL = /^(?:void\s+|await\s+)?(?!(?:if|for|while|switch|return|function|class|export|import|const|let|var|type|interface|describe|it)\b)[A-Za-z_$][\w$]*\s*\(/m;

/**
 * Worker-side entries, derived from what is actually launched:
 *   - every root Dockerfile* CMD / ENTRYPOINT (Dockerfile.worker = the Railway image via railway.json);
 *   - railway.json deploy.startCommand, if any;
 *   - Procfile* lines;
 *   - package.json scripts whose NAME contains "worker" or "cron";
 *   - every backend/workers/*.ts with a top-level call or `require.main === module`.
 * Returns entry -> the sources that named it.
 */
function deriveWorkerEntries(view: RepoView): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (token: string, source: string) => {
    const e = toSourceEntry(token, view);
    out.set(e, [...(out.get(e) ?? []), source]);
  };
  for (const name of view.list('.')) {
    if (/^Dockerfile/.test(name)) {
      for (const line of (view.read(name) ?? '').split('\n')) {
        if (/^\s*(CMD|ENTRYPOINT)\b/.test(line) && !/^\s*CMD\s+node\s+-e\b/.test(line)) {
          for (const t of backendPaths(line)) add(t, name);
        }
      }
    }
    if (/^Procfile/.test(name)) for (const t of backendPaths(view.read(name) ?? '')) add(t, name);
  }
  const railway = view.read('railway.json');
  if (railway) {
    const start = (JSON.parse(railway) as { deploy?: { startCommand?: string } }).deploy?.startCommand;
    if (start) for (const t of backendPaths(start)) add(t, 'railway.json startCommand');
  }
  const pkg = view.read('package.json');
  if (pkg) {
    const scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (/worker|cron/i.test(name)) for (const t of backendPaths(cmd)) add(t, `package.json ${name}`);
    }
  }
  for (const name of view.list('backend/workers')) {
    if (!/\.ts$/.test(name) || /\.(test|spec)\.ts$/.test(name)) continue;
    const f = `backend/workers/${name}`;
    const src = view.read(f) ?? '';
    if (TOP_LEVEL_CALL.test(src) || /require\.main\s*===\s*module/.test(src)) add(f, 'top-level start');
  }
  return out;
}

/** Throws (naming the constant to update) unless the derived entries are exactly `expected`. */
function assertWorkerEntries(expected: string[], derived: Map<string, string[]>): void {
  const entries = [...derived.keys()];
  const added = entries.filter((e) => !expected.includes(e)).sort();
  const removed = expected.filter((e) => !entries.includes(e)).sort();
  if (added.length || removed.length) {
    throw new Error(
      'worker entry set changed: if intended, update EXPECTED_WORKER_ENTRIES in backend/tests/unit/playwrightSignalOwnership.test.ts' +
      `\n  added:   ${JSON.stringify(added.map((e) => `${e} (${derived.get(e)?.join(', ')})`))}\n  removed: ${JSON.stringify(removed)}`,
    );
  }
}

/** Union walk from every entry: allowlisted file -> "<entry>: <chain>" for each entry that reaches it. */
function allowlistedReachedFrom(entries: string[], view: RepoView): string[] {
  const hits: string[] = [];
  for (const entry of entries) {
    const seen = workerReachable(entry, view.read, view.isFile);
    for (const f of EXEMPT_FILE_ALLOWLIST) if (seen.has(f)) hits.push(`${entry}: ${chainTo(seen, f)}`);
  }
  return hits;
}

const realRepo: RepoView = {
  read: (f) => { try { return fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n'); } catch { return null; } },
  isFile: (f) => { try { return fs.statSync(path.join(REPO, f)).isFile(); } catch { return false; } },
  list: (d) => { try { return fs.readdirSync(path.join(REPO, d)); } catch { return []; } },
};

/** An in-memory RepoView for the planted controls. */
function fakeRepo(files: Record<string, string>): RepoView {
  return {
    read: (f) => (f in files ? files[f] : null),
    isFile: (f) => f in files,
    list: (d) => Object.keys(files)
      .filter((f) => (d === '.' ? !f.includes('/') : f.startsWith(`${d}/`) && !f.slice(d.length + 1).includes('/')))
      .map((f) => (d === '.' ? f : f.slice(d.length + 1))),
  };
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

  it('passes a wrapped launch (single- and multi-line) and an exempt-marked one in an allowlisted file', () => {
    const src = [
      'await chromium.launch(withWorkerSignalOwnership({ headless: true }));',
      'await pw.chromium.launch(',
      '  withWorkerSignalOwnership({ headless: true }),',
      ');',
      '// signal-ownership-exempt: serverless only (Vercel / Lambda)',
      'await puppeteer.launch({});',
    ].join('\n');
    const sites = scanSource('backend/services/export/htmlToPdfRenderer.ts', src);
    expect(sites).toHaveLength(3);
    expect(sites.every((s) => s.ok)).toBe(true);
    expect(sites[2].exempt).toBe(true);
  });

  it('a marker at the top of a multi-line comment block directly above the launch counts', () => {
    const src = [
      '// signal-ownership-exempt: web-only. Only the report API routes call this.',
      '// (second line of the same note)',
      '// (third line of the same note)',
      'browser = await chromium.launch({ headless: true });',
    ].join('\n');
    expect(scanSource('backend/services/export/htmlToPdfRenderer.ts', src)[0]).toMatchObject({ ok: true, exempt: true });
    // ...but not one separated from the launch by code.
    const separated = src.replace('// (third line of the same note)', 'const x = 1;');
    expect(scanSource('backend/services/export/htmlToPdfRenderer.ts', separated)[0].ok).toBe(false);
  });

  it('(T-4 a) the same web-only marker on a launch in a worker-reachable file still FAILS', () => {
    const src = '// signal-ownership-exempt: web-only, only the report API routes call this\nawait pw.chromium.launch({ headless: true });';
    const [s] = scanSource('backend/services/rpaWorker/rpaPlaywrightRunner.ts', src);
    expect(s).toMatchObject({ ok: false, exempt: false, markerRejected: 'file-not-allowlisted' });
  });

  it('(T-4 b) a marker with no reason, or a bare label, FAILS even in an allowlisted file', () => {
    const file = 'backend/services/export/htmlToPdfRenderer.ts';
    for (const marker of ['// signal-ownership-exempt:', '// signal-ownership-exempt:   ', '// signal-ownership-exempt: web-only']) {
      const [s] = scanSource(file, `${marker}\nawait chromium.launch({});`);
      expect(s).toMatchObject({ ok: false, markerRejected: 'no-reason' });
    }
  });

  it('(T-4 c) the real htmlToPdfRenderer passes: every site exempt with a reason, none wrapped', () => {
    const file = 'backend/services/export/htmlToPdfRenderer.ts';
    const sites = scanSource(file, fs.readFileSync(path.join(REPO, file), 'utf8').replace(/\r\n/g, '\n'));
    expect(sites.map((s) => s.call)).toEqual(['chromium.launch', 'chromium.launch', 'puppeteer.launch']);
    expect(sites.every((s) => s.ok && s.exempt)).toBe(true);
  });
});

describe('planted controls — worker reachability walk', () => {
  const graph: Record<string, string> = {
    'backend/workers/main.ts': "import { a } from '../services/a';\nconst b = await import('@/backend/services/b');",
    'backend/services/a.ts': "export * from './deep/c';",
    'backend/services/b/index.ts': "const r = require('../export/htmlToPdfRenderer');",
    'backend/services/deep/c.ts': "import 'playwright';\nexport const c = 1;",
    'backend/services/export/htmlToPdfRenderer.ts': 'export const x = 1;',
    'backend/services/unrelated.ts': "import { x } from './export/htmlToPdfRenderer';",
  };
  const read = (f: string) => (f in graph ? graph[f] : null);
  const isFile = (f: string) => f in graph;

  it('follows from / import() / require / re-export and the @/ alias, and reports the chain', () => {
    const seen = workerReachable('backend/workers/main.ts', read, isFile);
    expect(seen.has('backend/services/deep/c.ts')).toBe(true);
    expect(seen.has('backend/services/export/htmlToPdfRenderer.ts')).toBe(true);
    expect(chainTo(seen, 'backend/services/export/htmlToPdfRenderer.ts')).toBe(
      'backend/workers/main.ts -> backend/services/b/index.ts -> backend/services/export/htmlToPdfRenderer.ts',
    );
  });

  it('a file only imported by a non-worker module is not reachable', () => {
    const g = { ...graph, 'backend/services/b/index.ts': 'export const b = 2;' };
    const seen = workerReachable('backend/workers/main.ts', (f) => (f in g ? g[f as keyof typeof g] : null), (f) => f in g);
    expect(seen.has('backend/services/export/htmlToPdfRenderer.ts')).toBe(false);
    expect(seen.has('backend/services/unrelated.ts')).toBe(false);
  });

  it('a type reference (typeof chromium.launch) is not a call site', () => {
    expect(scanSource('fixture.ts', 'let b: Awaited<ReturnType<typeof chromium.launch>> | null = null;')).toHaveLength(0);
  });
});

describe('planted controls — worker entries are derived from what is launched', () => {
  const files: Record<string, string> = {
    'Dockerfile.worker': 'FROM node\nHEALTHCHECK CMD node -e "fetch(1)"\nCMD ["node", "dist/backend/workers/main.js"]\n',
    'Dockerfile.cron': 'CMD ["node", "dist/backend/scheduler/cron.js"]\n',
    'Procfile': 'web: next start\nbolt: node dist/backend/queue/bolt.js\n',
    'railway.json': JSON.stringify({ deploy: { startCommand: 'node dist/backend/workers/railwayEntry.js' } }),
    'package.json': JSON.stringify({ scripts: {
      'worker:x': 'npx ts-node backend/queue/startWorkers.ts',
      'intelligence:enqueue': 'npx ts-node backend/scripts/notAWorker.ts',
    } }),
    'backend/workers/main.ts': "import { a } from '../services/a';",
    'backend/scheduler/cron.ts': 'export const c = 1;',
    'backend/queue/bolt.ts': 'export const b = 1;',
    'backend/workers/railwayEntry.ts': 'export const r = 1;',
    'backend/queue/startWorkers.ts': 'export const s = 1;',
    'backend/workers/sideWorker.ts': "import { x } from '../services/export/htmlToPdfRenderer';\nstart().catch(() => process.exit(1));\nasync function start() {}",
    'backend/workers/libOnly.ts': 'export function start() {}\nexport const worker = 1;',
    'backend/services/a.ts': 'export const a = 1;',
    'backend/services/export/htmlToPdfRenderer.ts': 'export const x = 1;',
  };
  const view = fakeRepo(files);

  it('collects Dockerfile CMDs (not HEALTHCHECK), Procfile, railway startCommand, worker/cron scripts and top-level starts', () => {
    expect([...deriveWorkerEntries(view).keys()].sort()).toEqual([
      'backend/queue/bolt.ts',
      'backend/queue/startWorkers.ts',
      'backend/scheduler/cron.ts',
      'backend/workers/main.ts',
      'backend/workers/railwayEntry.ts',
      'backend/workers/sideWorker.ts',
    ]);
  });

  it('a new (or removed) entry fails the expected-set check until EXPECTED_WORKER_ENTRIES is updated', () => {
    const derived = deriveWorkerEntries(view);
    const all = [...derived.keys()];
    expect(() => assertWorkerEntries(all, derived)).not.toThrow();
    expect(() => assertWorkerEntries(all.filter((e) => !e.endsWith('sideWorker.ts')), derived))
      .toThrow(/added: +\["backend\/workers\/sideWorker\.ts \(top-level start\)"\]/);
    expect(() => assertWorkerEntries([...all, 'backend/workers/gone.ts'], derived))
      .toThrow(/removed: \["backend\/workers\/gone\.ts"\]/);
  });

  it('an allowlisted file imported ONLY from a non-main entry is caught', () => {
    const entries = [...deriveWorkerEntries(view).keys()];
    // Control: main alone does not reach it, so only the derived non-main entry can catch it.
    expect(allowlistedReachedFrom(['backend/workers/main.ts'], view)).toEqual([]);
    expect(allowlistedReachedFrom(entries, view)).toEqual([
      'backend/workers/sideWorker.ts: backend/workers/sideWorker.ts -> backend/services/export/htmlToPdfRenderer.ts',
    ]);
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

  it('exemptions exist only in allowlisted files: the web-only PDF renderer (2 Playwright + 1 Puppeteer)', () => {
    const exempt = sites.filter((s) => s.exempt).map((s) => `${s.file} ${s.call}`);
    expect(exempt).toEqual([
      'backend/services/export/htmlToPdfRenderer.ts chromium.launch',
      'backend/services/export/htmlToPdfRenderer.ts chromium.launch',
      'backend/services/export/htmlToPdfRenderer.ts puppeteer.launch',
    ]);
    expect(sites.filter((s) => s.markerRejected)).toEqual([]);
  });

  it('the derived worker entries are non-empty and exactly EXPECTED_WORKER_ENTRIES', () => {
    const derived = deriveWorkerEntries(realRepo);
    expect(derived.size).toBeGreaterThan(0);
    assertWorkerEntries(EXPECTED_WORKER_ENTRIES, derived);
    for (const e of derived.keys()) expect(realRepo.isFile(e)).toBe(true);
  });

  it('no allowlisted (exempt) file is reachable from ANY worker entry through the static import graph', () => {
    // Non-vacuous: the walk from main really reaches the worker's own browser code (main -> cron -> RPA).
    const seen = workerReachable('backend/workers/main.ts', realRepo.read, realRepo.isFile);
    expect(seen.has('backend/services/rpaWorker/rpaPlaywrightRunner.ts')).toBe(true);
    expect(seen.size).toBeGreaterThan(500);
    expect(allowlistedReachedFrom(EXPECTED_WORKER_ENTRIES, realRepo)).toEqual([]);
  });
});
