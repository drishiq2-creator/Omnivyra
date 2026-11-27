/**
 * Where may a gated browser launch (Playwright Chromium via browserLauncher.ts:
 * RPA, the RPA readiness probe, discovery and ads RPA) happen?
 *
 * Only on the designated worker image. Dockerfile.worker sets
 * OMNIVYRA_BROWSER_RUNTIME=worker. On Vercel (VERCEL set) this gate refuses,
 * even if the variable leaks into its environment. Anything else (local dev,
 * tests, the web app) is not a browser runtime unless the variable is set
 * explicitly - fail closed.
 *
 * SCOPE (review N-7): this gate covers launches that go through
 * browserLauncher.ts. It does NOT cover the web app's PDF export
 * (backend/services/export/htmlToPdfRenderer.ts), which deliberately launches
 * its own headless Chromium on the web tier (@sparticuz/chromium on Vercel,
 * Playwright in local dev) to render report PDFs. So "Vercel never launches
 * Chromium" is NOT true; "Vercel never launches a gated (automation) browser" is.
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
