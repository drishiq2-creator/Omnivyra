/**
 * Sales Navigator SHARED CONTRACT - the server-side store (c6). Implements the contract's member binding, run
 * lifecycle and quota reservation against migrations 073 (salesnav_member_owner / salesnav_member_bindings /
 * salesnav_extraction_runs) and 074 (salesnav_consume_daily_quota). Route owners (a9 extension, 89 RPA, c6 API
 * vendors) CALL these; they never write the tables.
 *
 * Rules held here, for every transport:
 *  - ONE company per LinkedIn member (b3 ruling A): a member another company owns is refused, never shared.
 *  - Every read of a table is checked as an ANSWER: an error, a non-2xx status or a non-array is a failure, never
 *    "no row" (a null error is not an answer).
 *  - Quota fails CLOSED: any error grants 0. The cap is consumed on reserve and never refunded.
 *  - A run moves only along the contract's closed (status, code) sets; every update is guarded on the state it
 *    expects (status + next_page_index), and a guard that matches no row is reported, never assumed.
 *  - vendor_cursor (an opaque vendor paging token that may encode the search) is never logged and never returned in
 *    a status payload (toRunStatusView omits it).
 */
import { ownedDbRpc, ownedDbTable } from '../../db/writeOwner';
import {
  canonicalMemberId, effectiveRunStatus, isAllowedClose, isAllowedPause, isRepeatedPage, parseListTotal,
  parseSalesNavUrl, resolveDailyCap, SALESNAV_RUN_STALE_SECONDS,
  type SalesNavCallerContext, type SalesNavResumableStatus, type SalesNavRunStatus, type SalesNavTerminalStatus,
  type SalesNavTransport, type SalesNavUrlKind, type SalesNavUrlRefusal,
} from './contract';

const OWNER = 'salesnav_member_owner';
const BINDINGS = 'salesnav_member_bindings';
const RUNS = 'salesnav_extraction_runs';
const CONSUME = 'salesnav_consume_daily_quota';
/** 073's bound on seen_lead_keys. */
export const MAX_SEEN_LEAD_KEYS = 10_000;

type DbResult = { data?: unknown; error?: unknown; status?: number; count?: number | null };

export interface SalesNavStoreDeps {
  readonly table?: (name: string) => any;
  readonly rpc?: (fn: string, args: Record<string, unknown>) => PromiseLike<DbResult>;
  readonly now?: () => Date;
}

const errCode = (r: DbResult): string | null =>
  (r.error && typeof r.error === 'object' ? String((r.error as { code?: unknown }).code ?? '') : '') || null;

/** Rows, or null when the result is not an answer. */
function rowsOf(r: DbResult): Array<Record<string, unknown>> | null {
  if (r.error || (r.status !== 200 && r.status !== 201 && r.status !== 206) || !Array.isArray(r.data)) return null;
  return r.data as Array<Record<string, unknown>>;
}

export class SalesNavStoreError extends Error {
  constructor(readonly code: string) { super(`salesnav_store:${code}`); }
}

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

// -- member binding ---------------------------------------------------------------------------------------------

export type BindOutcome =
  | { readonly bound: true }
  | { readonly bound: false; readonly reason: 'no_user' | 'member_unresolved' | 'member_owned_by_another_company'
      | 'account_binding_conflict' | 'store_unreadable' };

/**
 * Bind the CALLING USER's LinkedIn member for a transport (a9's model: one active member per (company, user,
 * transport)). Claims company ownership of the member first (refused when another company owns it - b3 ruling A),
 * then records the binding. A DIFFERENT member for an existing (company, user, transport) binding is refused
 * (account_binding_conflict, 409) - never silently replaced; an admin revokes first. Re-binding the same member is a
 * no-op success. An ownership claimed by THIS call for a conflicting member is released again.
 */
export async function bindSalesNavMember(
  ctx: SalesNavCallerContext, transport: SalesNavTransport, rawMemberId: unknown, deps: SalesNavStoreDeps = {},
): Promise<BindOutcome> {
  const table = deps.table ?? ownedDbTable;
  if (!ctx.initiatedBy) return { bound: false, reason: 'no_user' };
  const member = canonicalMemberId(rawMemberId);
  if (!member) return { bound: false, reason: 'member_unresolved' };

  const existing = rowsOf(await table(BINDINGS).select('member_id')
    .eq('organization_id', ctx.organizationId).eq('user_id', ctx.initiatedBy).eq('transport', transport).limit(1));
  if (!existing) return { bound: false, reason: 'store_unreadable' };
  const current = existing[0]?.member_id;
  if (typeof current === 'string') {
    return current === member ? { bound: true } : { bound: false, reason: 'account_binding_conflict' };
  }

  let claimedNow = false;
  const claim = await table(OWNER).insert({ member_id: member, organization_id: ctx.organizationId });
  if (claim.error) {
    if (errCode(claim) !== '23505') return { bound: false, reason: 'store_unreadable' };
    const owner = rowsOf(await table(OWNER).select('organization_id').eq('member_id', member).limit(1));
    if (!owner || owner.length !== 1) return { bound: false, reason: 'store_unreadable' };
    if (owner[0].organization_id !== ctx.organizationId) return { bound: false, reason: 'member_owned_by_another_company' };
  } else {
    claimedNow = true;
  }

  const ins = await table(BINDINGS).insert({
    organization_id: ctx.organizationId, user_id: ctx.initiatedBy, transport, member_id: member,
    bound_at: new Date().toISOString(),
  });
  if (ins.error) {
    // a concurrent bind for the same (company, user, transport) won: report it as the conflict it is, and give back
    // an ownership this call created (the member is then bound nowhere by it)
    if (claimedNow) await table(OWNER).delete().eq('member_id', member).eq('organization_id', ctx.organizationId);
    return { bound: false, reason: errCode(ins) === '23505' ? 'account_binding_conflict' : 'store_unreadable' };
  }
  return { bound: true };
}

/** The member a USER of the company has bound for a transport: the id, null when none, or 'unreadable'. */
export async function boundMember(
  org: string, userId: string, transport: SalesNavTransport, deps: SalesNavStoreDeps = {},
): Promise<string | null | 'unreadable'> {
  const table = deps.table ?? ownedDbTable;
  const rows = rowsOf(await table(BINDINGS).select('member_id')
    .eq('organization_id', org).eq('user_id', userId).eq('transport', transport).limit(1));
  if (!rows) return 'unreadable';
  const id = rows[0]?.member_id;
  return typeof id === 'string' ? id : null;
}

/** Is the member bound for the transport by ANY user of the company? (resume, quota, the handoff continuation) */
export async function memberBoundInCompany(
  org: string, transport: SalesNavTransport, member: string, deps: SalesNavStoreDeps = {},
): Promise<boolean | 'unreadable'> {
  const table = deps.table ?? ownedDbTable;
  const rows = rowsOf(await table(BINDINGS).select('user_id')
    .eq('organization_id', org).eq('transport', transport).eq('member_id', member).limit(1));
  if (!rows) return 'unreadable';
  return rows.length === 1;
}

// -- runs -------------------------------------------------------------------------------------------------------

export type StartRunOutcome =
  | { readonly runId: string; readonly kind: SalesNavUrlKind; readonly canonicalUrl: string; readonly memberId: string }
  | { readonly refused: SalesNavUrlRefusal | 'gate_closed' | 'member_unresolved' | 'run_already_open' | 'store_unreadable' };

/**
 * Start a run for the STARTING USER's bound member. The caller has ALREADY passed the route gate (salesNavRouteGate).
 * A stale 'running' run for the member is closed unknown/run_stale first (lazy, no cron), which frees the member's
 * one-open-run slot; any other open run (queued, running and fresh, or paused) refuses with run_already_open.
 */
export async function startSalesNavRun(
  ctx: SalesNavCallerContext, input: { transport: SalesNavTransport; url: unknown }, deps: SalesNavStoreDeps = {},
): Promise<StartRunOutcome> {
  const table = deps.table ?? ownedDbTable;
  const now = (deps.now ?? (() => new Date()))();
  const parsed = parseSalesNavUrl(input.url);
  if (!parsed.ok) return { refused: parsed.refused };
  if (!ctx.initiatedBy) return { refused: 'member_unresolved' };
  const member = await boundMember(ctx.organizationId, ctx.initiatedBy, input.transport, deps);
  if (member === 'unreadable') return { refused: 'store_unreadable' };
  if (!member) return { refused: 'member_unresolved' };

  // lazy stale close (contract v1.2): only a 'running' row idle for SALESNAV_RUN_STALE_SECONDS
  const staleBefore = new Date(now.getTime() - SALESNAV_RUN_STALE_SECONDS * 1000).toISOString();
  const stale = await table(RUNS).update({
    status: 'unknown', status_code: 'run_stale', closed_at: now.toISOString(), updated_at: now.toISOString(),
  }).eq('member_id', member).eq('status', 'running').lt('last_activity_at', staleBefore);
  if (stale.error) return { refused: 'store_unreadable' };

  const ins = await table(RUNS).insert({
    organization_id: ctx.organizationId, transport: input.transport, member_id: member,
    url_kind: parsed.kind, canonical_url: parsed.canonicalUrl, status: 'running', initiated_by: ctx.initiatedBy,
    last_activity_at: now.toISOString(),
    // the handoff holder: a browser-route run starts held by its own route; API routes have none (073 CHECK)
    active_route: input.transport === 'extension' || input.transport === 'rpa' ? input.transport : null,
  }).select('id');
  if (ins.error) return { refused: errCode(ins) === '23505' ? 'run_already_open' : 'store_unreadable' };
  const rows = rowsOf(ins);
  const id = rows?.[0]?.id;
  if (typeof id !== 'string') return { refused: 'store_unreadable' };
  return { runId: id, kind: parsed.kind, canonicalUrl: parsed.canonicalUrl, memberId: member };
}

/** The columns a run READ uses. vendor_cursor is read only by the transport that pages with it (runCursor). */
const RUN_COLUMNS = 'id, organization_id, transport, member_id, url_kind, canonical_url, status, status_code, '
  + 'next_page_index, list_total, total_unreliable, last_has_next_page, pages_read, leads_read, accepted, rejected, '
  + 'created_count, updated_count, held_for_review, skipped_duplicates, dropped, quota_refused, seen_lead_keys, '
  + 'retry_after_at, created_at, last_activity_at, closed_at';

export interface SalesNavRunRow {
  readonly id: string;
  readonly organization_id: string;
  readonly transport: SalesNavTransport;
  readonly member_id: string;
  readonly url_kind: SalesNavUrlKind;
  readonly canonical_url: string;
  readonly status: SalesNavRunStatus;
  readonly status_code: string | null;
  readonly next_page_index: number;
  readonly list_total: number | null;
  readonly total_unreliable: boolean;
  readonly last_has_next_page: boolean | null;
  readonly pages_read: number;
  readonly leads_read: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly created_count: number;
  readonly updated_count: number;
  readonly held_for_review: number;
  readonly skipped_duplicates: number;
  readonly dropped: number;
  readonly quota_refused: number;
  readonly seen_lead_keys: readonly string[];
  readonly retry_after_at: string | null;
  readonly created_at: string;
  readonly last_activity_at: string;
  readonly closed_at: string | null;
}

/** One run of THIS company: the row, null when there is none (for this company), or 'unreadable'. */
export async function loadRun(
  org: string, runId: string, deps: SalesNavStoreDeps = {},
): Promise<SalesNavRunRow | null | 'unreadable'> {
  const table = deps.table ?? ownedDbTable;
  const rows = rowsOf(await table(RUNS).select(RUN_COLUMNS).eq('id', runId).eq('organization_id', org).limit(1));
  if (!rows) return 'unreadable';
  return (rows[0] as unknown as SalesNavRunRow | undefined) ?? null;
}

/** The vendor cursor of a run (API transports). Never logged, never part of a status payload. */
export async function runCursor(org: string, runId: string, deps: SalesNavStoreDeps = {}): Promise<string | null | 'unreadable'> {
  const table = deps.table ?? ownedDbTable;
  const rows = rowsOf(await table(RUNS).select('vendor_cursor').eq('id', runId).eq('organization_id', org).limit(1));
  if (!rows) return 'unreadable';
  const c = rows[0]?.vendor_cursor;
  return typeof c === 'string' ? c : null;
}

/** What a progress view may show. Never the member id, the seen keys or the vendor cursor. */
export function toRunStatusView(run: SalesNavRunRow, now: Date) {
  const shown = effectiveRunStatus({ status: run.status, code: run.status_code, lastActivityAt: run.last_activity_at }, now);
  return {
    runId: run.id,
    transport: run.transport,
    urlKind: run.url_kind,
    status: shown.status,
    code: shown.code,
    pagesRead: run.pages_read,
    leadsRead: run.leads_read,
    listTotal: run.list_total,
    added: run.created_count,
    updated: run.updated_count,
    heldForReview: run.held_for_review,
    skippedAlreadyHave: run.skipped_duplicates,
    dropped: run.dropped,
    notReadOverCap: run.quota_refused,
    retryAfterAt: run.retry_after_at,
    startedAt: run.created_at,
    closedAt: run.closed_at,
  };
}

/** A guarded update: applies only when the run is still in `expect`; reports whether exactly one row changed. */
async function guardedUpdate(
  org: string, runId: string, expect: { status: SalesNavRunStatus | readonly SalesNavRunStatus[]; nextPageIndex?: number },
  patch: Record<string, unknown>, table: (n: string) => any,
): Promise<'ok' | 'not_in_expected_state' | 'unreadable'> {
  let q = table(RUNS).update(patch, { count: 'exact' }).eq('id', runId).eq('organization_id', org);
  q = Array.isArray(expect.status) ? q.in('status', expect.status as string[]) : q.eq('status', expect.status);
  if (typeof expect.nextPageIndex === 'number') q = q.eq('next_page_index', expect.nextPageIndex);
  const r: DbResult = await q;
  if (r.error || typeof r.count !== 'number') return 'unreadable';
  return r.count === 1 ? 'ok' : 'not_in_expected_state';
}

export type RecordPageOutcome =
  | { readonly recorded: true; readonly closed: null | { status: SalesNavTerminalStatus; code: string } }
  | { readonly recorded: false; readonly reason: 'run_not_found' | 'run_not_running' | 'store_unreadable' | 'not_in_expected_state' };

/**
 * Record one page result. An 'unknown' page, a page at the wrong position, or a page that is (mostly) already seen
 * ENDS the run 'unknown'. Otherwise the keys join the run's seen set, the position advances, and a page that states
 * no next page closes the run 'completed'. Keys only, never person data.
 */
export async function recordSalesNavPage(
  ctx: SalesNavCallerContext,
  input: {
    runId: string; pageIndex: number; outcome: 'ok' | 'unknown'; hasNextPage: boolean | null; listTotal: unknown;
    leadKeys: readonly string[]; unknownCode?: string; vendorCursor?: string | null;
  },
  deps: SalesNavStoreDeps = {},
): Promise<RecordPageOutcome> {
  const table = deps.table ?? ownedDbTable;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const run = await loadRun(ctx.organizationId, input.runId, deps);
  if (run === 'unreadable') return { recorded: false, reason: 'store_unreadable' };
  if (!run) return { recorded: false, reason: 'run_not_found' };
  if (run.status !== 'running') return { recorded: false, reason: 'run_not_running' };

  const close = async (status: SalesNavTerminalStatus, code: string): Promise<RecordPageOutcome> => {
    const r = await guardedUpdate(ctx.organizationId, run.id, { status: 'running', nextPageIndex: run.next_page_index }, {
      status, status_code: code, closed_at: now, updated_at: now, last_activity_at: now,
    }, table);
    return r === 'ok' ? { recorded: true, closed: { status, code } } : { recorded: false, reason: r === 'unreadable' ? 'store_unreadable' : r };
  };

  if (input.outcome === 'unknown') {
    const code = isAllowedClose('unknown', input.unknownCode) ? String(input.unknownCode) : 'page_unconfirmed';
    return close('unknown', code);
  }
  if (input.pageIndex !== run.next_page_index) return close('unknown', 'page_position_mismatch');
  const keys = [...new Set(input.leadKeys.filter((k) => typeof k === 'string' && k.length > 0))];
  if (isRepeatedPage(run.seen_lead_keys, keys)) return close('unknown', 'page_repeated');

  const seen = [...new Set([...run.seen_lead_keys, ...keys])];
  if (seen.length > MAX_SEEN_LEAD_KEYS) return close('failed', 'internal_error');
  const total = parseListTotal(input.listTotal);
  const patch: Record<string, unknown> = {
    seen_lead_keys: seen,
    next_page_index: run.next_page_index + 1,
    pages_read: run.pages_read + 1,
    last_has_next_page: input.hasNextPage,
    list_total: total ?? run.list_total,
    updated_at: now,
    last_activity_at: now,
  };
  if (run.transport === 'unipile' || run.transport === 'vayne') patch.vendor_cursor = input.vendorCursor ?? null;
  if (input.hasNextPage === false) {
    patch.status = 'completed';
    patch.status_code = run.pages_read === 0 && keys.length === 0 ? 'empty_first_page' : 'no_next_page';
    patch.closed_at = now;
  }
  const r = await guardedUpdate(ctx.organizationId, run.id, { status: 'running', nextPageIndex: run.next_page_index }, patch, table);
  if (r !== 'ok') return { recorded: false, reason: r === 'unreadable' ? 'store_unreadable' : r };
  return {
    recorded: true,
    closed: input.hasNextPage === false ? { status: 'completed', code: String(patch.status_code) } : null,
  };
}

/** Park a running run in a resumable state. */
export async function pauseSalesNavRun(
  ctx: SalesNavCallerContext, input: { runId: string; status: SalesNavResumableStatus; code: string; retryAfterAt?: string | null },
  deps: SalesNavStoreDeps = {},
): Promise<'ok' | 'not_in_expected_state' | 'unreadable' | 'code_not_allowed'> {
  if (!isAllowedPause(input.status, input.code)) return 'code_not_allowed';
  const now = (deps.now ?? (() => new Date()))().toISOString();
  return guardedUpdate(ctx.organizationId, input.runId, { status: 'running' }, {
    status: input.status, status_code: input.code, retry_after_at: input.retryAfterAt ?? null,
    updated_at: now, last_activity_at: now,
  }, deps.table ?? ownedDbTable);
}

/**
 * Continue a paused run. auth_expired needs the member to still be bound for the run's transport (else it stays
 * paused - the user reconnects first). paused_daily_cap may be resumed any time: the quota decides, and a capped
 * member pauses again at its first reservation.
 */
export async function resumeSalesNavRun(
  ctx: SalesNavCallerContext, input: { runId: string }, deps: SalesNavStoreDeps = {},
): Promise<{ resumed: true; nextPageIndex: number } | { resumed: false; reason: string }> {
  const run = await loadRun(ctx.organizationId, input.runId, deps);
  if (run === 'unreadable') return { resumed: false, reason: 'store_unreadable' };
  if (!run) return { resumed: false, reason: 'run_not_found' };
  if (run.status !== 'paused_daily_cap' && run.status !== 'auth_expired') return { resumed: false, reason: 'run_not_paused' };
  const bound = await memberBoundInCompany(ctx.organizationId, run.transport, run.member_id, deps);
  if (bound === 'unreadable') return { resumed: false, reason: 'store_unreadable' };
  if (!bound) return { resumed: false, reason: 'member_not_bound' };
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const r = await guardedUpdate(ctx.organizationId, run.id, { status: run.status, nextPageIndex: run.next_page_index }, {
    status: 'running', status_code: null, retry_after_at: null, updated_at: now, last_activity_at: now,
  }, deps.table ?? ownedDbTable);
  return r === 'ok' ? { resumed: true, nextPageIndex: run.next_page_index } : { resumed: false, reason: r };
}

/** End a run (running or paused) with a contract-allowed (status, code). */
export async function closeSalesNavRun(
  ctx: SalesNavCallerContext,
  input: { runId: string; status: SalesNavTerminalStatus; code: string; retryAfterAt?: string | null },
  deps: SalesNavStoreDeps = {},
): Promise<'ok' | 'not_in_expected_state' | 'unreadable' | 'code_not_allowed'> {
  if (!isAllowedClose(input.status, input.code)) return 'code_not_allowed';
  const now = (deps.now ?? (() => new Date()))().toISOString();
  return guardedUpdate(ctx.organizationId, input.runId, { status: ['running', 'queued', 'paused_daily_cap', 'auth_expired'] }, {
    status: input.status, status_code: input.code, retry_after_at: input.retryAfterAt ?? null,
    closed_at: now, updated_at: now, last_activity_at: now,
  }, deps.table ?? ownedDbTable);
}

// -- quota ------------------------------------------------------------------------------------------------------

/**
 * Reserve up to `requested` reads of the member's daily cap. The member must be bound for the transport by a user of
 * the company; the database additionally requires the company to OWN it (074). All-or-nothing per call, so a refusal
 * with some remaining is retried ONCE with exactly that. ANY error grants 0 (never "unknown means allow").
 * The cap: the company setting via resolveDailyCap - no setting store exists yet, so it is the default 150 (an
 * ABSENT setting is the default by rule; an UNREADABLE one would refuse).
 */
export async function reserveSalesNavQuota(
  ctx: SalesNavCallerContext,
  input: { linkedinMemberId: string; transport: SalesNavTransport; requested: number },
  deps: SalesNavStoreDeps = {},
): Promise<{ granted: number; remaining: number }> {
  const none = { granted: 0, remaining: 0 };
  const rpc = deps.rpc ?? ownedDbRpc;
  const member = canonicalMemberId(input.linkedinMemberId);
  const n = Math.floor(Number(input.requested));
  if (!member || !Number.isFinite(n) || n < 1) return none;
  const bound = await memberBoundInCompany(ctx.organizationId, input.transport, member, deps);
  if (bound !== true) return none;
  const cap = resolveDailyCap(undefined);
  const day = utcDay((deps.now ?? (() => new Date()))());

  const call = async (count: number): Promise<{ granted: number; remaining: number } | null> => {
    const r = await rpc(CONSUME, {
      p_organization_id: ctx.organizationId, p_member_id: member, p_usage_day: day, p_count: count, p_cap: cap,
    });
    const rows = rowsOf(r as DbResult);
    const row = rows?.[0];
    if (!row || !Number.isInteger(row.granted) || !Number.isInteger(row.remaining)) return null;
    return { granted: row.granted as number, remaining: row.remaining as number };
  };
  const first = await call(Math.min(n, cap));
  if (!first) return none;
  if (first.granted > 0 || first.remaining <= 0) return first;
  return (await call(first.remaining)) ?? none;
}
