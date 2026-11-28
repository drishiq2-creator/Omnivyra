/**
 * GI-NEW-1 — the worker owns shutdown signals, not Playwright.
 *
 * Playwright's launch options default handleSIGTERM / handleSIGINT / handleSIGHUP
 * to TRUE. That installs a process-level listener which, on the first SIGTERM,
 * gracefully closes EVERY browser this process launched. The Railway worker
 * (backend/workers/main.ts) answers SIGTERM by DRAINING — worker.close() waits
 * for in-flight jobs up to the drain deadline — so with the defaults an
 * in-flight Chromium job lost its browser the moment a redeploy began, while
 * the worker was still waiting for that job ("Target page, context or browser
 * has been closed"; proven with the real worker image, GH Actions run
 * 46067276601).
 *
 * With all three false, Playwright installs no signal listener; the drain in
 * main.ts decides when the process ends. Browsers are still torn down at the
 * end: Playwright ALWAYS installs a process 'exit' listener that SIGKILLs each
 * launched browser's process group, and main.ts ends every shutdown path with
 * process.exit(0) (normal end of shutdown, or the hard-exit backstop).
 *
 * Every Playwright launch under backend/ and lib/ goes through
 * withWorkerSignalOwnership(); backend/tests/unit/playwrightSignalOwnership.test.ts
 * scans the source and fails on a launch call that does not.
 */

export const WORKER_OWNS_SHUTDOWN_SIGNALS = Object.freeze({
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
} as const);

/**
 * Returns `options` with the three signal flags forced to false. The flags are
 * applied LAST, so a caller cannot re-enable them by accident.
 */
export function withWorkerSignalOwnership<T extends object>(
  options: T,
): T & typeof WORKER_OWNS_SHUTDOWN_SIGNALS {
  return { ...options, ...WORKER_OWNS_SHUTDOWN_SIGNALS };
}
