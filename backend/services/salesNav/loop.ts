/**
 * THE SHARED PAGE LOOP (owner: one Sales Navigator module, one core). The two decisions every browser route makes
 * per page, implemented ONCE and called by both: the extension (over HTTP, extensionRoutes.ts, which adds the signed
 * envelope) and the Playwright RPA route (89, in-process). So both get the same run state (a Cancel stops the next
 * page), the same cap (the 074 consume, idempotent per page, never refunded), the same handoff position and the same
 * ingestion rules - there is no second implementation of the loop.
 *
 *   decideNextPage  -> read (with the reserved maxLeads) | paused | stop
 *   submitPage      -> the page's counts, or a refusal; ingests at most the reservation, never without one
 *
 * cb (2026-11-21): the reservation IS the 074 consume. Consume first, then mark the run pending. If the mark fails
 * after a granted consume, the cap stays spent and a retried decideNextPage consumes AGAIN - a double spend of cap for
 * one page, never more than one page ingested (owner-ruled direction: less reading, never more).
 */
import { ingestLeadBatch } from '../leadIngestion/orchestrator';
import { screenDiscoveredRecords, type ScreenFn } from '../prospectImportReview/screen';
import {
  ACCEPTED_READER_VERSIONS, canonicalMemberId, isAllowedClose, isCommandedPage, isRepeatedPage, MAX_SALESNAV_PAGE,
  pageReservationRequest, pageUrlFor, SALESNAV_SOURCE,
  type SalesNavCallerContext, type SalesNavPagePosition, type SalesNavRunStatus,
} from './contract';
import { tallyProspectOutcomes } from '../../../lib/prospects/prospectOutcomeTally';
import { SALESNAV_LEGAL_STOP_BODY, salesNavLegalCleared, salesNavRouteGate } from './gate';
import { fromWire, registerSalesNavLeadSource, toBatchRecord } from './ingestAdapter';
import {
  closeSalesNavRun, loadRun, markPendingReservation, pauseSalesNavRun, recordSalesNavPage, reserveSalesNavQuota,
  toRunStatusView, type SalesNavRunRow, type SalesNavStoreDeps,
} from './store';

export type BrowserRoute = 'extension' | 'rpa';

export interface SalesNavLoopDeps {
  readonly store?: SalesNavStoreDeps;
  readonly gate?: typeof salesNavRouteGate;
  /** Round 30: the legal switch checked by submitPage (default: the strict env read). Tests only. */
  readonly legalCleared?: typeof salesNavLegalCleared;
  readonly screen?: ScreenFn;
  readonly ingest?: typeof ingestLeadBatch;
  readonly now?: () => Date;
}

/** A refusal with the HTTP status a route should answer (the in-process RPA route reads `error`). */
export interface LoopRefusal { readonly kind: 'refusal'; readonly http: number; readonly error: string; readonly extra?: Record<string, unknown> }

export type NextDecision =
  | { readonly kind: 'read'; readonly runId: string; readonly memberId: string; readonly pageIndex: number;
      readonly pageUrl: string; readonly position: SalesNavPagePosition; readonly maxLeads: number }
  | { readonly kind: 'paused'; readonly status: SalesNavRunStatus; readonly code: string | null; readonly resumesAt?: string }
  | { readonly kind: 'stop'; readonly status: SalesNavRunStatus | string; readonly code: string | null }
  | LoopRefusal;

const nextUtcMidnight = (now: Date): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

async function runOrRefusal(org: string, runId: string | undefined, store: SalesNavStoreDeps): Promise<SalesNavRunRow | LoopRefusal> {
  if (!runId) return { kind: 'refusal', http: 400, error: 'RUN_ID_REQUIRED' };
  const run = await loadRun(org, runId, store);
  if (run === 'unreadable') return { kind: 'refusal', http: 503, error: 'STORE_UNREADABLE' };
  if (!run) return { kind: 'refusal', http: 404, error: 'RUN_NOT_FOUND' };
  return run;
}
const isRefusal = (v: unknown): v is LoopRefusal => !!v && typeof v === 'object' && (v as LoopRefusal).kind === 'refusal';

/** The server's decision for the NEXT page of a run, for the route that holds it. */
export async function decideNextPage(
  ctx: SalesNavCallerContext, runId: string | undefined, input: { route: BrowserRoute; attestedMemberId: unknown },
  deps: SalesNavLoopDeps = {},
): Promise<NextDecision> {
  const store = deps.store ?? {};
  const now = (deps.now ?? (() => new Date()))();
  const loaded = await runOrRefusal(ctx.organizationId, runId, store);
  if (isRefusal(loaded)) return loaded;
  const run = loaded;
  if (run.active_route !== input.route) return { kind: 'refusal', http: 409, error: 'RUN_NOT_HELD_BY_ROUTE', extra: { heldBy: run.active_route } };
  if (run.status === 'paused_daily_cap' || run.status === 'auth_expired') {
    return { kind: 'paused', status: run.status, code: run.status_code,
      ...(run.status === 'paused_daily_cap' ? { resumesAt: nextUtcMidnight(now) } : {}) };
  }
  // a Cancel (or any close) STOPS the next page for every route
  if (run.status !== 'running') return { kind: 'stop', status: run.status, code: run.status_code };

  if (canonicalMemberId(input.attestedMemberId) !== run.member_id) {
    await closeSalesNavRun(ctx, { runId: run.id, status: 'refused', code: 'member_mismatch' }, store);
    return { kind: 'stop', status: 'refused', code: 'member_mismatch' };
  }
  const gate = await (deps.gate ?? salesNavRouteGate)(ctx, input.route);
  if (!gate.allowed) {
    await closeSalesNavRun(ctx, { runId: run.id, status: 'refused', code: 'gate_closed' }, store);
    return { kind: 'stop', status: 'refused', code: 'gate_closed' };
  }
  const pageIndex = run.next_page_index;
  const commanded = pageUrlFor(run.canonical_url, pageIndex);
  if (!commanded) {
    await closeSalesNavRun(ctx, { runId: run.id, status: 'failed', code: 'internal_error' }, store);
    return { kind: 'stop', status: 'failed', code: 'internal_error' };
  }

  let granted: number;
  if (run.pending_page_index === pageIndex && typeof run.pending_granted === 'number') {
    granted = run.pending_granted;                       // idempotent re-issue: NO second consume
  } else {
    const ask = pageReservationRequest({
      pageIndex, listTotal: run.list_total, readSoFar: run.leads_read,
      lastHasNextPage: run.last_has_next_page, totalUnreliable: run.total_unreliable,
    });
    const quota = await reserveSalesNavQuota(ctx, { linkedinMemberId: run.member_id, transport: run.transport, requested: Math.max(1, ask.requested) }, store);
    if (quota.granted <= 0) {
      // ONLY the quota granting 0 pauses for the cap (never a computed 0)
      await pauseSalesNavRun(ctx, { runId: run.id, status: 'paused_daily_cap', code: 'daily_cap' }, store);
      return { kind: 'paused', status: 'paused_daily_cap', code: 'daily_cap', resumesAt: nextUtcMidnight(now) };
    }
    granted = Math.min(MAX_SALESNAV_PAGE, quota.granted);
    const marked = await markPendingReservation(ctx, { runId: run.id, pageIndex, granted, totalUnreliable: ask.totalUnreliable }, store);
    // the cap is SPENT either way; a retry consumes again (header) - say so, never "nothing happened"
    if (marked !== 'ok') return { kind: 'refusal', http: 503, error: 'RESERVATION_NOT_RECORDED', extra: { capConsumed: granted } };
  }
  return { kind: 'read', runId: run.id, memberId: run.member_id, pageIndex, pageUrl: commanded.pageUrl, position: commanded.position, maxLeads: granted };
}

export interface SubmitPageInput {
  readonly route: BrowserRoute;
  readonly pageIndex: unknown;
  readonly finalUrl: unknown;
  readonly outcome: unknown;
  readonly unknownCode?: unknown;
  readonly hasNextPage: unknown;
  readonly listTotal: unknown;
  readonly leads: unknown;
  readonly readerVersion: unknown;
  readonly attestedMemberId: unknown;
}

export type SubmitResult =
  | { readonly kind: 'ok'; readonly http: number; readonly body: Record<string, unknown> }
  | LoopRefusal;

/** Submit one page the route READ: validate, cap at the reservation, dedupe, screen, ingest, record - or refuse. */
export async function submitPage(
  ctx: SalesNavCallerContext, runId: string | undefined, input: SubmitPageInput, deps: SalesNavLoopDeps = {},
): Promise<SubmitResult> {
  // Round 30 / P0-1: the legal switch FIRST, for every browser route (the extension handler checks it too; the
  // in-process RPA route reaches here directly). Before any read, so a stopped transport ingests nothing and reveals
  // nothing; fail closed on any value but the exact 'true'. The next decideNextPage closes the run (gate_closed).
  let cleared = false;
  try { cleared = (deps.legalCleared ?? salesNavLegalCleared)(input.route) === true; } catch { cleared = false; }
  if (!cleared) {
    return { kind: 'refusal', http: 403, error: SALESNAV_LEGAL_STOP_BODY.error, extra: { reason: SALESNAV_LEGAL_STOP_BODY.reason } };
  }
  const store = deps.store ?? {};
  const now = (deps.now ?? (() => new Date()))();
  const loaded = await runOrRefusal(ctx.organizationId, runId, store);
  if (isRefusal(loaded)) return loaded;
  const run = loaded;
  if (run.active_route !== input.route) return { kind: 'refusal', http: 409, error: 'RUN_NOT_HELD_BY_ROUTE', extra: { heldBy: run.active_route } };
  if (run.status !== 'running') return { kind: 'refusal', http: 409, error: 'RUN_NOT_RUNNING', extra: { status: run.status } };
  const view = async () => {
    const after = await loadRun(ctx.organizationId, run.id, store);
    return after && after !== 'unreadable' ? toRunStatusView(after, now) : null;
  };
  // 89 (R4): a refusal that ENDS the run says so EXPLICITLY - extra.closed is whether the close actually APPLIED (a
  // failed close write leaves the run running, and an inferred "it has a code, so it closed" would then be wrong).
  const closeWith = async (status: 'refused' | 'unknown', code: string, http: number, error: string): Promise<SubmitResult> => {
    let closed: boolean;
    if (status === 'unknown') {
      const r = await recordSalesNavPage(ctx, { runId: run.id, pageIndex: run.next_page_index, outcome: 'unknown', hasNextPage: null,
        listTotal: null, leadKeys: [], unknownCode: code }, store);
      // `in`, not a boolean test: tsconfig.json:11 is "strict": false (repo-wide), so a boolean-literal discriminant does NOT narrow a union here - do not 'simplify' back
      closed = !('reason' in r);
    } else {
      closed = (await closeSalesNavRun(ctx, { runId: run.id, status, code }, store)) === 'ok';
    }
    return { kind: 'refusal', http, error, extra: { closed, code, run: await view() } };
  };

  if (canonicalMemberId(input.attestedMemberId) !== run.member_id) return closeWith('refused', 'member_mismatch', 409, 'MEMBER_MISMATCH');
  // a9 / 7c: an outdated reader CLOSES the run at once, so the user is told to update, not that it stalled
  if (!ACCEPTED_READER_VERSIONS.includes(String(input.readerVersion))) {
    return closeWith('refused', 'reader_version_unsupported', 422, 'READER_VERSION_UNSUPPORTED');
  }
  if (input.outcome === 'unknown') {
    const code = isAllowedClose('unknown', input.unknownCode) ? String(input.unknownCode) : 'page_unconfirmed';
    return closeWith('unknown', code, 200, 'PAGE_UNKNOWN');
  }
  const pageIndex = Number(input.pageIndex);
  // no reservation for this page -> nothing is ingested (a page without a decideNextPage, or a replay of a spent page)
  if (run.pending_page_index !== pageIndex || typeof run.pending_granted !== 'number') {
    return { kind: 'refusal', http: 409, error: 'NO_RESERVATION' };
  }
  const commanded = pageUrlFor(run.canonical_url, pageIndex);
  if (!commanded || !isCommandedPage(input.finalUrl, commanded.pageUrl, commanded.position)) {
    return closeWith('unknown', 'page_position_mismatch', 200, 'PAGE_POSITION_MISMATCH');
  }

  // validate every lead (the landed original fromWire: never store a /sales/ URL or credentials)
  const capturedAt = now.toISOString();
  const raw = Array.isArray(input.leads) ? input.leads : [];
  const valid = raw.map((w) => fromWire(w, capturedAt));
  const leads = valid.flatMap((v) => ('lead' in v ? [v.lead] : []));
  const rejected = valid.length - leads.length;
  const keys = [...new Set(leads.map((l) => l.lead_key))];
  // the repeat backstop BEFORE anything is ingested
  if (isRepeatedPage(run.seen_lead_keys, keys)) return closeWith('unknown', 'page_repeated', 200, 'PAGE_REPEATED');

  const seen = new Set(run.seen_lead_keys);
  const fresh: typeof leads = [];
  let skippedInRun = 0;
  for (const l of leads) { if (seen.has(l.lead_key)) skippedInRun += 1; else { seen.add(l.lead_key); fresh.push(l); } }
  const withinCap = fresh.slice(0, run.pending_granted);
  const quotaRefused = fresh.length - withinCap.length;

  registerSalesNavLeadSource();
  const records = withinCap.map((l) => toBatchRecord(l, input.route));
  const screened = records.length
    ? await (deps.screen ?? screenDiscoveredRecords)({ organizationId: ctx.organizationId, source: SALESNAV_SOURCE, records, now: capturedAt })
    : { toIngest: [], skippedDuplicates: 0, heldForReview: 0, probeUnknown: 0 };
  let created = 0; let updated = 0; let unchanged = 0; let failed = 0;
  if (screened.toIngest.length) {
    const batch = await (deps.ingest ?? ingestLeadBatch)({
      organizationId: ctx.organizationId, source: SALESNAV_SOURCE, records: screened.toIngest,
      ingestionRunId: run.id, now: capturedAt,
    });
    // Round 30 / P0-2: "created" counts canonical PROSPECTS the resolver created (prospectOutcome), once each - not
    // new EVIDENCE rows (provenanceOutcome), which counted a new source record for an existing prospect as a new
    // lead. Every outcome lands in exactly one bucket, so accepted = created + updated + skipped + held + ... holds.
    const t = tallyProspectOutcomes(batch.outcomes);
    created = t.newProspects;
    updated = t.updated + t.withoutProspect + t.unclassified;
    unchanged = t.unchanged;
    failed = t.rejected;
  }
  const skippedDuplicates = skippedInRun + screened.skippedDuplicates + unchanged;
  const recorded = await recordSalesNavPage(ctx, {
    runId: run.id, pageIndex, outcome: 'ok', hasNextPage: typeof input.hasNextPage === 'boolean' ? input.hasNextPage : null,
    listTotal: input.listTotal, leadKeys: keys,
    counts: {
      leads_read: raw.length, accepted: withinCap.length, rejected: rejected + failed, created_count: created,
      updated_count: updated, held_for_review: screened.heldForReview, skipped_duplicates: skippedDuplicates,
      // the R3 screen could not check these against the company's leads (a probe read did not answer): NOT imported
      // (fail closed) and COUNTED - never silently lost from the page's totals (found by the end-to-end test)
      dropped: screened.probeUnknown,
      quota_refused: quotaRefused,
    },
  }, store);
  // `in`, not a boolean test: tsconfig.json:11 is "strict": false (repo-wide), so a boolean-literal discriminant does NOT narrow a union here - do not 'simplify' back
  if ('reason' in recorded) {
    return { kind: 'refusal', http: recorded.reason === 'store_unreadable' ? 503 : 409, error: 'PAGE_NOT_RECORDED', extra: { reason: recorded.reason } };
  }
  return {
    kind: 'ok', http: 200,
    body: {
      accepted: withinCap.length, rejected: rejected + failed, created, updated, heldForReview: screened.heldForReview,
      skippedDuplicates, probeUnknown: screened.probeUnknown, dropped: screened.probeUnknown, quotaRefused, run: await view(),
    },
  };
}

// -- route-reported pauses and closes (ONE allowlist for every browser route) ----------------------------------------

/**
 * Terminal pairs a ROUTE may report (a9 v0.2 + 89 R4): a rate notice, an off-allowlist redirect, a member mismatch,
 * our own malformed command, and a transport failure before any read. Every other terminal is the server's to decide
 * (completed / unknown come from submitPage; refused gate_closed / reader_version_unsupported from the loop).
 */
export const ROUTE_REPORTABLE_CLOSES = [
  ['rate_limited', 'site_rate_limit'], ['refused', 'url_not_allowed'], ['refused', 'member_mismatch'],
  ['failed', 'internal_error'], ['failed', 'transport_error'],
] as const;

export type ReportResult = { readonly kind: 'ok' } | { readonly kind: 'already_closed' } | LoopRefusal;

/** A route reports LinkedIn logged out / checkpoint: the run STOPS (auth_expired) and the user is told. */
export async function reportPause(
  ctx: SalesNavCallerContext, runId: string | undefined, input: { route: BrowserRoute; status: unknown; code: unknown },
  deps: SalesNavLoopDeps = {},
): Promise<ReportResult> {
  const store = deps.store ?? {};
  const loaded = await runOrRefusal(ctx.organizationId, runId, store);
  if (isRefusal(loaded)) return loaded;
  if (loaded.active_route !== input.route) return { kind: 'refusal', http: 409, error: 'RUN_NOT_HELD_BY_ROUTE' };
  // a route reports ONLY auth_expired; the daily-cap pause is the server's (decideNextPage)
  if (input.status !== 'auth_expired') return { kind: 'refusal', http: 422, error: 'CODE_NOT_ALLOWED' };
  const r = await pauseSalesNavRun(ctx, { runId: loaded.id, status: 'auth_expired', code: String(input.code) }, store);
  if (r === 'ok') return { kind: 'ok' };
  if (r === 'code_not_allowed') return { kind: 'refusal', http: 422, error: 'CODE_NOT_ALLOWED' };
  if (r === 'unreadable') return { kind: 'refusal', http: 503, error: 'STORE_UNREADABLE' };
  return { kind: 'already_closed' };
}

/** A route reports a terminal outcome from the allowlist; the status comes from the matched pair, never a cast. */
export async function reportClose(
  ctx: SalesNavCallerContext, runId: string | undefined,
  input: { route: BrowserRoute; status: unknown; code: unknown; retryAfterAt?: unknown }, deps: SalesNavLoopDeps = {},
): Promise<ReportResult> {
  const store = deps.store ?? {};
  const loaded = await runOrRefusal(ctx.organizationId, runId, store);
  if (isRefusal(loaded)) return loaded;
  if (loaded.active_route !== input.route) return { kind: 'refusal', http: 409, error: 'RUN_NOT_HELD_BY_ROUTE' };
  const pair = ROUTE_REPORTABLE_CLOSES.find(([s, c]) => s === input.status && c === input.code);
  if (!pair) return { kind: 'refusal', http: 422, error: 'CODE_NOT_ALLOWED' };
  const r = await closeSalesNavRun(ctx, {
    runId: loaded.id, status: pair[0], code: pair[1],
    retryAfterAt: typeof input.retryAfterAt === 'string' ? input.retryAfterAt : null,
  }, store);
  if (r === 'ok') return { kind: 'ok' };
  if (r === 'unreadable') return { kind: 'refusal', http: 503, error: 'STORE_UNREADABLE' };
  return { kind: 'already_closed' };
}
