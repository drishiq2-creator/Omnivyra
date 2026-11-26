/**
 * RPA environment readiness probe. A worker that fails this check MUST
 * refuse to accept RPA tasks; executing without a working Playwright
 * runtime silently marks every task `failed`.
 *
 * The probe attempts a dynamic `import` of `playwright` and a one-shot
 * chromium launch, then closes.
 *
 *   - A successful probe is memoized for 5 minutes so hot-path dispatches
 *     don't relaunch browsers.
 *   - A FAILED probe is memoized with bounded exponential backoff
 *     (90 s, 180 s, 360 s ... capped at 30 min). Each real probe failure
 *     logs exactly ONE concise line (the first line of the launch error,
 *     never Playwright's multi-line call log); cached reads log nothing.
 *     The first failure of a streak additionally carries a compacted,
 *     bounded single-line detail so the root cause stays diagnosable.
 *   - A recovery logs one line and resets the backoff.
 *   - Concurrent callers share one in-flight probe (one browser launch).
 */

export type ProbeResult = { ok: true } | { ok: false; reason: string };

const SUCCESS_TTL_MS = 5 * 60 * 1000;
export const RPA_ENV_FAILURE_BACKOFF_BASE_MS = 90 * 1000;
export const RPA_ENV_FAILURE_BACKOFF_CAP_MS = 30 * 60 * 1000;
const REASON_MAX_CHARS = 200;
const DETAIL_MAX_CHARS = 1000;

let cached: { result: ProbeResult; at: number; ttlMs: number } | null = null;
let inFlight: Promise<ProbeResult> | null = null;
let failureStreak = 0;
let probesRun = 0;
let probesFailed = 0;

/** Backoff for the n-th consecutive failed probe (n >= 1). */
export function rpaEnvFailureBackoffMs(streak: number): number {
  const n = Math.max(1, Math.floor(streak));
  const ms = RPA_ENV_FAILURE_BACKOFF_BASE_MS * Math.pow(2, Math.min(n - 1, 30));
  return Math.min(RPA_ENV_FAILURE_BACKOFF_CAP_MS, ms);
}

/** First non-empty line of an error message, bounded. */
function conciseReason(raw: string): string {
  const first = (raw || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) || '';
  return first.length > REASON_MAX_CHARS ? `${first.slice(0, REASON_MAX_CHARS)}...` : first;
}

/** Whole message collapsed onto one line, bounded (first failure of a streak only). */
function compactDetail(raw: string): string {
  const one = (raw || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' | ');
  return one.length > DETAIL_MAX_CHARS ? `${one.slice(0, DETAIL_MAX_CHARS)}...` : one;
}

// Keep Playwright as a runtime-only dependency so production web builds
// can compile even when the RPA runtime is not installed.
/** Set by loadPlaywright() when the import throws — surfaced in the probe reason. */
let _lastImportError = '';

let playwrightLoaderOverride: (() => Promise<any>) | null = null;

async function loadPlaywright(): Promise<any | null> {
  try {
    if (playwrightLoaderOverride) return await playwrightLoaderOverride();
    const importer = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<any>;
    return await importer('playwright');
  } catch (err) {
    // Previously swallowed — the opaque PLAYWRIGHT_MODULE_MISSING_CHROMIUM
    // reason gave no way to tell a missing module from a load-time failure.
    _lastImportError = conciseReason((err as Error)?.message || String(err));
    return null;
  }
}

/**
 * Shared Playwright loader (the runner uses this too, so the probe and the
 * executed run resolve the same module). Null when it cannot be imported.
 */
export async function loadPlaywrightModule(): Promise<any | null> {
  return loadPlaywright();
}

/** One real probe. Returns the raw (possibly multi-line) reason on failure. */
async function runProbe(): Promise<ProbeResult> {
  try {
    const pw = await loadPlaywright();
    if (!pw?.chromium?.launch) {
      return {
        ok: false,
        reason: _lastImportError
          ? `PLAYWRIGHT_MODULE_MISSING_CHROMIUM: ${_lastImportError}`
          : 'PLAYWRIGHT_MODULE_MISSING_CHROMIUM',
      };
    }
    let browser: any = null;
    try {
      browser = await pw.chromium.launch({ headless: true });
      return { ok: true };
    } catch (err: any) {
      const msg = (err?.message || '').toString();
      if (msg.includes("Executable doesn't exist") || msg.includes('please run')) {
        return { ok: false, reason: 'PLAYWRIGHT_BROWSERS_NOT_INSTALLED' };
      }
      return { ok: false, reason: msg || 'PLAYWRIGHT_LAUNCH_FAILED' };
    } finally {
      try { if (browser) await browser.close(); } catch { /* swallow */ }
    }
  } catch {
    return { ok: false, reason: 'PLAYWRIGHT_NOT_INSTALLED' };
  }
}

function record(raw: ProbeResult): ProbeResult {
  probesRun += 1;
  const now = Date.now();
  if (raw.ok) {
    if (failureStreak > 0) {
      console.log(`[rpaEnv] probe recovered after ${failureStreak} failed probe(s); backoff reset`);
    }
    failureStreak = 0;
    cached = { result: { ok: true }, at: now, ttlMs: SUCCESS_TTL_MS };
    return cached.result;
  }
  probesFailed += 1;
  failureStreak += 1;
  const ttlMs = rpaEnvFailureBackoffMs(failureStreak);
  // `in` narrowing: the repo compiles with strict=false, where a boolean-literal discriminant (raw.ok)
  // does not narrow the ProbeResult union, so `raw.reason` is a type error there.
  const failReason = 'reason' in raw ? raw.reason : '';
  const reason = conciseReason(failReason) || 'PLAYWRIGHT_LAUNCH_FAILED';
  const detail = failureStreak === 1 ? compactDetail(failReason) : '';
  console.warn(
    `[rpaEnv] probe failed (streak=${failureStreak}); next probe in ${Math.round(ttlMs / 1000)}s: ${reason}` +
      (detail && detail !== reason ? ` || detail: ${detail}` : ''),
  );
  cached = { result: { ok: false, reason }, at: now, ttlMs };
  return cached.result;
}

export async function rpaEnvReady(): Promise<ProbeResult> {
  if (cached && Date.now() - cached.at < cached.ttlMs) {
    return cached.result;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      return record(await runProbe());
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function isProbeFailure(result: ProbeResult): result is Extract<ProbeResult, { ok: false }> {
  return result.ok === false;
}

/** Safe, secret-free probe counters for scheduler diagnostics. */
export function getRpaEnvProbeDiagnostics(): {
  probes_run: number;
  probes_failed: number;
  failure_streak: number;
  next_probe_in_s: number;
} {
  const nextMs = cached ? Math.max(0, cached.at + cached.ttlMs - Date.now()) : 0;
  return {
    probes_run: probesRun,
    probes_failed: probesFailed,
    failure_streak: failureStreak,
    next_probe_in_s: Math.ceil(nextMs / 1000),
  };
}

/**
 * Hard gate: throws when the env is not ready. Use at worker startup /
 * entrypoint so misconfigured workers fail loudly rather than silently
 * draining the task queue.
 */
export async function assertRpaEnvReady(): Promise<void> {
  const ready = await rpaEnvReady();
  if (isProbeFailure(ready)) {
    const err = new Error(`RPA_ENV_NOT_READY: ${ready.reason}`);
    (err as Error & { code?: string }).code = 'RPA_ENV_NOT_READY';
    throw err;
  }
}

/**
 * Invalidate the probe cache after a dependency install: the next call
 * probes immediately. The failure streak is kept so a recovery is still
 * logged once.
 */
export function resetRpaEnvCache(): void {
  cached = null;
}

/** Test-only: forget cache, streak and counters. */
export function __resetRpaEnvStateForTests(): void {
  cached = null;
  inFlight = null;
  failureStreak = 0;
  probesRun = 0;
  probesFailed = 0;
  _lastImportError = '';
}

/** Test-only: replace the dynamic `import('playwright')` (null restores it). */
export function __setRpaPlaywrightLoaderForTests(loader: (() => Promise<any>) | null): void {
  playwrightLoaderOverride = loader;
}
