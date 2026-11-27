/**
 * Review N-5 — rpaEnv's readiness probe refuses outside the browser worker with NO
 * fake loader installed. The existing launcher tests install a fake Playwright via
 * __setRpaPlaywrightLoaderForTests, and that seam flips the runtime gate to
 * 'worker', so they never exercised the refusal on the real code path.
 *
 * Here: no loader seam, no runtime override, the real process.env (jest is not the
 * worker image). launchBrowser is replaced by a spy that fails the test if it is
 * ever reached, so a real Chromium can never be launched by this file.
 */
const mockLaunchSpy = jest.fn(async () => { throw new Error('SPY_LAUNCH_REACHED'); });
jest.mock('../../services/browserRuntime/browserLauncher', () => ({
  ...jest.requireActual('../../services/browserRuntime/browserLauncher'),
  launchBrowser: (...a: unknown[]) => (mockLaunchSpy as any)(...a),
}));

import * as rpaEnv from '../../services/rpaWorker/rpaEnv';
import { BROWSER_RUNTIME_REFUSED } from '../../services/browserRuntime/browserRuntimeEnv';

const KEYS = ['OMNIVYRA_BROWSER_RUNTIME', 'VERCEL'] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; });
afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  rpaEnv.__resetRpaEnvStateForTests();
  mockLaunchSpy.mockClear();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('rpaEnv probe outside the worker, no fake loader installed', () => {
  it('refuses with the stable runtime code and never reaches the launcher', async () => {
    const r = await rpaEnv.rpaEnvReady();
    expect(r).toEqual({ ok: false, reason: `${BROWSER_RUNTIME_REFUSED}:not_browser_worker` });
    expect(mockLaunchSpy).not.toHaveBeenCalled();
  });

  it('refuses on Vercel even with the worker variable set', async () => {
    process.env.OMNIVYRA_BROWSER_RUNTIME = 'worker';
    process.env.VERCEL = '1';
    const r = await rpaEnv.rpaEnvReady();
    expect(r).toEqual({ ok: false, reason: `${BROWSER_RUNTIME_REFUSED}:vercel_runtime` });
    expect(mockLaunchSpy).not.toHaveBeenCalled();
  });

  it('CONTROL: as the worker (same real path, no loader) the refusal is gone - the probe goes on to Playwright', async () => {
    process.env.OMNIVYRA_BROWSER_RUNTIME = 'worker';
    const r = await rpaEnv.rpaEnvReady();
    expect(r.ok).toBe(false); // the launch spy (or a missing module under jest) fails it; never a real launch
    expect((r as { reason: string }).reason.startsWith(BROWSER_RUNTIME_REFUSED)).toBe(false);
  });
});
