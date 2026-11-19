/**
 * apiFetch's lost-connection outcome (b3, 2026-11-20, pre-launch blocking).
 *
 * When fetch() throws, apiFetch answers with a synthetic non-ok Response so callers stay on their
 * `!r.ok` path. It is NOT a 503: a lost connection is an UNKNOWN outcome (the request may have reached
 * the server and run), while several screens read a server 503 as "refused before anything happened"
 * ("Nothing was started / charged / submitted"). It is status NETWORK_FAILURE_STATUS (599, never sent by
 * our API) with code NETWORK_FAILURE_CODE and a marker header.
 *
 * Kept in its own module (not lib/apiFetch) so the many tests that replace apiFetch with a factory mock
 * still see these real values in the components under test.
 */
export const NETWORK_FAILURE_STATUS = 599;
export const NETWORK_FAILURE_CODE = 'NETWORK_UNREACHABLE';
export const NETWORK_FAILURE_HEADER = 'x-omnivyra-network-failure';

/** True for apiFetch's synthetic lost-connection response (an UNKNOWN outcome), false for any server answer. */
export function isNetworkFailure(
  res: (Pick<Response, 'status'> & { headers?: Pick<Headers, 'get'> }) | null | undefined,
): boolean {
  if (!res) return false;
  if (res.status === NETWORK_FAILURE_STATUS) return true;
  try {
    return res.headers?.get(NETWORK_FAILURE_HEADER) === '1';
  } catch {
    return false;
  }
}
