/**
 * Sales Navigator ROUTE CONTRACT v0.3 - GROUP B: the routes the Chrome EXTENSION calls (requireExtensionAuth: the
 * v15 HMAC request signature). The tenant and user come ONLY from the verified extension session.
 *
 *   POST /api/salesnav/bind                 { memberId }   the extension ATTESTS the logged-in member (b3: path 2)
 *   POST /api/salesnav/runs/open            {}             the user's open run, or { run: null }
 *   POST /api/salesnav/status               {}             { enabled, bound, remaining_today, cap, run }
 *   POST /api/salesnav/runs/:id/next        { attestedMemberId }   the SERVER decides; the 'read' answer is SIGNED
 *   POST /api/salesnav/runs/:id/pages       { pageIndex, finalUrl, outcome, ... leads, reader_version, attestedMemberId }
 *   POST /api/salesnav/runs/:id/pause       { status: 'auth_expired', code }
 *   POST /api/salesnav/runs/:id/close       { status, code, retryAfterAt? }   route-REPORTED terminals only
 *   POST /api/salesnav/runs/:id/cancel      (extension half; the session half is in uiRoutes.ts)
 *
 * /next (cb, 2026-11-21): the reservation IS the 074 consume (never refunded). Consume first, then mark the run
 * pending. If the mark fails after a granted consume, the cap stays spent and a RETRIED /next consumes AGAIN - a
 * double spend of cap for one page, never more than one page ingested. Owner-ruled direction: less reading, never
 * more. A /next for a page whose reservation is already outstanding RE-ISSUES it without consuming (idempotent).
 * /pages: refuses a page that has no reservation, ingests at most pending_granted leads, and clears the reservation in
 * the same update that advances the position.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireExtensionAuth } from '../../middleware/extensionAuthMiddleware';
import { deriveExtensionHmacSecret } from '../../services/extensionSessionService';
import { ingestLeadBatch } from '../../services/leadIngestion/orchestrator';
import { screenDiscoveredRecords, type ScreenFn } from '../../services/prospectImportReview/screen';
import {
  ACCEPTED_READER_VERSIONS, canonicalMemberId, isAllowedClose, isCommandedPage, isRepeatedPage,
  MAX_SALESNAV_PAGE, pageReservationRequest, pageUrlFor, resolveDailyCap, SALESNAV_SOURCE,
  type SalesNavTerminalStatus,
} from '../../services/salesNav/contract';
import { salesNavRouteGate } from '../../services/salesNav/gate';
import { fromWire, registerSalesNavLeadSource, toBatchRecord } from '../../services/salesNav/ingestAdapter';
import { activeExtensionBinding, storeDepsFor, type ExtensionMemberBindingPort } from '../../services/salesNav/memberBinding';
import { SALESNAV_NEXT_TTL_SECONDS, signNextEnvelope, type SalesNavNextEnvelope } from '../../services/salesNav/nextEnvelope';
import {
  closeSalesNavRun, consumedToday, findOpenRun, loadRun, markPendingReservation, pauseSalesNavRun,
  recordSalesNavPage, reserveSalesNavQuota, toRunStatusView, type SalesNavRunRow, type SalesNavStoreDeps,
} from '../../services/salesNav/store';
import { cancelRunCore } from './uiRoutes';

type ExtSession = { userId: string; orgId: string; expiresAt: number; hmacNonce?: string };

export interface SalesNavExtensionDeps {
  readonly auth?: (req: NextApiRequest, res: NextApiResponse) => Promise<{ session: ExtSession } | null>;
  readonly gate?: typeof salesNavRouteGate;
  readonly binding?: ExtensionMemberBindingPort;
  readonly store?: SalesNavStoreDeps;
  readonly screen?: ScreenFn;
  readonly ingest?: typeof ingestLeadBatch;
  readonly secretFor?: (s: ExtSession) => string | null;
  readonly now?: () => Date;
}

/** Route-REPORTED terminal pairs the extension may send to /close (a9 v0.2 mapping); anything else -> 422. */
export const ROUTE_REPORTABLE_CLOSES: ReadonlyArray<readonly [SalesNavTerminalStatus, string]> = [
  ['rate_limited', 'site_rate_limit'], ['refused', 'url_not_allowed'], ['refused', 'member_mismatch'],
  ['failed', 'internal_error'],
];

const body = (req: NextApiRequest): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
const runIdOf = (req: NextApiRequest): string | undefined => {
  const v = req.query?.id;
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
};
const post = (req: NextApiRequest, res: NextApiResponse): boolean => {
  if ((req.method ?? '').toUpperCase() === 'POST') return true;
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  return false;
};
const defaultSecret = (s: ExtSession): string | null =>
  (s.hmacNonce ? deriveExtensionHmacSecret({ userId: s.userId, orgId: s.orgId, expiresAt: s.expiresAt, nonce: s.hmacNonce }) : null);
const nextUtcMidnight = (now: Date): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

async function authed(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps) {
  if (!post(req, res)) return null;
  const a = await (deps.auth ?? (requireExtensionAuth as unknown as NonNullable<SalesNavExtensionDeps['auth']>))(req, res);
  if (!a) return null;                                   // the middleware already answered
  const s = a.session;
  const store = storeDepsFor(deps.binding ?? activeExtensionBinding, { ...(deps.store ?? {}), ...(deps.now ? { now: deps.now } : {}) });
  return { s, ctx: { organizationId: s.orgId, initiatedBy: s.userId }, store, now: (deps.now ?? (() => new Date()))() };
}

/** Load THIS company's run: the row, or the response already written (404 / 503). */
async function runOr(res: NextApiResponse, org: string, runId: string | undefined, store: SalesNavStoreDeps): Promise<SalesNavRunRow | null> {
  if (!runId) { res.status(400).json({ error: 'RUN_ID_REQUIRED' }); return null; }
  const run = await loadRun(org, runId, store);
  if (run === 'unreadable') { res.status(503).json({ error: 'STORE_UNREADABLE' }); return null; }
  if (!run) { res.status(404).json({ error: 'RUN_NOT_FOUND' }); return null; }
  return run;
}

const memberUrn = (id: string) => `urn:li:fsd_profile:${id}`;

// -- POST /bind ---------------------------------------------------------------------------------------------------
export async function bindHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  const out = await (deps.binding ?? activeExtensionBinding).bind(a.ctx, body(req).memberId, a.store);
  // `in`, not a boolean test: tsconfig.json:11 is "strict": false (repo-wide), so a boolean-literal discriminant does NOT narrow a union here - do not 'simplify' back
  if (!('reason' in out)) return res.status(200).json({ bound: true });
  switch (out.reason) {
    case 'member_unresolved': return res.status(422).json({ error: 'MEMBER_UNRESOLVED' });
    case 'member_owned_by_another_company': return res.status(409).json({ error: 'MEMBER_OWNED_BY_ANOTHER_COMPANY' });
    case 'account_binding_conflict': return res.status(409).json({ error: 'ACCOUNT_BINDING_CONFLICT' });
    case 'no_user': return res.status(401).json({ error: 'NO_USER' });
    default: return res.status(503).json({ error: 'STORE_UNREADABLE' });
  }
}

// -- POST /runs/open ----------------------------------------------------------------------------------------------
export async function openRunHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  const member = await a.store.memberFor!(a.ctx.organizationId, a.s.userId, 'extension');
  if (member === 'unreadable') return res.status(503).json({ error: 'STORE_UNREADABLE' });
  if (!member) return res.status(200).json({ run: null });
  const run = await findOpenRun(a.ctx.organizationId, member, a.store);
  if (run === 'unreadable') return res.status(503).json({ error: 'STORE_UNREADABLE' });
  if (!run) return res.status(200).json({ run: null });
  const view = toRunStatusView(run, a.now);
  return res.status(200).json({
    runId: run.id, transport: run.transport, urlKind: run.url_kind,
    // 7c / a9: the list pin - every pageUrl of the run must canonicalise to this
    canonicalUrl: run.canonical_url,
    status: view.status, code: view.code, nextPageIndex: run.next_page_index,
  });
}

// -- POST /status -------------------------------------------------------------------------------------------------
export async function statusHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  const gate = await (deps.gate ?? salesNavRouteGate)(a.ctx, 'extension');
  const member = await a.store.memberFor!(a.ctx.organizationId, a.s.userId, 'extension');
  const cap = resolveDailyCap(undefined);
  let remaining: number | null = null;
  let run: ReturnType<typeof toRunStatusView> | null = null;
  if (typeof member === 'string') {
    const used = await consumedToday(member, a.store);
    // unreadable -> null, NEVER shown as a full cap
    remaining = used === 'unreadable' ? null : Math.max(0, cap - used);
    const open = await findOpenRun(a.ctx.organizationId, member, a.store);
    if (open && open !== 'unreadable') run = toRunStatusView(open, a.now);
  }
  return res.status(200).json({
    enabled: gate.allowed, gateReason: gate.reason,
    bound: member === 'unreadable' ? null : member !== null,
    remaining_today: remaining, cap, run,
  });
}

// -- POST /runs/:id/next ------------------------------------------------------------------------------------------
export async function nextHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  const run = await runOr(res, a.ctx.organizationId, runIdOf(req), a.store);
  if (!run) return;
  if (run.transport !== 'extension' || run.active_route !== 'extension') {
    return res.status(409).json({ error: 'RUN_NOT_HELD_BY_EXTENSION' });
  }
  if (run.status === 'paused_daily_cap' || run.status === 'auth_expired') {
    return res.status(200).json({ command: 'paused', status: run.status, code: run.status_code,
      ...(run.status === 'paused_daily_cap' ? { resumesAt: nextUtcMidnight(a.now) } : {}) });
  }
  if (run.status !== 'running') return res.status(200).json({ command: 'stop', status: run.status, code: run.status_code });

  // the logged-in member must be the run's member (the reader checks first; this is the server's half)
  if (canonicalMemberId(body(req).attestedMemberId) !== run.member_id) {
    await closeSalesNavRun(a.ctx, { runId: run.id, status: 'refused', code: 'member_mismatch' }, a.store);
    return res.status(200).json({ command: 'stop', status: 'refused', code: 'member_mismatch' });
  }
  const gate = await (deps.gate ?? salesNavRouteGate)(a.ctx, 'extension');
  if (!gate.allowed) {
    await closeSalesNavRun(a.ctx, { runId: run.id, status: 'refused', code: 'gate_closed' }, a.store);
    return res.status(200).json({ command: 'stop', status: 'refused', code: 'gate_closed' });
  }

  const pageIndex = run.next_page_index;
  const commanded = pageUrlFor(run.canonical_url, pageIndex);
  if (!commanded) {
    await closeSalesNavRun(a.ctx, { runId: run.id, status: 'failed', code: 'internal_error' }, a.store);
    return res.status(200).json({ command: 'stop', status: 'failed', code: 'internal_error' });
  }

  let granted: number;
  if (run.pending_page_index === pageIndex && typeof run.pending_granted === 'number') {
    granted = run.pending_granted;                       // idempotent re-issue: NO second consume
  } else {
    const ask = pageReservationRequest({
      pageIndex, listTotal: run.list_total, readSoFar: run.leads_read,
      lastHasNextPage: run.last_has_next_page, totalUnreliable: run.total_unreliable,
    });
    const quota = await reserveSalesNavQuota(a.ctx, { linkedinMemberId: run.member_id, transport: 'extension', requested: Math.max(1, ask.requested) }, a.store);
    if (quota.granted <= 0) {
      // ONLY the quota granting 0 pauses for the cap (never a computed 0)
      await pauseSalesNavRun(a.ctx, { runId: run.id, status: 'paused_daily_cap', code: 'daily_cap' }, a.store);
      return res.status(200).json({ command: 'paused', status: 'paused_daily_cap', code: 'daily_cap', resumesAt: nextUtcMidnight(a.now) });
    }
    granted = Math.min(MAX_SALESNAV_PAGE, quota.granted);
    const marked = await markPendingReservation(a.ctx, { runId: run.id, pageIndex, granted, totalUnreliable: ask.totalUnreliable }, a.store);
    // the cap is SPENT either way; a retry consumes again (header) - say so, never "nothing happened"
    if (marked !== 'ok') return res.status(503).json({ error: 'RESERVATION_NOT_RECORDED', capConsumed: granted });
  }

  const secret = (deps.secretFor ?? defaultSecret)(a.s);
  if (!secret) return res.status(503).json({ error: 'SIGNING_UNAVAILABLE' });
  const envelope: SalesNavNextEnvelope = {
    run_id: run.id, page_index: pageIndex, page_url: commanded.pageUrl, position: commanded.position,
    max_leads: granted, member: memberUrn(run.member_id),
    expires_at: new Date(a.now.getTime() + SALESNAV_NEXT_TTL_SECONDS * 1000).toISOString(),
  };
  return res.status(200).json({
    command: 'read', pageIndex, pageUrl: commanded.pageUrl, position: commanded.position, maxLeads: granted,
    envelope, envelope_signature: signNextEnvelope(envelope, secret),
  });
}

// -- POST /runs/:id/pages -----------------------------------------------------------------------------------------
export async function pagesHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  const run = await runOr(res, a.ctx.organizationId, runIdOf(req), a.store);
  if (!run) return;
  if (run.status !== 'running') return res.status(409).json({ error: 'RUN_NOT_RUNNING', status: run.status });
  const b = body(req);
  const closeWith = async (status: 'refused' | 'unknown', code: string, http: number, error: string) => {
    if (status === 'unknown') {
      await recordSalesNavPage(a.ctx, { runId: run.id, pageIndex: run.next_page_index, outcome: 'unknown', hasNextPage: null,
        listTotal: null, leadKeys: [], unknownCode: code }, a.store);
    } else {
      await closeSalesNavRun(a.ctx, { runId: run.id, status, code }, a.store);
    }
    const after = await loadRun(a.ctx.organizationId, run.id, a.store);
    return res.status(http).json({ error, code, run: after && after !== 'unreadable' ? toRunStatusView(after, a.now) : null });
  };

  if (canonicalMemberId(b.attestedMemberId) !== run.member_id) return closeWith('refused', 'member_mismatch', 409, 'MEMBER_MISMATCH');
  // a9 / 7c: an outdated reader CLOSES the run at once, so the card can say "update the extension"
  if (!ACCEPTED_READER_VERSIONS.includes(String(b.reader_version))) {
    return closeWith('refused', 'reader_version_unsupported', 422, 'READER_VERSION_UNSUPPORTED');
  }
  if (b.outcome === 'unknown') {
    const code = isAllowedClose('unknown', b.unknownCode) ? String(b.unknownCode) : 'page_unconfirmed';
    return closeWith('unknown', code, 200, 'PAGE_UNKNOWN');
  }
  const pageIndex = Number(b.pageIndex);
  // no reservation for this page -> nothing is ingested (a /pages without a /next, or a replay of a spent page)
  if (run.pending_page_index !== pageIndex || typeof run.pending_granted !== 'number') {
    return res.status(409).json({ error: 'NO_RESERVATION' });
  }
  const commanded = pageUrlFor(run.canonical_url, pageIndex);
  if (!commanded || !isCommandedPage(b.finalUrl, commanded.pageUrl, commanded.position)) {
    return closeWith('unknown', 'page_position_mismatch', 200, 'PAGE_POSITION_MISMATCH');
  }

  // validate every lead (the landed original fromWire: never store a /sales/ URL or credentials)
  const capturedAt = a.now.toISOString();
  const raw = Array.isArray(b.leads) ? b.leads : [];
  const valid: ReturnType<typeof fromWire>[] = raw.map((w) => fromWire(w, capturedAt));
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
  const records = withinCap.map((l) => toBatchRecord(l, 'extension'));
  const screened = records.length
    ? await (deps.screen ?? screenDiscoveredRecords)({ organizationId: a.ctx.organizationId, source: SALESNAV_SOURCE, records, now: capturedAt })
    : { toIngest: [], skippedDuplicates: 0, heldForReview: 0, probeUnknown: 0 };
  let created = 0; let updated = 0; let unchanged = 0; let failed = 0;
  if (screened.toIngest.length) {
    const batch = await (deps.ingest ?? ingestLeadBatch)({
      organizationId: a.ctx.organizationId, source: SALESNAV_SOURCE, records: screened.toIngest,
      ingestionRunId: run.id, now: capturedAt,
    });
    for (const o of batch.outcomes) {
      if (!o.ok) failed += 1;
      else if (o.provenanceOutcome === 'created') created += 1;
      else if (o.provenanceOutcome === 'changed') updated += 1;
      else unchanged += 1;
    }
  }
  const skippedDuplicates = skippedInRun + screened.skippedDuplicates + unchanged;
  const counts = {
    leads_read: raw.length, accepted: withinCap.length, rejected: rejected + failed, created_count: created,
    updated_count: updated, held_for_review: screened.heldForReview, skipped_duplicates: skippedDuplicates,
    quota_refused: quotaRefused,
  };
  const recorded = await recordSalesNavPage(a.ctx, {
    runId: run.id, pageIndex, outcome: 'ok', hasNextPage: typeof b.hasNextPage === 'boolean' ? b.hasNextPage : null,
    listTotal: b.listTotal, leadKeys: keys, counts,
  }, a.store);
  // `in`, not a boolean test: tsconfig.json:11 is "strict": false (repo-wide), so a boolean-literal discriminant does NOT narrow a union here - do not 'simplify' back
  if ('reason' in recorded) {
    return res.status(recorded.reason === 'store_unreadable' ? 503 : 409).json({ error: 'PAGE_NOT_RECORDED', reason: recorded.reason });
  }
  const after = await loadRun(a.ctx.organizationId, run.id, a.store);
  return res.status(200).json({
    accepted: withinCap.length, rejected: rejected + failed, created, updated, heldForReview: screened.heldForReview,
    skippedDuplicates, dropped: 0, quotaRefused,
    run: after && after !== 'unreadable' ? toRunStatusView(after, a.now) : null,
  });
}

// -- POST /runs/:id/pause -----------------------------------------------------------------------------------------
export async function pauseHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  const run = await runOr(res, a.ctx.organizationId, runIdOf(req), a.store);
  if (!run) return;
  const b = body(req);
  // the extension reports ONLY auth_expired; the daily-cap pause is the server's (/next), never a route's
  if (b.status !== 'auth_expired') return res.status(422).json({ error: 'CODE_NOT_ALLOWED' });
  const r = await pauseSalesNavRun(a.ctx, { runId: run.id, status: 'auth_expired', code: String(b.code) }, a.store);
  if (r === 'ok') return res.status(200).json({ paused: true });
  if (r === 'code_not_allowed') return res.status(422).json({ error: 'CODE_NOT_ALLOWED' });
  if (r === 'unreadable') return res.status(503).json({ error: 'STORE_UNREADABLE' });
  return res.status(409).json({ error: 'RUN_NOT_RUNNING' });
}

// -- POST /runs/:id/close -----------------------------------------------------------------------------------------
export async function closeHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  const run = await runOr(res, a.ctx.organizationId, runIdOf(req), a.store);
  if (!run) return;
  const b = body(req);
  // the status comes from the MATCHED allowed pair, never cast from the body
  const pair = ROUTE_REPORTABLE_CLOSES.find(([s, c]) => s === b.status && c === b.code);
  if (!pair) return res.status(422).json({ error: 'CODE_NOT_ALLOWED' });
  const r = await closeSalesNavRun(a.ctx, {
    runId: run.id, status: pair[0], code: pair[1],
    retryAfterAt: typeof b.retryAfterAt === 'string' ? b.retryAfterAt : null,
  }, a.store);
  if (r === 'ok') return res.status(200).json({ closed: true });
  if (r === 'unreadable') return res.status(503).json({ error: 'STORE_UNREADABLE' });
  return res.status(409).json({ error: 'RUN_NOT_OPEN' });
}

// -- POST /runs/:id/cancel (extension half) -----------------------------------------------------------------------
export async function cancelRunExtensionHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  return cancelRunCore(a.ctx.organizationId, a.s.userId, runIdOf(req), res, a.store);
}
