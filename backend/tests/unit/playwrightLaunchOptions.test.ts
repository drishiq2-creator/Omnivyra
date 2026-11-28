/**
 * GI-NEW-1 — unit test of the shared launch-options helper.
 */
import {
  WORKER_OWNS_SHUTDOWN_SIGNALS,
  withWorkerSignalOwnership,
} from '../../services/playwrightLaunchOptions';

describe('withWorkerSignalOwnership', () => {
  it('sets all three Playwright signal flags to false', () => {
    const o = withWorkerSignalOwnership({ headless: true });
    expect(o.handleSIGTERM).toBe(false);
    expect(o.handleSIGINT).toBe(false);
    expect(o.handleSIGHUP).toBe(false);
  });

  it('keeps every caller option', () => {
    const o = withWorkerSignalOwnership({ headless: true, args: ['--no-sandbox'], executablePath: '/x/chrome' });
    expect(o).toEqual({
      headless: true,
      args: ['--no-sandbox'],
      executablePath: '/x/chrome',
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  });

  it('a caller cannot re-enable a flag (the flags are applied last)', () => {
    // Control: the raw input really does carry `true` — the override is what flips it.
    const input = { headless: true, handleSIGTERM: true, handleSIGINT: true, handleSIGHUP: true };
    expect(input.handleSIGTERM).toBe(true);
    const o = withWorkerSignalOwnership(input);
    expect(o.handleSIGTERM).toBe(false);
    expect(o.handleSIGINT).toBe(false);
    expect(o.handleSIGHUP).toBe(false);
  });

  it('does not mutate the caller object and returns a fresh one', () => {
    const input = { headless: true };
    const o = withWorkerSignalOwnership(input);
    expect(input).toEqual({ headless: true });
    expect(o).not.toBe(input);
  });

  it('the shared constant is frozen', () => {
    expect(Object.isFrozen(WORKER_OWNS_SHUTDOWN_SIGNALS)).toBe(true);
    expect(WORKER_OWNS_SHUTDOWN_SIGNALS).toEqual({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  });
});
