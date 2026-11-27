/**
 * 24C (d) — runner classification. Once the runner has issued a
 * state-changing interaction (click / fill / press / text insert), a crash,
 * lost response or missed post-condition does NOT prove the action failed:
 * the reply may be posted or the like toggled. Such a result must carry
 * `outcome_unknown: true` (never a plain definite failure), so neither the
 * retry flush nor the in-process queue re-executes it.
 *
 * Real runRpaScript; Playwright is a fake module injected through the rpaEnv
 * loader seam (no browser). Session / resolver / cancellation / artifact
 * stores are stubbed.
 */

jest.mock('../../services/rpaWorker/rpaSessionStore', () => ({
  loadRpaSession: jest.fn(async () => ({ cookies: [], origins: [] })),
}));
const resolveSelector = jest.fn();
const waitForAny = jest.fn();
jest.mock('../../services/rpaWorker/selectorResolver', () => ({
  resolveSelector: (...a: unknown[]) => resolveSelector(...a),
  waitForAny: (...a: unknown[]) => waitForAny(...a),
}));
jest.mock('../../services/rpaWorker/rpaCancellationChecker', () => {
  class RpaCancelledError extends Error {}
  return { makeCancellationChecker: () => async () => false, RpaCancelledError };
});
jest.mock('../../services/rpaWorker/rpaArtifactStore', () => ({
  saveRpaArtifact: jest.fn(async () => null),
}));

import { runRpaScript, type RpaScript } from '../../services/rpaWorker/rpaPlaywrightRunner';
import * as rpaEnv from '../../services/rpaWorker/rpaEnv';

const page = {
  goto: jest.fn(async () => undefined),
  waitForTimeout: jest.fn(async () => undefined),
  screenshot: jest.fn(async () => Buffer.from('')),
  close: jest.fn(async () => undefined),
  keyboard: { insertText: jest.fn(async () => undefined) },
};
const launch = jest.fn(async () => ({
  newContext: async () => ({ newPage: async () => page, close: async () => undefined }),
  close: async () => undefined,
}));

const task = {
  tenant_id: 'org-1', organization_id: 'org-1', platform: 'linkedin', action_type: 'like' as const,
  target_url: 'https://www.linkedin.com/feed/update/urn:1', action_id: 'act-1',
};
const LIKE: RpaScript = {
  targetUrl: task.target_url,
  steps: [{ kind: 'click', selectors: [{ css: 'button.like' } as any] }],
  postCondition: { kind: 'selector_visible', selectors: [{ css: 'button.liked' } as any] },
};

beforeEach(() => {
  rpaEnv.__resetRpaEnvStateForTests();
  rpaEnv.__setRpaPlaywrightLoaderForTests(async () => ({ chromium: { launch } }));
  resolveSelector.mockReset();
  waitForAny.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  rpaEnv.__setRpaPlaywrightLoaderForTests(null);
});

describe('runRpaScript outcome classification (24C d)', () => {
  it('click issued, post-condition not seen: outcome_unknown, not a definite failure', async () => {
    const click = jest.fn(async () => undefined);
    resolveSelector.mockResolvedValue({ click });
    waitForAny.mockResolvedValue(false);
    const r = await runRpaScript(task, LIKE);
    expect(click).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(false);
    expect(r.outcome_unknown).toBe(true);
    expect(r.error).toBe('RPA_OUTCOME_UNKNOWN:RPA_POST_CONDITION_FAILED');
  });

  it('browser dies during the click (lost response): outcome_unknown, first line only', async () => {
    resolveSelector.mockResolvedValue({
      click: jest.fn(async () => { throw new Error('elementHandle.click: Target page, context or browser has been closed\nCall log:\n  - ...'); }),
    });
    const r = await runRpaScript(task, LIKE);
    expect(r.outcome_unknown).toBe(true);
    expect(r.error).toBe('RPA_OUTCOME_UNKNOWN:elementHandle.click: Target page, context or browser has been closed');
  });

  it('CONTROL: selector never resolved (nothing touched): definite failure, no unknown flag', async () => {
    resolveSelector.mockResolvedValue(null);
    const r = await runRpaScript(task, LIKE);
    expect(r).toEqual({ success: false, error: 'SELECTOR_NOT_FOUND' });
  });

  it('CONTROL: no interaction step + post-condition miss stays a definite failure', async () => {
    waitForAny.mockResolvedValue(false);
    const r = await runRpaScript(task, { ...LIKE, steps: [] });
    expect(r.success).toBe(false);
    expect(r.outcome_unknown).toBeUndefined();
    expect(r.error).toBe('RPA_POST_CONDITION_FAILED');
  });

  it('CONTROL: confirmed click is a success', async () => {
    resolveSelector.mockResolvedValue({ click: jest.fn(async () => undefined) });
    waitForAny.mockResolvedValue(true);
    const r = await runRpaScript(task, LIKE);
    expect(r.success).toBe(true);
    expect(r.outcome_unknown).toBeUndefined();
  });
});
