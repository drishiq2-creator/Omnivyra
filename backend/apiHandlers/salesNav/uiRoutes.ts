/**
 * Sales Navigator ROUTE CONTRACT v0.3 - GROUP A: the routes the Omnivyra web app calls (browser session).
 *
 *   GET  /api/salesnav/setup?companyId=&transport=   the ack text, whether it is acked, the gate, whether bound
 *   POST /api/salesnav/ack?companyId=                { transport, shownVersion, shownTextSha256 }
 *   POST /api/salesnav/runs?companyId=               { transport, url }          start a run
 *   GET  /api/salesnav/runs/:id?companyId=                                       the status view
 *   POST /api/salesnav/runs/:id/resume?companyId=
 *   POST /api/salesnav/runs/:id/cancel?companyId=    (also accepted under extension auth - extensionRoutes.ts)
 *
 * The TENANT and the USER come from the verified session (requireTenantAccess binds the caller to companyId), never
 * from a body. Every error body is { error: <CODE>, ... } from closed sets. A store read that did not answer is 503,
 * never "not found" / "not bound" / "not acked". The member id and the vendor cursor are never returned.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTenantAccess } from '../../security/TenantGuard';
import { SALESNAV_TRANSPORTS, type SalesNavTransport } from '../../services/salesNav/contract';
import { salesNavRouteGate } from '../../services/salesNav/gate';
import { activeExtensionBinding, storeDepsFor, type ExtensionMemberBindingPort } from '../../services/salesNav/memberBinding';
import {
  ackCoversCurrentText, readLatestSalesNavAck, recordSalesNavAck, SALESNAV_RESTRICTION_ACK, SalesNavAckRefused,
} from '../../services/salesNav/restrictionAck';
import {
  closeSalesNavRun, loadRun, resumeSalesNavRun, startSalesNavRun, toRunStatusView, type SalesNavStoreDeps,
} from '../../services/salesNav/store';

export interface SalesNavUiDeps {
  readonly requireTenant?: typeof requireTenantAccess;
  readonly gate?: typeof salesNavRouteGate;
  readonly readAck?: typeof readLatestSalesNavAck;
  readonly recordAck?: typeof recordSalesNavAck;
  readonly binding?: ExtensionMemberBindingPort;
  readonly store?: SalesNavStoreDeps;
  readonly now?: () => Date;
}

const isTransport = (v: unknown): v is SalesNavTransport =>
  typeof v === 'string' && (SALESNAV_TRANSPORTS as readonly string[]).includes(v);
const q = (req: NextApiRequest, k: string): string | undefined => {
  const v = req.query?.[k];
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
};
const companyIdOf = (req: NextApiRequest) => q(req, 'companyId') ?? q(req, 'company_id');
const body = (req: NextApiRequest): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

function method(req: NextApiRequest, res: NextApiResponse, allowed: 'GET' | 'POST'): boolean {
  if ((req.method ?? 'GET').toUpperCase() === allowed) return true;
  res.setHeader('Allow', allowed);
  res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  return false;
}

/** Store deps with EVERY binding question routed through THE extension binding port (memberBinding.ts). */
const routedStore = (deps: SalesNavUiDeps): SalesNavStoreDeps =>
  storeDepsFor(deps.binding ?? activeExtensionBinding, { ...(deps.store ?? {}), ...(deps.now ? { now: deps.now } : {}) });

// -- GET /setup ---------------------------------------------------------------------------------------------------
export async function setupHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavUiDeps = {}) {
  if (!method(req, res, 'GET')) return;
  const companyId = companyIdOf(req);
  const tenant = await (deps.requireTenant ?? requireTenantAccess)(req, res, companyId);
  if (!tenant) return;
  const transport = q(req, 'transport') ?? 'extension';
  if (!isTransport(transport)) return res.status(400).json({ error: 'TRANSPORT_INVALID' });
  const ctx = { organizationId: String(companyId), initiatedBy: tenant.userId };
  const store = routedStore(deps);
  const latest = await (deps.readAck ?? readLatestSalesNavAck)(ctx.organizationId, transport);
  const gate = await (deps.gate ?? salesNavRouteGate)(ctx, transport);
  const member = await store.memberFor!(ctx.organizationId, tenant.userId, transport);
  return res.status(200).json({
    transport,
    ack: {
      version: SALESNAV_RESTRICTION_ACK.version,
      textSha256: SALESNAV_RESTRICTION_ACK.textSha256,
      text: SALESNAV_RESTRICTION_ACK.text,
      status: SALESNAV_RESTRICTION_ACK.status,
    },
    // null = the ledger / binding could not be read: the UI must say so, never show "not acked" / "not bound"
    acked: latest === 'unreadable' ? null : ackCoversCurrentText(latest),
    gate,
    bound: member === 'unreadable' ? null : member !== null,
  });
}

// -- POST /ack ----------------------------------------------------------------------------------------------------
export async function ackHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavUiDeps = {}) {
  if (!method(req, res, 'POST')) return;
  const companyId = companyIdOf(req);
  const tenant = await (deps.requireTenant ?? requireTenantAccess)(req, res, companyId);
  if (!tenant) return;
  const b = body(req);
  if (!isTransport(b.transport)) return res.status(400).json({ error: 'TRANSPORT_INVALID' });
  if (typeof b.shownVersion !== 'string' || typeof b.shownTextSha256 !== 'string') {
    return res.status(400).json({ error: 'SHOWN_TEXT_REQUIRED' });
  }
  try {
    const out = await (deps.recordAck ?? recordSalesNavAck)(
      { organizationId: String(companyId), initiatedBy: tenant.userId },
      { transport: b.transport, shownVersion: b.shownVersion, shownTextSha256: b.shownTextSha256 },
    );
    return res.status(200).json(out);
  } catch (e) {
    if (e instanceof SalesNavAckRefused) {
      if (e.code === 'stale_text') return res.status(409).json({ error: 'ACK_TEXT_STALE' });
      if (e.code === 'no_user') return res.status(401).json({ error: 'NO_USER' });
      return res.status(503).json({ error: 'ACK_WRITE_FAILED' });
    }
    return res.status(503).json({ error: 'ACK_WRITE_FAILED' });
  }
}

// -- POST /runs ---------------------------------------------------------------------------------------------------
export async function startRunHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavUiDeps = {}) {
  if (!method(req, res, 'POST')) return;
  const companyId = companyIdOf(req);
  const tenant = await (deps.requireTenant ?? requireTenantAccess)(req, res, companyId);
  if (!tenant) return;
  const b = body(req);
  if (!isTransport(b.transport)) return res.status(400).json({ error: 'TRANSPORT_INVALID' });
  const ctx = { organizationId: String(companyId), initiatedBy: tenant.userId };
  // THE gate first: nothing about the list is even parsed for a closed route
  const gate = await (deps.gate ?? salesNavRouteGate)(ctx, b.transport);
  if (!gate.allowed) return res.status(403).json({ error: 'GATE_CLOSED', reason: gate.reason });
  const started = await startSalesNavRun(ctx, { transport: b.transport, url: b.url }, routedStore(deps));
  if ('runId' in started) {
    return res.status(201).json({ runId: started.runId, kind: started.kind, canonicalUrl: started.canonicalUrl });
  }
  switch (started.refused) {
    case 'member_unresolved': return res.status(409).json({ error: 'MEMBER_UNRESOLVED' });
    case 'run_already_open': return res.status(409).json({ error: 'RUN_ALREADY_OPEN' });
    case 'store_unreadable': return res.status(503).json({ error: 'STORE_UNREADABLE' });
    case 'gate_closed': return res.status(403).json({ error: 'GATE_CLOSED', reason: 'gate_closed' });
    default: return res.status(422).json({ error: 'URL_REFUSED', refused: started.refused });
  }
}

// -- GET /runs/:id --------------------------------------------------------------------------------------------------
export async function runStatusHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavUiDeps = {}) {
  if (!method(req, res, 'GET')) return;
  const companyId = companyIdOf(req);
  const tenant = await (deps.requireTenant ?? requireTenantAccess)(req, res, companyId);
  if (!tenant) return;
  const runId = q(req, 'id');
  if (!runId) return res.status(400).json({ error: 'RUN_ID_REQUIRED' });
  const run = await loadRun(String(companyId), runId, routedStore(deps));
  if (run === 'unreadable') return res.status(503).json({ error: 'STORE_UNREADABLE' });
  if (!run) return res.status(404).json({ error: 'RUN_NOT_FOUND' });
  return res.status(200).json(toRunStatusView(run, (deps.now ?? (() => new Date()))()));
}

// -- POST /runs/:id/resume ------------------------------------------------------------------------------------------
export async function resumeRunHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavUiDeps = {}) {
  if (!method(req, res, 'POST')) return;
  const companyId = companyIdOf(req);
  const tenant = await (deps.requireTenant ?? requireTenantAccess)(req, res, companyId);
  if (!tenant) return;
  const runId = q(req, 'id');
  if (!runId) return res.status(400).json({ error: 'RUN_ID_REQUIRED' });
  const out = await resumeSalesNavRun({ organizationId: String(companyId), initiatedBy: tenant.userId }, { runId }, routedStore(deps));
  // `in`, not a boolean test: tsconfig.json:11 is "strict": false (repo-wide), so a boolean-literal discriminant does NOT narrow a union here - do not 'simplify' back
  if (!('reason' in out)) return res.status(200).json(out);
  if (out.reason === 'store_unreadable' || out.reason === 'unreadable') return res.status(503).json({ error: 'STORE_UNREADABLE' });
  if (out.reason === 'run_not_found') return res.status(404).json({ error: 'RUN_NOT_FOUND' });
  return res.status(409).json({ error: 'RUN_NOT_RESUMABLE', reason: out.reason });
}

// -- POST /runs/:id/cancel (session half; the extension half is in extensionRoutes.ts) ------------------------------
export async function cancelRunCore(
  org: string, userId: string | null, runId: string | undefined, res: NextApiResponse, store: SalesNavStoreDeps = {},
) {
  if (!runId) return res.status(400).json({ error: 'RUN_ID_REQUIRED' });
  const run = await loadRun(org, runId, store);
  if (run === 'unreadable') return res.status(503).json({ error: 'STORE_UNREADABLE' });
  if (!run) return res.status(404).json({ error: 'RUN_NOT_FOUND' });
  const r = await closeSalesNavRun({ organizationId: org, initiatedBy: userId }, { runId, status: 'cancelled', code: 'user_cancelled' }, store);
  if (r === 'ok') return res.status(200).json({ cancelled: true });
  if (r === 'unreadable') return res.status(503).json({ error: 'STORE_UNREADABLE' });
  return res.status(409).json({ error: 'RUN_NOT_OPEN' });
}

export async function cancelRunSessionHandler(req: NextApiRequest, res: NextApiResponse, deps: SalesNavUiDeps = {}) {
  if (!method(req, res, 'POST')) return;
  const companyId = companyIdOf(req);
  const tenant = await (deps.requireTenant ?? requireTenantAccess)(req, res, companyId);
  if (!tenant) return;
  return cancelRunCore(String(companyId), tenant.userId, q(req, 'id'), res, routedStore(deps));
}
