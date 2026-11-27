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
import type { ingestLeadBatch } from '../../services/leadIngestion/orchestrator';
import type { ScreenFn } from '../../services/prospectImportReview/screen';
import { resolveDailyCap } from '../../services/salesNav/contract';
import { SALESNAV_LEGAL_STOP_BODY, salesNavLegalCleared, salesNavRouteGate } from '../../services/salesNav/gate';
import {
  decideNextPage, reportClose, reportPause, submitPage,
  type LoopRefusal, type NextDecision, type ReportResult, type SubmitResult,
} from '../../services/salesNav/loop';
import { activeExtensionBinding, storeDepsFor, type ExtensionMemberBindingPort } from '../../services/salesNav/memberBinding';
import { SALESNAV_NEXT_TTL_SECONDS, signNextEnvelope, type SalesNavNextEnvelope } from '../../services/salesNav/nextEnvelope';
import { consumedToday, findOpenRun, toRunStatusView, type SalesNavStoreDeps } from '../../services/salesNav/store';
import { cancelRunCore } from './uiRoutes';

type ExtSession = { userId: string; orgId: string; expiresAt: number; hmacNonce?: string };

export interface SalesNavExtensionDeps {
  readonly auth?: (req: NextApiRequest, res: NextApiResponse) => Promise<{ session: ExtSession } | null>;
  readonly gate?: typeof salesNavRouteGate;
  /** Round 30: the legal switch for /bind and /pages (default: the strict env read). Tests only. */
  readonly legalCleared?: typeof salesNavLegalCleared;
  readonly binding?: ExtensionMemberBindingPort;
  readonly store?: SalesNavStoreDeps;
  readonly screen?: ScreenFn;
  readonly ingest?: typeof ingestLeadBatch;
  readonly secretFor?: (s: ExtSession) => string | null;
  readonly now?: () => Date;
}

/** The route-reportable close pairs live in loop.ts (ONE allowlist for every browser route). */
export { ROUTE_REPORTABLE_CLOSES } from '../../services/salesNav/loop';

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

async function authed(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps) {
  if (!post(req, res)) return null;
  // ROUTE-AUTH-001: the primitive is INVOKED directly (provenance-checked by check-route-auth); deps only for tests
  const a = deps.auth
    ? await deps.auth(req, res)
    : ((await requireExtensionAuth(req, res)) as unknown as { session: ExtSession } | null);
  if (!a) return null;                                   // the middleware already answered
  const s = a.session;
  const store = storeDepsFor(deps.binding ?? activeExtensionBinding, { ...(deps.store ?? {}), ...(deps.now ? { now: deps.now } : {}) });
  return { s, ctx: { organizationId: s.orgId, initiatedBy: s.userId }, store, now: (deps.now ?? (() => new Date()))() };
}

const memberUrn = (id: string) => `urn:li:fsd_profile:${id}`;

/**
 * Round 30 / P0-1 (closes K18): /bind and /pages stop under the legal switch, server-side. Checked AFTER the extension
 * signature (an unsigned caller still gets the middleware's 401 and learns nothing) and BEFORE anything is read,
 * bound or ingested. Fail closed: any value but the exact 'true', or an unreadable switch, refuses. The body is the
 * one fixed legal-stop body - no run, binding or member state.
 */
function legalStop(res: NextApiResponse, deps: SalesNavExtensionDeps): boolean {
  let cleared = false;
  try { cleared = (deps.legalCleared ?? salesNavLegalCleared)('extension') === true; } catch { cleared = false; }
  if (cleared) return false;
  res.status(403).json({ ...SALESNAV_LEGAL_STOP_BODY });
  return true;
}

// -- POST /bind ---------------------------------------------------------------------------------------------------
export async function bindHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  if (legalStop(res, deps)) return;
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

// -- POST /runs/:id/next - the SHARED loop decision (loop.ts), signed for the extension ---------------------------
const loopDeps = (deps: SalesNavExtensionDeps, store: SalesNavStoreDeps) =>
  ({ store, gate: deps.gate, legalCleared: deps.legalCleared, screen: deps.screen, ingest: deps.ingest, now: deps.now });
const refuse = (res: NextApiResponse, r: LoopRefusal) => res.status(r.http).json({ error: r.error, ...(r.extra ?? {}) });

export async function nextHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  const d = await decideNextPage(a.ctx, runIdOf(req), { route: 'extension', attestedMemberId: body(req).attestedMemberId }, loopDeps(deps, a.store));
  if (d.kind === 'refusal') return refuse(res, d as LoopRefusal);
  if (d.kind === 'paused') {
    const p = d as Extract<NextDecision, { kind: 'paused' }>;
    return res.status(200).json({ command: 'paused', status: p.status, code: p.code, ...(p.resumesAt ? { resumesAt: p.resumesAt } : {}) });
  }
  if (d.kind === 'stop') {
    const st = d as Extract<NextDecision, { kind: 'stop' }>;
    return res.status(200).json({ command: 'stop', status: st.status, code: st.code });
  }
  const r = d as Extract<NextDecision, { kind: 'read' }>;
  const secret = (deps.secretFor ?? defaultSecret)(a.s);
  if (!secret) return res.status(503).json({ error: 'SIGNING_UNAVAILABLE' });
  const envelope: SalesNavNextEnvelope = {
    run_id: r.runId, page_index: r.pageIndex, page_url: r.pageUrl, position: r.position,
    max_leads: r.maxLeads, member: memberUrn(r.memberId),
    expires_at: new Date(a.now.getTime() + SALESNAV_NEXT_TTL_SECONDS * 1000).toISOString(),
  };
  return res.status(200).json({
    command: 'read', pageIndex: r.pageIndex, pageUrl: r.pageUrl, position: r.position, maxLeads: r.maxLeads,
    envelope, envelope_signature: signNextEnvelope(envelope, secret),
  });
}

// -- POST /runs/:id/pages - the SHARED submitPage (loop.ts) -----------------------------------------------------------
export async function pagesHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  if (legalStop(res, deps)) return;
  const b = body(req);
  const out = await submitPage(a.ctx, runIdOf(req), {
    route: 'extension', pageIndex: b.pageIndex, finalUrl: b.finalUrl, outcome: b.outcome, unknownCode: b.unknownCode,
    hasNextPage: b.hasNextPage, listTotal: b.listTotal, leads: b.leads, readerVersion: b.reader_version,
    attestedMemberId: b.attestedMemberId,
  }, loopDeps(deps, a.store));
  if (out.kind === 'refusal') return refuse(res, out as LoopRefusal);
  const ok = out as Extract<SubmitResult, { kind: 'ok' }>;
  return res.status(ok.http).json(ok.body);
}

// -- POST /runs/:id/pause, /close - the SHARED reportPause / reportClose (one allowlist for every route) --------------
async function report(res: NextApiResponse, r: ReportResult, okBody: Record<string, unknown>) {
  if (r.kind === 'refusal') return refuse(res, r as LoopRefusal);
  if (r.kind === 'already_closed') return res.status(409).json({ error: 'RUN_NOT_OPEN' });
  return res.status(200).json(okBody);
}

export async function pauseHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  const b = body(req);
  return report(res, await reportPause(a.ctx, runIdOf(req), { route: 'extension', status: b.status, code: b.code }, loopDeps(deps, a.store)), { paused: true });
}

export async function closeHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  const b = body(req);
  return report(res, await reportClose(a.ctx, runIdOf(req),
    { route: 'extension', status: b.status, code: b.code, retryAfterAt: b.retryAfterAt }, loopDeps(deps, a.store)), { closed: true });
}

// -- POST /runs/:id/cancel (extension half) -----------------------------------------------------------------------
export async function cancelRunExtensionHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavExtensionDeps = {}) {
  const a = await authed(req, res, deps);
  if (!a) return;
  return cancelRunCore(a.ctx.organizationId, a.s.userId, runIdOf(req), res, a.store);
}
