/**
 * One Idempotency-Key per blog request (c6's blog billing, feat/blog-fixed-40-20261118: the key is
 * REQUIRED on billed blog requests, 400 IDEMPOTENCY_KEY_REQUIRED without one, and the server's
 * credit hold is keyed on it). Shared by the three blog callers:
 *   - components/blog/BlogGenerateModalMain.tsx  (POST /api/blogs/generate, mode 'full')
 *   - pages/blogs/suggestions.tsx                 (POST /api/blogs/generate, mode 'full')
 *   - pages/admin/blog/content-refine.tsx         (POST /api/admin/blog/generate, mode 'full')
 *
 * Key lifetime (the money rule): a key is the server's hold reference, so
 *   - a click mints a key; a second click while the first is in flight reuses it (no double hold);
 *   - when the outcome is KNOWN (success, a refusal, a failure with billing facts) the key ends and
 *     the next click is a new request;
 *   - when the outcome is UNKNOWN (connection lost, a server error with no billing facts, or the
 *     server says the same key is still running) the key is KEPT, so trying again reuses it and the
 *     server answers "already being written" / "already finished" instead of holding a second 40.
 * Today's main routes ignore the header, so sending it is harmless before c6's branch lands.
 *
 * DO NOT "FIX" THE KEPT KEY (7c, 2026-11-18). If a finished, charged blog's response is lost, the
 * retry with the kept key can only be answered from the SERVER (owner ruling via b3: replay the
 * same result, one charge; c6 builds it, BLOCKING for c6's feat/blog-fixed-40-20261118).
 * CURRENT STATE (2026-11-18, until that replay ships): the generate routes do not store the draft,
 * so a lost response after the charge is settled means a charged blog the user CANNOT recover.
 * The replay closes this only if the stored copy is written BEFORE the charge is confirmed (7c).
 * Ending the key on a lost connection so the retry
 * regenerates would turn lost data into a SECOND charge. The UI line "Trying again won't charge you
 * twice" (BlogGenerateModalMain BILLED_NETWORK_UNCERTAIN) is true only because of this rule;
 * blogCostUi.test.tsx pins the two together.
 */
import { createBilledActionKeyGate } from '../idempotency';

export const blogGenerateKeys = createBilledActionKeyGate('blog-generate');

/** b3, 2026-11-18: the plain text for 409 BLOG_ALREADY_IN_PROGRESS. */
export const BLOG_IN_PROGRESS_TEXT = 'This blog is already being written.';

const KEY_MISSING_TEXT = 'Something went wrong on our side, so nothing was started. Please try again.';

/** Refusals where nothing was held or run, so the request is definitively over. */
const NOTHING_STARTED = new Set(['BLOG_SWITCH_UNAVAILABLE', 'BILLING_UNAVAILABLE', 'IDEMPOTENCY_KEY_REQUIRED']);

/** One scope per distinct request (company + what is being written), so an unrelated blog never reuses a kept key. */
export function blogKeyScope(...parts: Array<string | null | undefined>): string {
  const s = parts.map((p) => String(p ?? '').trim()).join('|');
  return s.replace(/\|/g, '') ? s : 'default';
}

const codeOf = (body: unknown): string =>
  body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : '';

/**
 * Plain text for c6's blog-specific refusals, or null when the response isn't one of them (the
 * caller keeps its existing text). The server's own `error` sentences are already plain; only the
 * in-progress line (b3's wording) and the missing-key line (a bug on our side, not the user's) are
 * replaced.
 */
export function blogRefusalText(body: unknown): string | null {
  const code = codeOf(body);
  const serverText = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
    ? ((body as { error: string }).error.trim())
    : '';
  switch (code) {
    case 'BLOG_ALREADY_IN_PROGRESS':
      return BLOG_IN_PROGRESS_TEXT;
    case 'IDEMPOTENCY_KEY_REQUIRED':
      return KEY_MISSING_TEXT;
    case 'RESERVATION_ALREADY_SETTLED':
      return serverText || 'This blog request has already finished. Start a new request to generate again.';
    case 'BLOG_GENERATION_DISABLED':
      return serverText || 'Blog generation is turned off for this account.';
    case 'BLOG_SWITCH_UNAVAILABLE':
      return serverText || 'Blog generation is temporarily unavailable. Please try again.';
    default:
      return null;
  }
}

/** After a response: true = the outcome is unknown, keep the key so a retry reuses it. */
export function keepBlogKey(status: number, body: unknown): boolean {
  const code = codeOf(body);
  if (code === 'BLOG_ALREADY_IN_PROGRESS') return true;
  if (status >= 500) {
    if (NOTHING_STARTED.has(code)) return false;
    const billing = body && typeof body === 'object' ? (body as { billing?: unknown }).billing : undefined;
    // c6: a failed blog states its billing (charged 0, released 40): known, so the request is over.
    return !(billing && typeof billing === 'object');
  }
  return false;
}
