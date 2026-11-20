/**
 * SALES NAVIGATOR SHARED CONTRACT v2.1 (owner rulings 2026-11-20/21; c6 owns it; a9 r2-r6 + 7c review folded in).
 *
 * v2 (owner, 2026-11-21): each company uses ITS OWN Sales Navigator account (we never supply LinkedIn access);
 * the daily cap is 150 (default) up to a HARD MAX of 200 per LinkedIn member; a run that reaches the cap is PAUSED
 * and RESUMES after the UTC day reset from its saved position until the list is done; duplicates are excluded
 * (in the run, across resumed days, and against leads the company already has) and shown as 'skipped (already
 * have)'. Anything a route READ from LinkedIn counts against the cap (consume-on-reserve) - the cap protects the
 * account, so a skipped duplicate still consumed it.
 *
 * Three routes extract Sales Navigator leads, built in parallel, and they MUST NOT diverge:
 *   'unipile' / 'vayne'  API vendors             - c6
 *   'extension'          our Chrome extension    - a9  (1.5.1)
 *   'rpa'                Playwright on rpaWorker - 89
 * Every route: default OFF per company, the LinkedIn-restriction warning + ack, the SHARED daily cap, enabled only
 * after the owner's legal check. Route owners CALL this contract; they never write its tables directly.
 *
 * Enablement prerequisites, recorded so nobody assumes a route is runnable:
 *   rpa      blocked on main by owner decision #17 (plaintext sessions) until the stranded line lands and #17 is
 *            lifted for linkedin; register O-3 open.
 *   unipile  the canonicalMemberId mapping (connection_params.im.id) is verified against a trial account at U3.
 *   vayne    the cookie-less mode (Vayne's own accounts) stays OFF unless the owner explicitly enables it.
 *   all      URL paging (pageUrlFor) is UNVERIFIED against live LinkedIn - see pageUrlFor.
 */

/** One SOURCE for every route: the same lead seen by two transports is ONE source record (by lead_key). */
export const SALESNAV_SOURCE = 'linkedin_sales_navigator' as const;

export const SALESNAV_TRANSPORTS = ['extension', 'unipile', 'vayne', 'rpa'] as const;
export type SalesNavTransport = (typeof SALESNAV_TRANSPORTS)[number];

/** Leads per submitSalesNavPage call (the extension's batch; API transports split bigger vendor pages). */
export const MAX_SALESNAV_PAGE = 25;
/** Per-LinkedIn-member daily cap, shared by ALL transports (owner 2026-11-21): default 150, HARD MAX 200. */
export const DEFAULT_SALESNAV_DAILY_CAP = 150;
export const MAX_SALESNAV_DAILY_CAP = 200;

/**
 * The company's effective cap. A company setting is honoured only as an integer in 1..200; anything else - absent,
 * malformed, above the hard max - yields the DEFAULT (150), never more. Fails toward LESS reading, never more.
 */
export function resolveDailyCap(companySetting: unknown): number {
  const n = typeof companySetting === 'number' ? companySetting
    : typeof companySetting === 'string' && /^\d{1,4}$/.test(companySetting.trim()) ? Number(companySetting.trim()) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_SALESNAV_DAILY_CAP) return DEFAULT_SALESNAV_DAILY_CAP;
  return n;
}

// -- 1. the lead (wire shape) ------------------------------------------------------------------------------------
// FIELD POLICY (owner via b3, 2026-11-20): a route maps ONLY what the Sales Navigator page actually SHOWS (name,
// title, company, location, ...). INDUSTRY, REVENUE and other firmographics are NOT extracted or inferred here -
// never guessed from a headline. They are filled AFTER ingestion by the customer's own-subscription enrichment
// (Apollo person/company, Lusha, ...), each value marked with its source.
export interface SalesNavLead {
  /** Member-scoped id. Never the full fs_salesProfile tuple. */
  readonly lead_key: string;
  readonly raw_urn?: string | null;
  /** ONLY a displayed /in/ URL - never /sales/. A D7 NON-MERGING locator (Apollo match), never an identity claim. */
  readonly public_profile_url?: string | null;
  readonly full_name: string;
  readonly headline?: string | null;
  readonly title?: string | null;
  readonly company_name?: string | null;
  readonly account_external_id?: string | null;
  readonly company_linkedin_url?: string | null;
  readonly location?: string | null;
  readonly connection_degree?: string | null;
  readonly saved_at?: string | null;
  /** When the route observed the row. */
  readonly captured_at?: string | null;
}

export const SALESNAV_URL_KINDS = ['people_search', 'lead_list', 'saved_search'] as const;
export type SalesNavUrlKind = (typeof SALESNAV_URL_KINDS)[number];

export interface SalesNavPageSource {
  /** From parseSalesNavUrl's `kind` ONLY - never computed by a route. */
  readonly url_kind: SalesNavUrlKind;
  readonly list_name?: string | null;
  /** 0-based; strictly increasing within a run. */
  readonly page_index: number;
}

// -- 3. the URL allowlist ----------------------------------------------------------------------------------------
export const SALESNAV_URL_REFUSALS = ['not_a_url', 'not_https', 'not_linkedin', 'not_sales_navigator', 'unsupported_kind'] as const;
export type SalesNavUrlRefusal = (typeof SALESNAV_URL_REFUSALS)[number];

const LIST_ID = /^\/sales\/lists\/people\/([A-Za-z0-9_-]{1,100})\/?$/;
const SALESNAV_ORIGIN = 'https://www.linkedin.com';

/** The ONE allowlist every route validates through before acting. Pure; never throws. */
export function parseSalesNavUrl(raw: unknown):
  | { ok: true; kind: SalesNavUrlKind; canonicalUrl: string }
  | { ok: false; refused: SalesNavUrlRefusal } {
  if (typeof raw !== 'string' || raw.length > 4000) return { ok: false, refused: 'not_a_url' };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, refused: 'not_a_url' }; }
  if (u.protocol !== 'https:') return { ok: false, refused: 'not_https' };
  const host = u.hostname.toLowerCase();
  if ((host !== 'www.linkedin.com' && host !== 'linkedin.com') || u.port || u.username || u.password) {
    return { ok: false, refused: 'not_linkedin' };
  }
  const path = u.pathname;
  if (!path.startsWith('/sales/')) return { ok: false, refused: 'not_sales_navigator' };
  // The paging parameter is OURS to set (pageUrlFor); a caller-supplied one is dropped from the canonical URL.
  u.searchParams.delete('page');
  const query = u.searchParams.toString();
  const q = query ? `?${query}` : '';
  if (path === '/sales/search/people' || path === '/sales/search/people/') {
    // A saved search is a people search carrying savedSearchId.
    const kind: SalesNavUrlKind = u.searchParams.has('savedSearchId') ? 'saved_search' : 'people_search';
    return { ok: true, kind, canonicalUrl: `${SALESNAV_ORIGIN}/sales/search/people${q}` };
  }
  const list = LIST_ID.exec(path);
  if (list) return { ok: true, kind: 'lead_list', canonicalUrl: `${SALESNAV_ORIGIN}/sales/lists/people/${list[1]}${q}` };
  // Account/company lists and every other Sales Navigator surface are out of v1.
  return { ok: false, refused: 'unsupported_kind' };
}

/** How a loaded page states its position: the `page` query parameter, 1-based; ABSENT means page 1. */
export interface SalesNavPagePosition { readonly param: 'page'; readonly value: string }

/**
 * The URL AND the position rule of page `pageIndex` (0-based) of an allowed Sales Navigator URL - built HERE and
 * nowhere else (a9). Browser routes put `position` in each page command and verify the loaded page with
 * isCommandedPage; they never derive a position themselves (a command without one is refused, POSITION_RULE_MISSING).
 *
 * UNVERIFIED PREMISE (a9, 2026-11-20): that every allowed kind honours `page` in the URL. It is a RUNTIME CHECK, not
 * an assumption: a loaded page that is not the commanded position is 'unknown' (page_position_mismatch) and the run
 * cannot close 'completed'. A kind shown NOT to page by URL is moved to 'unsupported_kind' by contract change - never
 * paged by clicking LinkedIn's 'next' control.
 * Returns null when `canonicalUrl` is not an allowed Sales Navigator URL or the index is not a safe integer 0..999.
 */
export function pageUrlFor(canonicalUrl: string, pageIndex: number):
  { pageUrl: string; position: SalesNavPagePosition } | null {
  const parsed = parseSalesNavUrl(canonicalUrl);
  if (!parsed.ok || !Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex > 999) return null;
  const u = new URL(parsed.canonicalUrl);
  if (pageIndex > 0) u.searchParams.set('page', String(pageIndex + 1));
  return { pageUrl: u.toString(), position: { param: 'page', value: String(pageIndex + 1) } };
}

/**
 * THE one answer to "is this the page we asked for" (extension + RPA): the loaded page's FINAL URL must be the SAME
 * allowed list/search (equal canonical URL, page parameter excluded) AND state the commanded position (`page` equal to
 * position.value; an absent `page` counts as '1'). Pure; anything unparseable is false.
 */
export function isCommandedPage(finalUrl: unknown, commandedPageUrl: string, position: SalesNavPagePosition): boolean {
  if (!position || position.param !== 'page' || !/^\d{1,4}$/.test(String(position.value))) return false;
  const loaded = parseSalesNavUrl(finalUrl);
  const asked = parseSalesNavUrl(commandedPageUrl);
  if (!loaded.ok || !asked.ok || loaded.canonicalUrl !== asked.canonicalUrl) return false;
  let shown: string;
  try { shown = new URL(String(finalUrl)).searchParams.get('page') ?? '1'; } catch { return false; }
  return shown === String(position.value);
}

// -- 4. the canonical member id (the shared cap's key) ---------------------------------------------------------
const PROFILE_ID = /^ACoAA[A-Za-z0-9_-]{10,80}$/;

/**
 * The LinkedIn profile id (the <id> in urn:li:fsd_profile:<id>). Accepts that urn, the fs_miniProfile urn, or the
 * bare id; anything else is null - and a null member can never reserve quota (granted = 0, fail closed).
 */
export function canonicalMemberId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  const m = /^urn:li:(?:fsd_profile|fs_miniProfile):(.+)$/.exec(v);
  const id = m ? m[1] : v;
  return PROFILE_ID.test(id) ? id : null;
}

// -- 5. the job model --------------------------------------------------------------------------------------------
export const SALESNAV_RUN_STATUSES = [
  'queued', 'running', 'paused_daily_cap', 'auth_expired',
  'completed', 'rate_limited', 'refused', 'failed', 'cancelled', 'unknown',
] as const;

/**
 * v2 RESUMABLE (non-terminal) states. The run keeps its list URL, next page index and counts.
 *   paused_daily_cap  the member's cap was reached: resumes AUTOMATICALLY after the UTC day reset (shown honestly as
 *                     "paused for today's limit - resumes tomorrow", with Cancel).
 *   auth_expired      LinkedIn logged out / checkpoint: WAITS for the user to reconnect and resume (or Cancel).
 * A resumed run first RE-VERIFIES its position (else unknown / page_position_mismatch) and the login (else
 * auth_expired). Replaces v1's terminal 'partial_capped'.
 */
export const SALESNAV_RESUMABLE_STATUSES = ['paused_daily_cap', 'auth_expired'] as const;

/**
 * v1.2 (a9 / 7c, 2026-11-20). A run with no page result within this window is STALE: it is closed 'unknown'
 * (run_stale) the next time anyone starts a run for the same member (lazy, no cron), which also frees the member's
 * one-run lock. Default pending b3's ruling.
 */
export const SALESNAV_RUN_STALE_SECONDS = 120;
export type SalesNavRunStatus = (typeof SALESNAV_RUN_STATUSES)[number];

/** Codes allowed per terminal status (closed sets: a route cannot invent one). */
export const SALESNAV_STATUS_CODES = {
  completed: ['no_next_page', 'empty_first_page'],
  rate_limited: ['site_rate_limit', 'vendor_rate_limit'],
  refused: ['gate_closed', 'url_not_allowed', 'member_unresolved', 'member_mismatch', 'quota_unreadable'],
  failed: ['dom_changed', 'vendor_error', 'transport_error', 'internal_error'],
  /** The user's Cancel (v1.2): the server stops issuing pages. */
  cancelled: ['user_cancelled'],
  /**
   * v1.2: a LOST RESPONSE ENDS THE RUN 'unknown' (supersedes v1.1's "continue at a greater page_index" - no guessing
   * forward, for every transport). page_position_mismatch: the loaded page was not the commanded position;
   * page_repeated: the server backstop - see isRepeatedPage (a lead_key SET comparison); run_stale: no page
   * result within SALESNAV_RUN_STALE_SECONDS.
   */
  unknown: ['page_unconfirmed', 'structure_unrecognised', 'next_page_unreadable', 'page_position_mismatch',
    'page_repeated', 'run_stale', 'response_lost'],
} as const;
export type SalesNavTerminalStatus = keyof typeof SALESNAV_STATUS_CODES;

/** Statuses that END a run. 'completed' only when the source has no further page; ANY unknown page -> 'unknown'. */
export const SALESNAV_TERMINAL_STATUSES = Object.keys(SALESNAV_STATUS_CODES) as readonly SalesNavTerminalStatus[];

/** Codes for the resumable states (closed sets, like the terminal ones). */
export const SALESNAV_PAUSE_CODES = {
  paused_daily_cap: ['daily_cap'],
  auth_expired: ['logged_out', 'checkpoint'],
} as const;
export type SalesNavResumableStatus = keyof typeof SALESNAV_PAUSE_CODES;

/** True only for a (resumable status, code) pair the contract allows. */
export function isAllowedPause(status: unknown, code: unknown): boolean {
  if (typeof status !== 'string' || !(status in SALESNAV_PAUSE_CODES)) return false;
  return (SALESNAV_PAUSE_CODES as Record<string, readonly string[]>)[status].includes(String(code));
}

/**
 * The list total a page states - an EXACT non-negative integer only (a9 r6). '1,000+', '1K', '2.5K', 'about 300',
 * separators, decimals, negatives and anything unparseable are NULL (then the reservation falls back to rule A).
 * Enforced here for every transport, whatever the route sent.
 */
export function parseListTotal(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw === 'string' && /^\d{1,9}$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

/**
 * The page RESERVATION RULE, every transport (owner via b3 2026-11-20; a9 r5/r6):
 *   A  page 0, an unknown total, or a total already found unreliable: request MAX_SALESNAV_PAGE (25), DISCLOSED.
 *   B  otherwise: min(25, listTotal - readSoFar).
 *   THE PAGE BEATS THE TOTAL: if B computes 0 while the last page said hasNextPage === true, use A for the rest of
 *   the run and mark it totalUnreliable. A computed 0 is never a cap: paused_daily_cap is ONLY the QUOTA granting 0.
 * Pure. The cap is consumed on reserve and never refunded.
 */
export function pageReservationRequest(input: {
  pageIndex: number;
  listTotal: unknown;
  readSoFar: number;
  lastHasNextPage: boolean | null;
  totalUnreliable: boolean;
}): { requested: number; disclosed: boolean; totalUnreliable: boolean } {
  const A = { requested: MAX_SALESNAV_PAGE, disclosed: true };
  const total = parseListTotal(input.listTotal);
  if (input.pageIndex <= 0 || total === null || input.totalUnreliable) return { ...A, totalUnreliable: input.totalUnreliable };
  const read = Number.isFinite(input.readSoFar) && input.readSoFar > 0 ? Math.floor(input.readSoFar) : 0;
  const computed = Math.max(0, total - read);
  if (computed === 0 && input.lastHasNextPage === true) return { ...A, totalUnreliable: true };
  return { requested: Math.min(MAX_SALESNAV_PAGE, computed), disclosed: false, totalUnreliable: false };
}

/** v1.3 (a9 r3 / 7c): Sales Navigator lists REORDER between fetches, so a repeat is a SET overlap, not row 1. */
export const PAGE_REPEAT_MIN_OVERLAP = 3;
export const PAGE_REPEAT_MIN_RATIO = 0.8;

/**
 * True when THIS page is (mostly) already seen: at least PAGE_REPEAT_MIN_OVERLAP of this page's distinct lead_keys
 * were seen ANYWHERE earlier in the run (a9 r4: union basis, across resumed days too) AND they are at least
 * PAGE_REPEAT_MIN_RATIO of this page's distinct keys. Pure; keys only. An empty page is never a repeat.
 */
export function isRepeatedPage(seenInRunKeys: readonly string[], thisKeys: readonly string[]): boolean {
  const prev = new Set(seenInRunKeys);
  const cur = new Set(thisKeys);
  if (cur.size === 0) return false;
  let overlap = 0;
  for (const k of cur) if (prev.has(k)) overlap += 1;
  return overlap >= PAGE_REPEAT_MIN_OVERLAP && overlap / cur.size >= PAGE_REPEAT_MIN_RATIO;
}

/** True only for a (status, code) pair the contract allows. */
export function isAllowedClose(status: unknown, code: unknown): boolean {
  if (typeof status !== 'string' || !(status in SALESNAV_STATUS_CODES)) return false;
  return (SALESNAV_STATUS_CODES as Record<string, readonly string[]>)[status].includes(String(code));
}

// -- 2 / 4 / 5 / 6 signatures (implementations land with the first caller, U3) ---------------------------------
export interface SalesNavCallerContext {
  /** The VERIFIED tenant (never from a body). */
  readonly organizationId: string;
  /** The user who started the run, or null for a system continuation. */
  readonly initiatedBy: string | null;
}

export interface SubmitSalesNavPageInput {
  readonly transport: SalesNavTransport;
  readonly runId: string;
  readonly attestedMemberId: string;
  readonly page: { readonly leads: readonly SalesNavLead[]; readonly source: SalesNavPageSource };
}

export interface SubmitSalesNavPageResult {
  readonly accepted: number;
  readonly rejected: number;
  readonly created: number;
  readonly updated: number;
  readonly heldForReview: number;
  /** 'skipped (already have)': in this run, a resumed day, or already in the company's leads. Not 'added'. */
  readonly skippedDuplicates: number;
  readonly dropped: number;
  /** Leads beyond the quota granted for this page: NOT ingested. */
  readonly quotaRefused: number;
}

export interface ReserveSalesNavQuotaInput {
  readonly linkedinMemberId: string;
  readonly transport: SalesNavTransport;
  readonly requested: number;
}
/** Consume-on-reserve; no refund for short pages; any error grants 0 (never "unknown means allow"). */
export interface ReserveSalesNavQuotaResult { readonly granted: number; readonly remaining: number }

export interface SalesNavGateDecision { readonly allowed: boolean; readonly reason: string }

export interface SalesNavContract {
  salesNavRouteGate(ctx: SalesNavCallerContext, transport: SalesNavTransport): Promise<SalesNavGateDecision>;
  /** Records ONLY the opaque canonical member id for this company + transport (no name). */
  bindSalesNavMember(ctx: SalesNavCallerContext, transport: SalesNavTransport, memberId: string): Promise<void>;
  startSalesNavRun(ctx: SalesNavCallerContext, input: { transport: SalesNavTransport; url: string }):
    Promise<{ runId: string; kind: SalesNavUrlKind; canonicalUrl: string } | { refused: SalesNavUrlRefusal | 'gate_closed' }>;
  reserveSalesNavQuota(ctx: SalesNavCallerContext, input: ReserveSalesNavQuotaInput): Promise<ReserveSalesNavQuotaResult>;
  submitSalesNavPage(ctx: SalesNavCallerContext, input: SubmitSalesNavPageInput): Promise<SubmitSalesNavPageResult>;
  /**
   * Per page. leadKeys (KEYS ONLY, no person fields) are kept for the previous page of the run so the server can end
   * it 'unknown' (page_repeated, isRepeatedPage); a page with outcome 'unknown' ingests nothing and ENDS the run.
   */
  recordSalesNavPage(ctx: SalesNavCallerContext, input: {
    runId: string; pageIndex: number; outcome: 'ok' | 'unknown'; hasNextPage: boolean | null;
    /** As stated on the page (parsed with parseListTotal server-side). */
    listTotal: unknown;
    leadKeys: readonly string[]; unknownCode?: (typeof SALESNAV_STATUS_CODES)['unknown'][number];
  }): Promise<void>;
  /** v2: park a run in a resumable state, keeping its list URL, next page index and counts. */
  pauseSalesNavRun(ctx: SalesNavCallerContext, input: { runId: string; status: SalesNavResumableStatus; code: string; nextPageIndex: number }): Promise<void>;
  /** v2: continue a paused run (cap reset, or the user reconnected). Re-verify position + login before ingesting. */
  resumeSalesNavRun(ctx: SalesNavCallerContext, input: { runId: string }): Promise<{ resumed: true; nextPageIndex: number } | { resumed: false; reason: string }>;
  closeSalesNavRun(ctx: SalesNavCallerContext, input: { runId: string; status: SalesNavTerminalStatus; code: string; retryAfterAt?: string | null }): Promise<void>;
}
