/**
 * Reports hub "Your Reports" list (audit F1/F2, U1, 2026-11-20). Own module so tests that factory-mock page
 * dependencies still see it.
 * - A failed list read is never "no reports": the block used to disappear entirely.
 * - A delete is not "done" until the server says so; apiFetch answers a lost connection with a non-2xx and never
 *   throws, so the old `catch` (and its comment "list is reloaded") never ran.
 */
export const REPORTS_LOAD_FAILED = "We couldn't load your reports, so we can't show what you've already created.";
export const REPORT_DELETE_UNKNOWN = "We're not sure the report was deleted. We reloaded your reports to check.";
export const REPORT_DELETE_REFUSED = "This report wasn't deleted.";
