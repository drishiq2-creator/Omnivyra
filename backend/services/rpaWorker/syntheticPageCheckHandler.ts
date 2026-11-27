import type { RpaTask, RpaResult } from './rpaWorkerService';

/**
 * Synthetic execution handler (Phase C). Exists ONLY so the full RPA pipeline
 * (accept -> claim -> execute -> record outcome -> release) can be exercised end
 * to end without any real platform: no browser, no selector, no account, no
 * message. It is registered under the platform key `synthetic_page_check`.
 *
 * Targets it accepts, and nothing else:
 *   - data: URLs                     -> checked in process, no network at all;
 *   - http(s)://127.0.0.1[:port]/... -> one GET, redirects refused;
 *   - http(s)://localhost[:port]/... -> one GET, redirects refused.
 * Anything else (any other host, userinfo, file:, javascript:, ...) is refused
 * as a TERMINAL failure before any I/O.
 *
 * Off unless RPA_SYNTHETIC_HANDLER_ENABLED=true: when off it refuses (terminal,
 * nothing attempted). The loopback GET is a tiny SSRF surface on whatever host
 * runs the worker, so it must be switched on deliberately for a pipeline check.
 * NEVER in production (review N-4): with NODE_ENV=production it refuses even when
 * the flag is set (a leaked flag must not open the loopback GET on the
 * production worker, whose image sets NODE_ENV=production).
 */
export const SYNTHETIC_PAGE_CHECK_PLATFORM = 'synthetic_page_check';
export const SYNTHETIC_HANDLER_ENV = 'RPA_SYNTHETIC_HANDLER_ENABLED';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const FETCH_TIMEOUT_MS = 5_000;
const MAX_DATA_URL_CHARS = 64 * 1024;

export type SyntheticTarget =
  | { ok: true; kind: 'data'; url: string }
  | { ok: true; kind: 'loopback'; url: string }
  | { ok: false; error: string };

export function classifySyntheticTarget(raw: unknown): SyntheticTarget {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, error: 'SYNTHETIC_TARGET_REQUIRED' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'SYNTHETIC_TARGET_INVALID' };
  }
  if (url.protocol === 'data:') {
    if (text.length > MAX_DATA_URL_CHARS) return { ok: false, error: 'SYNTHETIC_TARGET_TOO_LARGE' };
    return { ok: true, kind: 'data', url: text };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'SYNTHETIC_TARGET_SCHEME_REFUSED' };
  }
  if (url.username || url.password) return { ok: false, error: 'SYNTHETIC_TARGET_USERINFO_REFUSED' };
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, error: 'SYNTHETIC_TARGET_HOST_REFUSED' };
  }
  return { ok: true, kind: 'loopback', url: url.toString() };
}

type FetchLike = (url: string, init: { method: 'GET'; redirect: 'error'; signal: AbortSignal }) => Promise<{ status: number }>;

export function createSyntheticPageCheckHandler(deps?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}): (task: RpaTask) => Promise<RpaResult> {
  return async (task: RpaTask): Promise<RpaResult> => {
    const env = deps?.env ?? process.env;
    if (env.NODE_ENV === 'production') {
      return { success: false, terminal: true, error: 'SYNTHETIC_HANDLER_REFUSED_IN_PRODUCTION' };
    }
    if (env[SYNTHETIC_HANDLER_ENV] !== 'true') {
      return { success: false, terminal: true, error: 'SYNTHETIC_HANDLER_DISABLED' };
    }
    const target = classifySyntheticTarget(task?.target_url);
    if (target.ok === false) return { success: false, terminal: true, error: target.error };

    if (target.kind === 'data') {
      const comma = target.url.indexOf(',');
      const body = comma >= 0 ? target.url.slice(comma + 1) : '';
      return body.length > 0
        ? { success: true, platform_id: `synthetic:data:${body.length}` }
        : { success: false, terminal: true, error: 'SYNTHETIC_DATA_EMPTY' };
    }

    const fetchImpl: FetchLike | undefined = deps?.fetchImpl ?? (globalThis as any).fetch;
    if (typeof fetchImpl !== 'function') return { success: false, error: 'SYNTHETIC_FETCH_UNAVAILABLE' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(target.url, { method: 'GET', redirect: 'error', signal: controller.signal });
      if (res.status >= 200 && res.status < 300) {
        return { success: true, platform_id: `synthetic:http:${res.status}` };
      }
      return { success: false, error: `SYNTHETIC_HTTP_${res.status}` };
    } catch (err: any) {
      // A GET to loopback has no side effect, so a failure is definite.
      return { success: false, error: `SYNTHETIC_FETCH_FAILED:${String(err?.message || err).split(/\r?\n/)[0].slice(0, 120)}` };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const syntheticPageCheckHandler = createSyntheticPageCheckHandler();
