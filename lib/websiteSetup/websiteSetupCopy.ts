/**
 * /website-setup: read-failure and unknown-outcome copy (audit F16-F18, U6, 2026-11-20). Own module so tests that
 * factory-mock page dependencies still see it.
 *
 * - A failed setup read never restarts the wizard at step 0 as if the site were new (Continue would then POST
 *   create_website). The wizard is not shown until the read succeeds.
 * - A lost/5xx write is "not sure", never "could not": the page then re-reads.
 * - A failed publishing-check REQUEST is not a publishing verdict.
 */
export const WEBSITE_SETUP_LOAD_FAILED =
  "We couldn't load your website setup, so we can't tell where you left off.";
export const WEBSITE_ALREADY_SET_UP = 'This site is already set up. We reloaded your setup so you can continue.';
export const WEBSITE_SAVE_UNKNOWN = "We're not sure your website was saved. We reloaded your setup to check.";
export const CONNECTION_SAVE_UNKNOWN = "We're not sure the connection was saved. We reloaded your setup to check.";
export const PUBLISH_CHECK_NOT_RUN = "We couldn't run the publishing check, so we don't know yet whether publishing works.";

/** The page uses raw fetch: a lost connection THROWS (status null). Any 5xx is unknown too. A 4xx is a refusal. */
export function isUnknownWriteOutcome(status: number | null): boolean {
  return status === null || status >= 500;
}
