/**
 * The ONE place a Playwright Chromium is launched and torn down.
 *
 * Every browser launch site in the worker goes through launchBrowser(), so the
 * whole fleet gets the same:
 *   (a) runtime gate   - refuses (BROWSER_RUNTIME_REFUSED) unless this process is
 *                        the worker image (browserRuntimeEnv.ts);
 *   (b) container args - see CONTAINER_CHROMIUM_ARGS below;
 *   (c) launch timeout - bounded, Playwright kills the half-started process on expiry;
 *   (d) registry       - every open browser is tracked until it disconnects;
 *   (e) shutdown       - closeAllBrowsers() closes gracefully, then force-kills;
 *   (f) cleanup        - releaseBrowserResources() closes page/context/browser and
 *                        never throws, even when a close() throws or hangs.
 *
 * Signals: Playwright by default installs its OWN SIGINT/SIGTERM/SIGHUP handlers
 * (playwright-core/lib/server/utils/processLauncher.js). Its SIGTERM handler closes
 * every browser the moment the signal arrives - before the worker's bounded drain
 * has let in-flight jobs finish - and its SIGINT handler closes them and then calls
 * process.exit(130), cutting the worker's drain short. The worker owns shutdown
 * (backend/workers/main.ts), so those handlers are disabled here and the worker
 * calls closeAllBrowsers() after its drain. Playwright's process 'exit' handler
 * (kill every launched browser on exit) cannot be disabled and stays as a backstop.
 *
 * Pure at module load: no Playwright import until a launch is requested.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Browser, LaunchOptions } from 'playwright';
import { BROWSER_RUNTIME_REFUSED, browserRuntimeDecision } from './browserRuntimeEnv';

/**
 * Chromium switches for the worker container. Each candidate was evaluated:
 *
 *  --disable-dev-shm-usage  ADOPTED. Docker's default /dev/shm is 64 MB; Chromium
 *                           puts renderer<->browser shared memory there and crashes
 *                           tabs ("Aw, Snap" / target closed) on large pages when it
 *                           fills. With the switch it uses /tmp instead. Cost: none
 *                           measurable for our page sizes. (The soak harness has a
 *                           small --shm-size run that measures the hypothesis.)
 *  --disable-gpu            ADOPTED. The container has no GPU; headless Chromium
 *                           otherwise probes GPU initialisation and falls back to
 *                           SwiftShader. Harmless for headless page work and PDF,
 *                           and already used by htmlToPdfRenderer.
 *  --no-sandbox             NOT ADDED BY HAND, sandbox stays OFF via
 *                           `chromiumSandbox: false`. Dockerfile.worker has no USER
 *                           directive, so the worker runs as root, and Chromium
 *                           refuses to start its sandbox as root. Playwright's default
 *                           is already chromiumSandbox=false (it appends --no-sandbox
 *                           itself), so this is the behaviour production has always
 *                           had - stated explicitly so it cannot drift. Turning the
 *                           sandbox on requires a non-root USER first.
 *  --no-zygote              REJECTED. "Zygote could not fork" is a symptom: fork()
 *                           failing with EAGAIN because the container ran out of
 *                           pids/threads (see the zombie analysis in the soak
 *                           harness). Removing the zygote moves the same fork into
 *                           the browser process; it does not create pids.
 *  --single-process         REJECTED. Unsupported by Chromium, a renderer crash takes
 *                           the whole browser down, and it is known to hang on
 *                           close - the opposite of what a long-lived worker needs.
 */
export const CONTAINER_CHROMIUM_ARGS: readonly string[] = Object.freeze([
  '--disable-dev-shm-usage',
  '--disable-gpu',
]);

export const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;
export const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * An inert switch Chromium ignores, carrying the registry id. It is how a hung
 * browser's process is found in /proc for a force-kill: Playwright's public
 * Browser API does not expose the pid of a launched browser.
 */
export const BROWSER_MARKER_SWITCH = '--omnivyra-browser-id=';

export class BrowserRuntimeRefusedError extends Error {
  readonly code = BROWSER_RUNTIME_REFUSED;
  constructor(readonly reason: string, readonly purpose: string) {
    super(`${BROWSER_RUNTIME_REFUSED}: ${reason} (purpose=${purpose})`);
    this.name = 'BrowserRuntimeRefusedError';
  }
}

export function isBrowserRuntimeRefused(err: unknown): err is BrowserRuntimeRefusedError {
  return Boolean(err) && (err as { code?: unknown }).code === BROWSER_RUNTIME_REFUSED;
}

type ChromiumLike = { launch: (options?: LaunchOptions) => Promise<Browser> };
export type PlaywrightLike = { chromium?: ChromiumLike | null } | null | undefined;

export interface LaunchBrowserOptions {
  /** Short label for logs and the registry (e.g. 'rpa-script'). */
  purpose: string;
  /** An already-loaded playwright module; when absent it is imported lazily. */
  playwright?: PlaywrightLike;
  timeoutMs?: number;
  /** Additional switches (e.g. the soak harness's dead proxy). Appended after the defaults. */
  extraArgs?: readonly string[];
  proxy?: LaunchOptions['proxy'];
}

interface OpenBrowser {
  id: string;
  purpose: string;
  browser: Browser;
  launchedAt: number;
}

const registry = new Map<string, OpenBrowser>();

type LauncherDeps = {
  procRoot: string;
  platform: NodeJS.Platform;
  kill: (pid: number, signal: NodeJS.Signals) => void;
};
const realDeps = (): LauncherDeps => ({
  procRoot: '/proc',
  platform: process.platform,
  kill: (pid, signal) => { process.kill(pid, signal); },
});
let deps: LauncherDeps = realDeps();
let envOverrideForTests: Record<string, string | undefined> | null = null;

/** The exact options every launch uses. Exported so tests and the soak harness see the same thing. */
export function buildLaunchOptions(id: string, opts: Omit<LaunchBrowserOptions, 'purpose' | 'playwright'> = {}): LaunchOptions {
  const timeout = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_LAUNCH_TIMEOUT_MS;
  return {
    headless: true,
    chromiumSandbox: false,
    timeout,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [...CONTAINER_CHROMIUM_ARGS, ...(opts.extraArgs ?? []), `${BROWSER_MARKER_SWITCH}${id}`],
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  };
}

async function importPlaywright(): Promise<PlaywrightLike> {
  // Runtime-only import (same technique as rpaEnv.ts) so web bundles never pull playwright in.
  const importer = new Function('specifier', 'return import(specifier);') as (s: string) => Promise<PlaywrightLike>;
  return importer('playwright');
}

/**
 * Launch a headless Chromium. Throws BrowserRuntimeRefusedError (code
 * BROWSER_RUNTIME_REFUSED) outside the worker runtime - before anything is
 * imported or spawned, so a refusal is always "not attempted".
 */
/**
 * The launcher's runtime decision (the test override, else process.env). Exported so
 * a caller can refuse BEFORE it imports Playwright (rpaEnv's probe does).
 */
export function browserLaunchDecision(): ReturnType<typeof browserRuntimeDecision> {
  return browserRuntimeDecision(envOverrideForTests ?? process.env);
}

export async function launchBrowser(opts: LaunchBrowserOptions): Promise<Browser> {
  const decision = browserLaunchDecision();
  if (decision.allowed !== true) {
    throw new BrowserRuntimeRefusedError((decision as { reason: string }).reason, opts.purpose);
  }
  const pw = opts.playwright ?? (await importPlaywright());
  const chromium = pw?.chromium;
  if (!chromium || typeof chromium.launch !== 'function') {
    throw new Error('PLAYWRIGHT_MODULE_MISSING_CHROMIUM');
  }
  const id = randomUUID();
  const browser = await chromium.launch(buildLaunchOptions(id, opts));
  registry.set(id, { id, purpose: opts.purpose, browser, launchedAt: Date.now() });
  const b = browser as unknown as { on?: (event: string, fn: () => void) => unknown };
  if (typeof b.on === 'function') {
    b.on('disconnected', () => { registry.delete(id); });
  }
  return browser;
}

/** Number of browsers launched through this module that are still open. */
export function openBrowserCount(): number {
  return registry.size;
}

/** Safe registry snapshot for diagnostics. */
export function openBrowserSummary(): Array<{ id: string; purpose: string; age_ms: number }> {
  const now = Date.now();
  return [...registry.values()].map((e) => ({ id: e.id, purpose: e.purpose, age_ms: now - e.launchedAt }));
}

function entryFor(browser: unknown): OpenBrowser | undefined {
  for (const e of registry.values()) if (e.browser === browser) return e;
  return undefined;
}

/** Pids whose command line carries this browser's marker (Linux /proc only). */
export function findMarkedPids(id: string): number[] {
  if (deps.platform !== 'linux') return [];
  const needle = `${BROWSER_MARKER_SWITCH}${id}`;
  let names: string[];
  try { names = fs.readdirSync(deps.procRoot); } catch { return []; }
  const pids: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = fs.readFileSync(path.join(deps.procRoot, name, 'cmdline'), 'utf8');
      if (cmd.split('\0').includes(needle)) pids.push(Number(name));
    } catch { /* process exited between readdir and read */ }
  }
  return pids;
}

/**
 * SIGKILL the browser's whole process group. Playwright spawns Chromium with
 * `detached: true` on Linux, so the browser process leads its own group and the
 * zygote/renderers are in it. Returns how many groups were signalled.
 */
function forceKill(entry: OpenBrowser): number {
  let killed = 0;
  for (const pid of findMarkedPids(entry.id)) {
    try {
      deps.kill(-pid, 'SIGKILL');
      killed += 1;
    } catch {
      try { deps.kill(pid, 'SIGKILL'); killed += 1; } catch { /* already gone */ }
    }
  }
  return killed;
}

type Settled = 'ok' | 'timeout' | 'error';
function settleWithin(work: () => Promise<unknown>, ms: number): Promise<Settled> {
  return new Promise<Settled>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve()
      .then(work)
      .then(() => { clearTimeout(timer); resolve('ok'); }, () => { clearTimeout(timer); resolve('error'); });
  });
}

export type BrowserCloseOutcome = 'closed' | 'force_killed' | 'failed';

/**
 * Close one browser within `timeoutMs`; if close() throws or hangs, force-kill
 * its process group. Never throws. Always removes the registry entry.
 */
export async function closeBrowserWithin(browser: Browser | null | undefined, timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<BrowserCloseOutcome> {
  if (!browser) return 'closed';
  const entry = entryFor(browser);
  const result = await settleWithin(() => browser.close(), timeoutMs);
  if (entry) registry.delete(entry.id);
  if (result === 'ok') return 'closed';
  const killed = entry ? forceKill(entry) : 0;
  if (killed > 0) {
    console.warn(`[browserRuntime] browser close ${result} - force-killed (purpose=${entry?.purpose})`);
    return 'force_killed';
  }
  // Nothing left to kill: a close() that rejects on an already-crashed browser is not a leak.
  const connected = (browser as unknown as { isConnected?: () => boolean }).isConnected;
  if (result === 'error' && typeof connected === 'function' && connected.call(browser) === false) return 'closed';
  console.warn(`[browserRuntime] browser close ${result} and no process found to kill (purpose=${entry?.purpose ?? 'unregistered'})`);
  return 'failed';
}

export interface CloseAllOutcome {
  total: number;
  closed: number;
  force_killed: number;
  failed: number;
}

/**
 * Shutdown: close every registered browser concurrently, each bounded by
 * `timeoutMs`, force-killing whatever does not close. Never throws.
 */
export async function closeAllBrowsers(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<CloseAllOutcome> {
  const entries = [...registry.values()];
  const outcomes = await Promise.all(entries.map((e) => closeBrowserWithin(e.browser, timeoutMs)));
  const out: CloseAllOutcome = { total: entries.length, closed: 0, force_killed: 0, failed: 0 };
  for (const o of outcomes) out[o] += 1;
  if (entries.length > 0) console.info('[browserRuntime] closeAllBrowsers', out);
  return out;
}

/**
 * Synchronous last resort for a hard-exit path that cannot await: SIGKILL every
 * registered browser's process group. Returns the number of groups signalled.
 */
export function forceKillAllBrowsersSync(): number {
  let killed = 0;
  for (const entry of [...registry.values()]) {
    killed += forceKill(entry);
    registry.delete(entry.id);
  }
  return killed;
}

type Closable = { close: () => Promise<unknown> } | null | undefined;

export interface ReleaseOutcome {
  page: Settled | 'none';
  context: Settled | 'none';
  browser: BrowserCloseOutcome | 'none';
}

/**
 * Close page, then context, then browser - each bounded, each independent:
 * a page.close() that throws or hangs never prevents the browser close, and
 * a browser that will not close is force-killed. Never throws; use it in
 * `finally`.
 */
export async function releaseBrowserResources(
  targets: { page?: Closable; context?: Closable; browser?: Browser | null },
  timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
): Promise<ReleaseOutcome> {
  const out: ReleaseOutcome = { page: 'none', context: 'none', browser: 'none' };
  const { page, context, browser } = targets;
  if (page) out.page = await settleWithin(() => page.close(), timeoutMs);
  if (context) out.context = await settleWithin(() => context.close(), timeoutMs);
  if (browser) out.browser = await closeBrowserWithin(browser, timeoutMs);
  return out;
}

/** Test-only: replace the runtime env the gate reads (null restores process.env). */
export function __setBrowserRuntimeEnvForTests(env: Record<string, string | undefined> | null): void {
  envOverrideForTests = env;
}

/** Test-only: replace /proc root, platform and the kill function (null restores the real ones). */
export function __setLauncherDepsForTests(partial: Partial<LauncherDeps> | null): void {
  deps = partial ? { ...realDeps(), ...partial } : realDeps();
}

/** Test-only: forget every registered browser without closing it. */
export function __resetBrowserRegistryForTests(): void {
  registry.clear();
}
