/**
 * browserRuntime/browserLauncher.ts - the single Chromium launch/teardown path.
 *
 * A fake playwright module is injected (no browser is ever started). /proc is
 * a temp directory with hand-written cmdline files, and process.kill is a spy,
 * so the force-kill path is exercised without signalling anything real.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BROWSER_MARKER_SWITCH,
  BrowserRuntimeRefusedError,
  CONTAINER_CHROMIUM_ARGS,
  DEFAULT_LAUNCH_TIMEOUT_MS,
  buildLaunchOptions,
  closeAllBrowsers,
  closeBrowserWithin,
  forceKillAllBrowsersSync,
  launchBrowser,
  openBrowserCount,
  releaseBrowserResources,
  __resetBrowserRegistryForTests,
  __setBrowserRuntimeEnvForTests,
  __setLauncherDepsForTests,
} from '../../services/browserRuntime/browserLauncher';
import { BROWSER_RUNTIME_REFUSED } from '../../services/browserRuntime/browserRuntimeEnv';
import * as rpaEnv from '../../services/rpaWorker/rpaEnv';

const WORKER = { OMNIVYRA_BROWSER_RUNTIME: 'worker' };

type FakeBrowser = {
  on: jest.Mock;
  close: jest.Mock;
  isConnected: jest.Mock;
  emit: (event: string) => void;
};
function fakeBrowser(close: () => Promise<unknown> = async () => undefined): FakeBrowser {
  const handlers = new Map<string, () => void>();
  return {
    on: jest.fn((event: string, fn: () => void) => { handlers.set(event, fn); }),
    close: jest.fn(close),
    isConnected: jest.fn(() => true),
    emit: (event: string) => handlers.get(event)?.(),
  };
}
const never = () => new Promise<never>(() => undefined);

function fakePlaywright(browsers: FakeBrowser[]) {
  const queue = [...browsers];
  const launch = jest.fn(async (_opts?: unknown) => queue.shift());
  return { launch, pw: { chromium: { launch } } as any };
}
/** The registry id the launcher embedded in the n-th launch's args. */
function launchedId(launch: jest.Mock, n = 0): string {
  const args: string[] = launch.mock.calls[n][0].args;
  const marker = args.find((a) => a.startsWith(BROWSER_MARKER_SWITCH));
  if (!marker) throw new Error('no marker switch in launch args');
  return marker.slice(BROWSER_MARKER_SWITCH.length);
}

let procRoot: string;
let kill: jest.Mock;
function addProc(pid: number, argv: string[]): void {
  fs.mkdirSync(path.join(procRoot, String(pid)), { recursive: true });
  fs.writeFileSync(path.join(procRoot, String(pid), 'cmdline'), argv.join('\0') + '\0');
}

beforeEach(() => {
  __resetBrowserRegistryForTests();
  procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'));
  kill = jest.fn();
  __setLauncherDepsForTests({ procRoot, platform: 'linux', kill });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  __setBrowserRuntimeEnvForTests(null);
  __setLauncherDepsForTests(null);
  rpaEnv.__setRpaPlaywrightLoaderForTests(null);
  rpaEnv.__resetRpaEnvStateForTests();
  __resetBrowserRegistryForTests();
  fs.rmSync(procRoot, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('runtime gate', () => {
  it('refuses outside the worker runtime before playwright is touched', async () => {
    __setBrowserRuntimeEnvForTests({});
    const { launch, pw } = fakePlaywright([fakeBrowser()]);
    const err = await launchBrowser({ purpose: 'unit', playwright: pw }).catch((e) => e);
    expect(err).toBeInstanceOf(BrowserRuntimeRefusedError);
    expect(err.code).toBe(BROWSER_RUNTIME_REFUSED);
    expect(err.reason).toBe('not_browser_worker');
    expect(launch).not.toHaveBeenCalled();
    expect(openBrowserCount()).toBe(0);
  });

  it('refuses on Vercel even when the worker variable leaked into its env', async () => {
    __setBrowserRuntimeEnvForTests({ ...WORKER, VERCEL: '1' });
    const { launch, pw } = fakePlaywright([fakeBrowser()]);
    const err = await launchBrowser({ purpose: 'unit', playwright: pw }).catch((e) => e);
    expect(err.reason).toBe('vercel_runtime');
    expect(launch).not.toHaveBeenCalled();
  });

  it('reads the real process.env when no override is set (jest is not the worker)', async () => {
    expect(process.env.OMNIVYRA_BROWSER_RUNTIME).toBeUndefined();
    const { launch, pw } = fakePlaywright([fakeBrowser()]);
    await expect(launchBrowser({ purpose: 'unit', playwright: pw })).rejects.toMatchObject({ code: BROWSER_RUNTIME_REFUSED });
    expect(launch).not.toHaveBeenCalled();
  });

  it('CONTROL: the worker runtime does launch (the spy is wired)', async () => {
    __setBrowserRuntimeEnvForTests(WORKER);
    const { launch, pw } = fakePlaywright([fakeBrowser()]);
    await launchBrowser({ purpose: 'unit', playwright: pw });
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe('launch options', () => {
  it('container args, sandbox off (root image), no own signal handlers, bounded timeout, marker last', () => {
    const o = buildLaunchOptions('abc');
    expect(o.headless).toBe(true);
    expect(o.chromiumSandbox).toBe(false);
    expect(o.handleSIGINT).toBe(false);
    expect(o.handleSIGTERM).toBe(false);
    expect(o.handleSIGHUP).toBe(false);
    expect(o.timeout).toBe(DEFAULT_LAUNCH_TIMEOUT_MS);
    expect(o.args).toEqual(['--disable-dev-shm-usage', '--disable-gpu', `${BROWSER_MARKER_SWITCH}abc`]);
    expect(o.args).not.toContain('--single-process');
    expect(o.args).not.toContain('--no-zygote');
    expect(o).not.toHaveProperty('proxy');
  });

  it('honours a custom timeout, extra args and a proxy', () => {
    const o = buildLaunchOptions('x', { timeoutMs: 1234, extraArgs: ['--foo'], proxy: { server: 'http://127.0.0.1:9' } });
    expect(o.timeout).toBe(1234);
    expect(o.args).toEqual([...CONTAINER_CHROMIUM_ARGS, '--foo', `${BROWSER_MARKER_SWITCH}x`]);
    expect(o.proxy).toEqual({ server: 'http://127.0.0.1:9' });
  });

  it('launchBrowser passes exactly buildLaunchOptions(id) to chromium.launch', async () => {
    __setBrowserRuntimeEnvForTests(WORKER);
    const { launch, pw } = fakePlaywright([fakeBrowser()]);
    await launchBrowser({ purpose: 'unit', playwright: pw, timeoutMs: 999 });
    expect(launch.mock.calls[0][0]).toEqual(buildLaunchOptions(launchedId(launch), { timeoutMs: 999 }));
  });

  it('a launch error propagates unchanged and registers nothing', async () => {
    __setBrowserRuntimeEnvForTests(WORKER);
    const launch = jest.fn(async () => { throw new Error('browserType.launch: Executable doesn\'t exist'); });
    await expect(launchBrowser({ purpose: 'unit', playwright: { chromium: { launch } } as any }))
      .rejects.toThrow("Executable doesn't exist");
    expect(openBrowserCount()).toBe(0);
  });
});

describe('registry', () => {
  beforeEach(() => __setBrowserRuntimeEnvForTests(WORKER));

  it('adds on launch, removes on disconnect', async () => {
    const a = fakeBrowser();
    const { pw } = fakePlaywright([a]);
    await launchBrowser({ purpose: 'unit', playwright: pw });
    expect(openBrowserCount()).toBe(1);
    a.emit('disconnected');
    expect(openBrowserCount()).toBe(0);
  });

  it('removes on a successful close', async () => {
    const a = fakeBrowser();
    const { pw } = fakePlaywright([a]);
    const b = await launchBrowser({ purpose: 'unit', playwright: pw });
    await expect(closeBrowserWithin(b, 1000)).resolves.toBe('closed');
    expect(openBrowserCount()).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('closeAllBrowsers', () => {
  beforeEach(() => __setBrowserRuntimeEnvForTests(WORKER));

  it('closes what closes and force-kills (process group, SIGKILL) what hangs', async () => {
    const good = fakeBrowser();
    const hung = fakeBrowser(never);
    const { launch, pw } = fakePlaywright([good, hung]);
    await launchBrowser({ purpose: 'good', playwright: pw });
    await launchBrowser({ purpose: 'hung', playwright: pw });
    addProc(4242, ['/ms-playwright/headless_shell', '--disable-gpu', `${BROWSER_MARKER_SWITCH}${launchedId(launch, 1)}`]);
    addProc(4243, ['/ms-playwright/headless_shell', '--type=renderer']);
    addProc(1, ['node', 'dist/backend/workers/main.js']);

    const out = await closeAllBrowsers(30);
    expect(out).toEqual({ total: 2, closed: 1, force_killed: 1, failed: 0 });
    expect(good.close).toHaveBeenCalledTimes(1);
    expect(hung.close).toHaveBeenCalledTimes(1); // graceful attempt FIRST
    expect(kill.mock.calls).toEqual([[-4242, 'SIGKILL']]);
    expect(openBrowserCount()).toBe(0);
  });

  it('falls back to the single pid when the group kill throws', async () => {
    const hung = fakeBrowser(never);
    const { launch, pw } = fakePlaywright([hung]);
    await launchBrowser({ purpose: 'hung', playwright: pw });
    addProc(77, ['chrome', `${BROWSER_MARKER_SWITCH}${launchedId(launch)}`]);
    kill.mockImplementationOnce(() => { throw new Error('ESRCH'); });
    await expect(closeAllBrowsers(10)).resolves.toMatchObject({ force_killed: 1 });
    expect(kill.mock.calls).toEqual([[-77, 'SIGKILL'], [77, 'SIGKILL']]);
  });

  it('CONTROL: a hung browser with no marked process is reported failed, nothing is killed', async () => {
    const hung = fakeBrowser(never);
    const { pw } = fakePlaywright([hung]);
    await launchBrowser({ purpose: 'hung', playwright: pw });
    addProc(4242, ['/ms-playwright/headless_shell', `${BROWSER_MARKER_SWITCH}some-other-id`]);
    await expect(closeAllBrowsers(10)).resolves.toEqual({ total: 1, closed: 0, force_killed: 0, failed: 1 });
    expect(kill).not.toHaveBeenCalled();
    expect(openBrowserCount()).toBe(0);
  });

  it('a close that rejects on an already-disconnected browser counts as closed', async () => {
    const dead = fakeBrowser(async () => { throw new Error('Target closed'); });
    dead.isConnected.mockReturnValue(false);
    const { pw } = fakePlaywright([dead]);
    await launchBrowser({ purpose: 'crashed', playwright: pw });
    await expect(closeAllBrowsers(100)).resolves.toEqual({ total: 1, closed: 1, force_killed: 0, failed: 0 });
  });

  it('forceKillAllBrowsersSync signals every registered browser without awaiting', async () => {
    const { launch, pw } = fakePlaywright([fakeBrowser(never), fakeBrowser(never)]);
    await launchBrowser({ purpose: 'a', playwright: pw });
    await launchBrowser({ purpose: 'b', playwright: pw });
    addProc(10, ['x', `${BROWSER_MARKER_SWITCH}${launchedId(launch, 0)}`]);
    addProc(11, ['x', `${BROWSER_MARKER_SWITCH}${launchedId(launch, 1)}`]);
    expect(forceKillAllBrowsersSync()).toBe(2);
    expect(kill.mock.calls.map((c) => c[0]).sort((x, y) => x - y)).toEqual([-11, -10]);
    expect(openBrowserCount()).toBe(0);
  });

  it('never looks at /proc off Linux', async () => {
    __setLauncherDepsForTests({ procRoot, platform: 'win32', kill });
    const { launch, pw } = fakePlaywright([fakeBrowser(never)]);
    await launchBrowser({ purpose: 'win', playwright: pw });
    addProc(5, ['x', `${BROWSER_MARKER_SWITCH}${launchedId(launch)}`]);
    await expect(closeAllBrowsers(10)).resolves.toMatchObject({ failed: 1 });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('releaseBrowserResources (close in finally)', () => {
  beforeEach(() => __setBrowserRuntimeEnvForTests(WORKER));

  it('a throwing page close and a hanging context close still close the browser, and nothing throws', async () => {
    const browser = fakeBrowser();
    const { pw } = fakePlaywright([browser]);
    const b = await launchBrowser({ purpose: 'unit', playwright: pw });
    const page = { close: jest.fn(async () => { throw new Error('page gone'); }) };
    const context = { close: jest.fn(never) };
    const out = await releaseBrowserResources({ page, context, browser: b }, 20);
    expect(out).toEqual({ page: 'error', context: 'timeout', browser: 'closed' });
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(openBrowserCount()).toBe(0);
  });

  it('a throwing browser close is force-killed, not thrown', async () => {
    const browser = fakeBrowser(async () => { throw new Error('close failed'); });
    const { launch, pw } = fakePlaywright([browser]);
    const b = await launchBrowser({ purpose: 'unit', playwright: pw });
    addProc(900, ['chrome', `${BROWSER_MARKER_SWITCH}${launchedId(launch)}`]);
    await expect(releaseBrowserResources({ browser: b }, 50)).resolves.toEqual({ page: 'none', context: 'none', browser: 'force_killed' });
    expect(kill).toHaveBeenCalledWith(-900, 'SIGKILL');
  });

  it('is a no-op on nulls (a launch that never happened)', async () => {
    await expect(releaseBrowserResources({ page: null, context: null, browser: null })).resolves.toEqual({ page: 'none', context: 'none', browser: 'none' });
  });
});

describe('rpaEnv probe goes through the gate', () => {
  it('outside the worker the probe reports the refusal code and launches nothing', async () => {
    const { launch, pw } = fakePlaywright([fakeBrowser()]);
    rpaEnv.__setRpaPlaywrightLoaderForTests(async () => pw);
    __setBrowserRuntimeEnvForTests({}); // after the seam (which simulates the worker image)
    const r = await rpaEnv.rpaEnvReady();
    expect(r).toEqual({ ok: false, reason: `${BROWSER_RUNTIME_REFUSED}:not_browser_worker` });
    expect(launch).not.toHaveBeenCalled();
  });

  it('CONTROL: with the loader seam (worker simulated) the probe launches through the launcher and closes', async () => {
    const browser = fakeBrowser();
    const { launch, pw } = fakePlaywright([browser]);
    rpaEnv.__setRpaPlaywrightLoaderForTests(async () => pw);
    await expect(rpaEnv.rpaEnvReady()).resolves.toEqual({ ok: true });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][0]).toMatchObject({ chromiumSandbox: false, handleSIGTERM: false });
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(openBrowserCount()).toBe(0);
  });
});
