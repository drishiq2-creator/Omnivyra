/**
 * Authenticated client-side fetch.
 * Adds Supabase Bearer token so API routes can verify identity.
 * Safe to call from any browser context — returns plain fetch on SSR/no-session.
 *
 * Network-failure behavior: if `fetch()` throws (TypeError: Failed to fetch
 * — typical when the dev server is mid-HMR-recompile, the route bundle is
 * stale, the network is offline, or a CORS preflight fails), this wrapper
 * returns a SYNTHETIC non-ok Response instead of letting the error propagate.
 * Callers all check `r.ok` and handle non-2xx uniformly; this keeps them on
 * the happy code path and stops the Next.js dev overlay from rendering a red
 * "Failed to fetch" runtime error every time the dev server blips.
 *
 * The synthetic response is NOT a 503 (b3, 2026-11-20, pre-launch blocking).
 * A lost connection is an UNKNOWN outcome: the request may have reached the
 * server and run. Several screens read a server 503 as "refused before
 * anything happened" ("Nothing was started / charged / submitted"), so a
 * synthetic 503 made those screens state a protection that did not hold.
 * It is now status NETWORK_FAILURE_STATUS (599, never sent by our server)
 * with code NETWORK_UNREACHABLE; detect it with isNetworkFailure(res) and
 * show "not sure it went through", never a server-refusal message.
 * Real auth/permission failures are 401/403 from the server itself and are
 * unaffected.
 */
import { getAuthToken } from '../utils/getAuthToken';
import { getSupabaseBrowser } from './supabaseBrowser';
import { NETWORK_FAILURE_CODE, NETWORK_FAILURE_HEADER, NETWORK_FAILURE_STATUS } from './networkFailure';

// Re-exported for convenience; components should import from lib/networkFailure (see its header).
export { NETWORK_FAILURE_CODE, NETWORK_FAILURE_STATUS, isNetworkFailure } from './networkFailure';

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let token: string | undefined;
  try {
    const t = await getAuthToken();
    if (t) token = t;
  } catch {
    // Unauthenticated — proceed without Authorization header
  }
  // ONE-SHOT recovery: getSession() can transiently return null under
  // processLock contention or when the in-memory access_token has just been
  // rotated. Force-refresh once and re-read before giving up on the Bearer
  // header. No retry loop — a single attempt is enough; persistent failure
  // means the user really isn't signed in.
  if (!token) {
    try {
      await getSupabaseBrowser().auth.refreshSession();
      const t2 = await getAuthToken();
      if (t2) token = t2;
    } catch {
      // Refresh unavailable — proceed without Authorization header
    }
  }
  try {
    return await fetch(input, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (err) {
    // A client-initiated abort is NOT a server failure — it means the caller
    // gave up waiting (e.g. its own AbortController timeout fired). Re-throw it
    // so the caller's abort/timeout handling runs, instead of masking it as a
    // synthetic 503. Masking an abort as a 5xx is what surfaced the spurious
    // PROFILE_LOAD_FAILED "couldn't load your workspace" banner on slow dev
    // compiles: the 8s loader timeout aborted mid-compile, apiFetch turned that
    // into a 503, and the workspace loader treated the 5xx as a hard error
    // instead of taking its silent transient-retry path. This restores standard
    // fetch() abort semantics; callers that never pass a `signal` never hit it.
    const aborted =
      (err instanceof Error && err.name === 'AbortError') ||
      (init.signal instanceof AbortSignal && init.signal.aborted);
    if (aborted) {
      throw err;
    }
    // Synthesize a non-ok Response so callers' `if (r.ok)` branches still take
    // their failure path. Body shape matches the JSON-error pattern most API
    // routes use. NOT a 503 (see the header comment): status 599 + code
    // NETWORK_UNREACHABLE + a marker header, so no caller can mistake a lost
    // connection for a server refusal.
    const message = err instanceof Error ? err.message : String(err);
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[apiFetch] network error → synthetic network-failure response:', input, message);
    }
    return new Response(
      JSON.stringify({ error: 'Network unreachable', code: NETWORK_FAILURE_CODE, detail: message }),
      {
        status: NETWORK_FAILURE_STATUS,
        statusText: 'Network Unreachable',
        headers: { 'Content-Type': 'application/json', [NETWORK_FAILURE_HEADER]: '1' },
      },
    );
  }
}
