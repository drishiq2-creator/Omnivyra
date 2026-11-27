/**
 * Where may a real browser (Playwright Chromium) be launched?
 *
 * Only on the designated worker image. Dockerfile.worker sets
 * OMNIVYRA_BROWSER_RUNTIME=worker. Vercel (VERCEL set) never launches a browser,
 * even if the variable leaks into its environment. Anything else (local dev,
 * tests, the web app) is not a browser runtime unless the variable is set
 * explicitly - fail closed.
 */
export const BROWSER_RUNTIME_ENV = 'OMNIVYRA_BROWSER_RUNTIME';
export const BROWSER_RUNTIME_WORKER = 'worker';

export type BrowserRuntimeDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'vercel_runtime' | 'not_browser_worker' };

export function browserRuntimeDecision(
  env: Record<string, string | undefined> = process.env,
): BrowserRuntimeDecision {
  if (env.VERCEL) return { allowed: false, reason: 'vercel_runtime' };
  if (env[BROWSER_RUNTIME_ENV] !== BROWSER_RUNTIME_WORKER) return { allowed: false, reason: 'not_browser_worker' };
  return { allowed: true };
}

export function isBrowserWorkerRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return browserRuntimeDecision(env).allowed;
}

/** Stable error code for refused launches; callers classify it as "not attempted" (safe to queue for the worker). */
export const BROWSER_RUNTIME_REFUSED = 'BROWSER_RUNTIME_NOT_WORKER';
