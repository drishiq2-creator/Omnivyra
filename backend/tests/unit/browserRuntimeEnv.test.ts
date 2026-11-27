import { browserRuntimeDecision, isBrowserWorkerRuntime } from '../../services/browserRuntime/browserRuntimeEnv';

describe('browserRuntimeEnv', () => {
  it('allows only the worker image', () => {
    expect(isBrowserWorkerRuntime({ OMNIVYRA_BROWSER_RUNTIME: 'worker' })).toBe(true);
  });
  it('refuses Vercel even with the worker variable set', () => {
    expect(browserRuntimeDecision({ VERCEL: '1', OMNIVYRA_BROWSER_RUNTIME: 'worker' })).toEqual({ allowed: false, reason: 'vercel_runtime' });
  });
  it('fails closed when unset or any other value', () => {
    expect(browserRuntimeDecision({})).toEqual({ allowed: false, reason: 'not_browser_worker' });
    expect(isBrowserWorkerRuntime({ OMNIVYRA_BROWSER_RUNTIME: 'Worker' })).toBe(false);
    expect(isBrowserWorkerRuntime({ OMNIVYRA_BROWSER_RUNTIME: 'true' })).toBe(false);
  });
});
