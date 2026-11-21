/**
 * Sales Navigator - the web app's client for the browser-session routes (route contract v0.3, group A).
 *
 * The web page is where a person ACCEPTS the LinkedIn-restriction text and STARTS a run (a9 / owner: "paste a Sales
 * Navigator list/search URL in Omnivyra, Extract, the extension navigates"). The extension never calls these: it finds
 * the started run via /runs/open. The ack is a human's acceptance, so it is only ever recorded from this browser
 * session, never from an extension-signed request.
 *
 * Thin apiFetch wrappers, no state, following components/prospects/import/importClient.ts.
 */
import { apiFetch } from '@/lib/apiFetch';

export class SalesNavApiError extends Error {
  constructor(message: string, readonly code: string | null, readonly status: number, readonly detail: Record<string, unknown>) {
    super(message);
    this.name = 'SalesNavApiError';
  }
}

async function readError(res: Response): Promise<SalesNavApiError> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const code = typeof body.error === 'string' ? body.error : null;
  return new SalesNavApiError(code ?? `The request failed (HTTP ${res.status}).`, code, res.status, body);
}

const q = (companyId: string, extra: Record<string, string> = {}) =>
  `?${new URLSearchParams({ companyId, ...extra }).toString()}`;

export interface SalesNavSetup {
  transport: string;
  ack: { version: string; textSha256: string; text: string; status: string };
  /** null = the acknowledgement ledger could not be read (never "not accepted"). */
  acked: boolean | null;
  gate: { allowed: boolean; reason: string };
  /** null = the binding could not be read (never "not connected"). */
  bound: boolean | null;
}

export interface SalesNavRunView {
  runId: string; transport: string; urlKind: string; status: string; code: string | null;
  pagesRead: number; leadsRead: number; listTotal: number | null; added: number; updated: number;
  heldForReview: number; skippedAlreadyHave: number; dropped: number; notReadOverCap: number;
  retryAfterAt: string | null; startedAt: string; closedAt: string | null;
}

export async function getSalesNavSetup(companyId: string, transport = 'extension'): Promise<SalesNavSetup> {
  const res = await apiFetch(`/api/salesnav/setup${q(companyId, { transport })}`);
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function acceptSalesNavRestriction(companyId: string, shown: { version: string; textSha256: string }): Promise<void> {
  const res = await apiFetch(`/api/salesnav/ack${q(companyId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transport: 'extension', shownVersion: shown.version, shownTextSha256: shown.textSha256 }),
  });
  if (!res.ok) throw await readError(res);
}

export async function startSalesNavRun(companyId: string, url: string): Promise<{ runId: string; kind: string; canonicalUrl: string }> {
  const res = await apiFetch(`/api/salesnav/runs${q(companyId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transport: 'extension', url }),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function getSalesNavRun(companyId: string, runId: string): Promise<SalesNavRunView> {
  const res = await apiFetch(`/api/salesnav/runs/${encodeURIComponent(runId)}${q(companyId)}`);
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function cancelSalesNavRun(companyId: string, runId: string): Promise<void> {
  const res = await apiFetch(`/api/salesnav/runs/${encodeURIComponent(runId)}/cancel${q(companyId)}`, { method: 'POST' });
  if (!res.ok) throw await readError(res);
}

export async function resumeSalesNavRun(companyId: string, runId: string): Promise<void> {
  const res = await apiFetch(`/api/salesnav/runs/${encodeURIComponent(runId)}/resume${q(companyId)}`, { method: 'POST' });
  if (!res.ok) throw await readError(res);
}
