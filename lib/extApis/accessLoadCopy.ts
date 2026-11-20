/**
 * /external-apis-access load failures (2026-11-20). A failed read is never shown as an empty list:
 * "No requests in the queue." / "No APIs are currently available." are only for a read that succeeded
 * and returned nothing. Own module so tests that factory-mock the hook or fetch still see these.
 */
export const REQUESTS_LOAD_FAILED =
  "We couldn't load the request queue, so we can't tell whether any requests are waiting.";
export const APIS_LOAD_FAILED =
  "We couldn't load your company's APIs, so we can't show which ones are on.";
export const RETRY_LABEL = 'Retry';
