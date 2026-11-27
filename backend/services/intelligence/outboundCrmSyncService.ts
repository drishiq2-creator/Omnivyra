/**
 * Outbound CRM sync — TENANT-OWNED DESTINATIONS ONLY, FAIL-CLOSED, APPEND-ONLY.
 *
 * Round 12 (Agent A) remediation. What this service does today:
 *   - webhook_only: POSTs `{leadId, event, payload}` to the tenant's OWN
 *     `lead_webhook` integration (company_integrations, read with a
 *     company_id filter), HMAC-signed with that integration's secret, through
 *     the SSRF-safe fetcher with redirects REFUSED (maxRedirects: 0).
 *   - hubspot / salesforce / zoho: REFUSED, no network call. There is no
 *     tenant-owned credential source for native CRM apps (no OAuth connect
 *     flow, no crm_* integration type — see crmActivationService header). The
 *     former platform-env path (HUBSPOT_CRM_ACCESS_TOKEN, SALESFORCE_*,
 *     ZOHO_CRM_ACCESS_TOKEN) is REMOVED: a platform token would push every
 *     tenant's leads into one shared account, and a caller-chosen instance URL
 *     could have received it. Caller-supplied credentials are refused too.
 *
 * Idempotency (ledger = append-only `audit_events`, resource_type
 * 'crm_outbound_sync_event', resource_id = dedupe key):
 *   - key = sha256 over a canonical deep-sorted serialization of
 *     {tenant, provider, destination identity, leadId, event, payload}.
 *   - an attempt writes a `dispatching` claim, re-reads the ledger, and only
 *     sends when its claim is visible and no other attempt is unresolved.
 *   - `synced` (2xx) marks the key done; a definitive failure (nothing sent,
 *     or a received non-2xx) leaves it retryable; a possibly-sent attempt with
 *     no response is recorded `unknown` and BLOCKS automatic resend.
 *   - audit_events has no unique constraint usable as an atomic claim, so
 *     cross-instance exactly-once is not guaranteed by the database; see
 *     claimAndSend() for the code-only protocol and its limits.
 *
 * Drift / repair: nothing is mutated locally on failure.
 */
import crypto from 'crypto';
import { ownedDbTable } from '../../db/writeOwner';
import { recordComplianceAudit, type ComplianceActor } from '../audit/complianceAuditService';
import { getIntegrations } from '../integrationService';

export type OutboundCrmProvider = 'hubspot' | 'salesforce' | 'zoho' | 'webhook_only';
export type OutboundCrmEvent = 'create' | 'update' | 'stage_change' | 'closed_won';

const PROVIDERS: readonly OutboundCrmProvider[] = ['hubspot', 'salesforce', 'zoho', 'webhook_only'];
/** Native CRM apps: no tenant-owned credential source exists in code today. */
const NATIVE_PROVIDERS: readonly OutboundCrmProvider[] = ['hubspot', 'salesforce', 'zoho'];

export interface OutboundSyncInput {
  companyId: string;
  provider: OutboundCrmProvider;
  leadId: string;
  event: OutboundCrmEvent;
  payload: Record<string, unknown>;
  /** The authenticated principal that requested the push (recorded in audit). */
  actor?: { userId: string | null } | null;
}

export type OutboundSyncStatus =
  | 'synced'          // destination answered 2xx
  | 'deduped'         // this exact operation was already confirmed synced
  | 'not_configured'  // the tenant has no destination for this provider
  | 'refused'         // the request cannot be served safely (fail-closed); nothing sent
  | 'failed'          // definitive failure: nothing sent, or a non-2xx was received
  | 'unknown';        // may have been sent, no response; automatic resend is blocked

export interface OutboundSyncResult {
  status: OutboundSyncStatus;
  providerStatus?: number;
  detail: string;
  dedupeKey: string;
  correlationId?: string;
  /** true only when repeating the same request may legitimately send again. */
  retryable?: boolean;
}

const RESOURCE_TYPE = 'crm_outbound_sync_event';
const KEY_PREFIX = 'crm_outbound:v2:';
const UNKEYABLE = `${KEY_PREFIX}unkeyable`;
const SEND_TIMEOUT_MS = 10_000;
const SEND_MAX_BYTES = 5 * 1024 * 1024;
const LEDGER_READ_LIMIT = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Canonical serialization + key ───────────────────────────────────────────

/**
 * Deterministic JSON: object keys sorted at EVERY depth, arrays keep order.
 * The input is first normalised through a JSON round-trip so the key is a
 * function of exactly the data that goes on the wire (undefined dropped,
 * Dates → strings, cycles throw).
 */
export function stableStringify(value: unknown): string {
  const wire = JSON.stringify(value);
  if (wire === undefined) throw new Error('value is not JSON-serialisable');
  return canonical(JSON.parse(wire), 0);
}

function canonical(v: unknown, depth: number): string {
  if (depth > 100) throw new Error('value nesting too deep');
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x, depth + 1)).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k], depth + 1)}`).join(',')}}`;
}

export interface DestinationIdentity {
  /** company_integrations.id of the tenant's lead_webhook row. */
  integrationId: string | null;
  /** sha256 of the normalised destination URL (the URL itself is never stored). */
  urlSha256: string | null;
}

export function makeDedupeKey(parts: {
  companyId: string;
  provider: OutboundCrmProvider;
  destination: DestinationIdentity;
  leadId: string;
  event: string;
  payload: Record<string, unknown>;
}): string {
  const material = stableStringify({
    v: 2,
    tenant: parts.companyId,
    provider: parts.provider,
    destination: { integrationId: parts.destination.integrationId, urlSha256: parts.destination.urlSha256 },
    leadId: parts.leadId,
    event: parts.event,
    payload: parts.payload,
  });
  return KEY_PREFIX + crypto.createHash('sha256').update(material).digest('hex');
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function normaliseTenant(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const t = id.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

// ─── Destination resolution (tenant-owned lead_webhook only) ─────────────────

export type WebhookDestination =
  | { kind: 'ready'; integrationId: string; url: string; secret: string | null; identity: DestinationIdentity }
  | { kind: 'not_configured'; detail: string }
  | { kind: 'refused'; detail: string }
  | { kind: 'lookup_failed'; detail: string };

/**
 * Resolve the tenant's own webhook. Fails closed unless EXACTLY ONE connected
 * lead_webhook row exists, it belongs to `companyId`, and its URL is https
 * without embedded credentials. (getActiveIntegration silently picks the
 * newest of several rows; ambiguity is refused here instead.)
 */
export async function resolveWebhookDestination(companyId: string): Promise<WebhookDestination> {
  let rows: Array<{ id?: unknown; company_id?: unknown; status?: unknown; config?: Record<string, unknown> | null }>;
  try {
    rows = (await getIntegrations(companyId, 'lead_webhook')) as typeof rows;
  } catch {
    return { kind: 'lookup_failed', detail: 'destination lookup failed; nothing was sent' };
  }
  if (!Array.isArray(rows)) return { kind: 'lookup_failed', detail: 'destination lookup returned no list; nothing was sent' };
  if (rows.some((r) => normaliseTenant(r?.company_id) !== companyId)) {
    return { kind: 'refused', detail: 'destination ownership could not be established (company mismatch)' };
  }
  const connected = rows.filter((r) => r?.status === 'connected');
  if (connected.length === 0) return { kind: 'not_configured', detail: 'no connected lead_webhook integration for this company' };
  if (connected.length > 1) {
    return { kind: 'refused', detail: `ambiguous destination: ${connected.length} connected lead_webhook integrations` };
  }
  const row = connected[0];
  const integrationId = typeof row.id === 'string' && row.id.length > 0 ? row.id : null;
  if (!integrationId) return { kind: 'refused', detail: 'destination has no integration id' };
  const rawUrl = row.config?.webhook_url;
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { kind: 'not_configured', detail: 'lead_webhook integration has no webhook_url' };
  }
  let parsed: URL;
  try { parsed = new URL(rawUrl.trim()); } catch {
    return { kind: 'refused', detail: 'lead_webhook webhook_url is not a valid URL' };
  }
  if (parsed.protocol !== 'https:') return { kind: 'refused', detail: 'lead_webhook webhook_url must be https' };
  if (parsed.username || parsed.password) return { kind: 'refused', detail: 'lead_webhook webhook_url must not embed credentials' };
  const url = parsed.href;
  const rawSecret = row.config?.secret;
  const secret = typeof rawSecret === 'string' && rawSecret.length > 0 ? rawSecret : null;
  return { kind: 'ready', integrationId, url, secret, identity: { integrationId, urlSha256: sha256(url) } };
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

interface LedgerRow { attemptId: string | null; outcome: string }

/** A ledger read either answers (rows, possibly none) or is explicitly unavailable; never conflate the two. */
type LedgerRead = { rows: LedgerRow[] } | { unavailable: true };

const TERMINAL = new Set(['synced', 'failed', 'unknown', 'aborted']);

async function readLedger(companyId: string, key: string): Promise<LedgerRead> {
  try {
    const { data, error } = await ownedDbTable('audit_events')
      .select('id, metadata, created_at')
      .eq('company_id', companyId)
      .eq('resource_type', RESOURCE_TYPE)
      .eq('resource_id', key)
      .limit(LEDGER_READ_LIMIT);
    // A null error is not an answer: a blank/odd response must not read as "empty".
    if (error || !Array.isArray(data)) return { unavailable: true };
    return {
      rows: (data as Array<{ metadata?: Record<string, unknown> | null }>).map((r) => ({
        attemptId: typeof r.metadata?.attemptId === 'string' ? (r.metadata.attemptId as string) : null,
        outcome: String(r.metadata?.outcome ?? ''),
      })),
    };
  } catch {
    return { unavailable: true };
  }
}

interface LedgerState { synced: boolean; unknown: boolean; unresolvedAttempts: Set<string> }

function evaluate(rows: LedgerRow[]): LedgerState {
  const dispatching = new Set<string>();
  const resolved = new Set<string>();
  let synced = false, unknown = false;
  for (const r of rows) {
    if (r.outcome === 'synced') synced = true;
    if (r.outcome === 'unknown') unknown = true;
    if (!r.attemptId) continue;
    if (r.outcome === 'dispatching') dispatching.add(r.attemptId);
    else if (TERMINAL.has(r.outcome)) resolved.add(r.attemptId);
  }
  const unresolvedAttempts = new Set([...dispatching].filter((a) => !resolved.has(a)));
  return { synced, unknown, unresolvedAttempts };
}

function auditActor(input: OutboundSyncInput): ComplianceActor {
  const id = input.actor?.userId;
  if (typeof id === 'string' && UUID_RE.test(id)) return { userId: id, type: 'user', label: 'crm-outbound-sync' };
  // audit_events.actor_user_id is a UUID column: a non-UUID principal (e.g. the
  // content_architect cookie principal) is kept in the label instead.
  if (typeof id === 'string' && id.length > 0) {
    return { userId: null, type: 'user', label: `crm-outbound-sync:principal:${id.slice(0, 64)}` };
  }
  return { userId: null, type: 'system', label: 'crm-outbound-sync' };
}

async function recordSyncLineage(
  input: OutboundSyncInput,
  companyId: string,
  dedupeKey: string,
  outcome: string,
  extra: { providerStatus?: number | null; attemptId?: string | null; integrationId?: string | null; reason?: string } = {},
): Promise<string | undefined> {
  try {
    const { correlationId } = await recordComplianceAudit({
      companyId,
      actor: auditActor(input),
      action: `crm_outbound_sync.${input.provider}.${input.event}.${outcome}`,
      resourceType: RESOURCE_TYPE,
      resourceId: dedupeKey,
      severity: outcome === 'failed' || outcome === 'unknown' || outcome === 'refused' ? 'warning' : 'info',
      outcome: outcome === 'synced' || outcome === 'dispatching' ? 'success' : 'failure',
      entityLineage: ['company', 'crm_outbound_sync', input.provider, input.event, outcome],
      detail: {
        provider: input.provider,
        leadId: input.leadId,
        event: input.event,
        providerStatus: extra.providerStatus ?? null,
        outcome,
        attemptId: extra.attemptId ?? null,
        integrationId: extra.integrationId ?? null,
        ...(extra.reason ? { reason: extra.reason } : {}),
      },
    });
    return correlationId;
  } catch { return undefined; }
}

// ─── Send-error classification (lost-response rule) ─────────────────────────

/** Errors raised before any request byte could have left the process. */
const PRE_CONNECT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * 'pre_send': the request certainly did not reach the destination (SSRF/DNS
 * validation, open circuit, TCP connect failure). 'post_dispatch': it may have
 * been delivered (timeout after connect, reset, a refused redirect or an
 * oversized response that safeFetch throws on). Unknown shapes are
 * post_dispatch: a lost send claims nothing.
 */
export function classifySendError(err: unknown): 'pre_send' | 'post_dispatch' {
  const e = err as { name?: string; reason?: string; code?: string; cause?: { code?: string } } | null;
  if (e?.name === 'CircuitBreakerOpenError') return 'pre_send';
  if (e?.name === 'SsrfBlockedError') {
    return e.reason === 'too_many_redirects' || e.reason === 'response_too_large' ? 'post_dispatch' : 'pre_send';
  }
  const code = e?.cause?.code ?? e?.code;
  if (typeof code === 'string' && PRE_CONNECT_CODES.has(code)) return 'pre_send';
  return 'post_dispatch';
}

function hmac(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** In-process single-flight: one attempt per dedupe key per instance. */
const inFlight = new Map<string, Promise<OutboundSyncResult>>();

export async function syncToCrm(input: OutboundSyncInput): Promise<OutboundSyncResult> {
  const companyId = normaliseTenant(input?.companyId);
  const refuse = async (detail: string, key = UNKEYABLE): Promise<OutboundSyncResult> => {
    if (companyId) await recordSyncLineage(input, companyId, key, 'refused', { reason: detail });
    return { status: 'refused', detail, dedupeKey: key, retryable: false };
  };
  if (!companyId) return { status: 'refused', detail: 'explicit tenant (companyId) is required', dedupeKey: UNKEYABLE, retryable: false };
  if ((input as unknown as Record<string, unknown>).credentials !== undefined) {
    return refuse('caller-supplied credentials are not accepted; only tenant-owned destinations are used');
  }
  if (!PROVIDERS.includes(input.provider)) return refuse('unsupported provider');
  if (typeof input.leadId !== 'string' || input.leadId.length === 0) return refuse('leadId is required');

  let preKey: string;
  try {
    preKey = makeDedupeKey({ companyId, provider: input.provider, destination: { integrationId: null, urlSha256: null }, leadId: input.leadId, event: input.event, payload: input.payload });
  } catch {
    return refuse('payload is not JSON-serialisable');
  }

  if (NATIVE_PROVIDERS.includes(input.provider)) {
    return refuse(`${input.provider} outbound sync is not available: no tenant-owned ${input.provider} credential exists (native CRM connectors are not implemented); nothing was sent`, preKey);
  }

  // webhook_only — the tenant's own lead_webhook destination.
  const dest = await resolveWebhookDestination(companyId);
  if (dest.kind === 'lookup_failed') {
    return { status: 'failed', detail: dest.detail, dedupeKey: preKey, retryable: true };
  }
  if (dest.kind === 'not_configured') {
    await recordSyncLineage(input, companyId, preKey, 'not_configured', { reason: dest.detail });
    return { status: 'not_configured', detail: dest.detail, dedupeKey: preKey, retryable: false };
  }
  if (dest.kind === 'refused') return refuse(dest.detail, preKey);

  const dedupeKey = makeDedupeKey({ companyId, provider: input.provider, destination: dest.identity, leadId: input.leadId, event: input.event, payload: input.payload });

  const existing = inFlight.get(dedupeKey);
  if (existing) {
    const first = await existing;
    return first.status === 'synced'
      ? { ...first, status: 'deduped', detail: `joined an in-flight attempt that synced (${first.detail})`, retryable: false }
      : { ...first, detail: `joined an in-flight attempt: ${first.detail}` };
  }
  const run = claimAndSend(input, companyId, dedupeKey, dest);
  inFlight.set(dedupeKey, run);
  try { return await run; } finally { inFlight.delete(dedupeKey); }
}

/**
 * Claim protocol on the append-only ledger (no unique constraint exists):
 *   1. read: synced → deduped; unknown / unresolved attempt → unknown (blocked)
 *   2. append `dispatching` with a fresh attemptId
 *   3. re-read: my claim must be visible, and NO other attempt unresolved —
 *      otherwise abort (append `aborted`, nothing sent)
 *   4. send once; append exactly one terminal outcome for my attemptId
 * With read-after-write visibility on one primary, two racing attempts cannot
 * BOTH see only themselves, so at most one sends (both may abort). Limits are
 * documented in A-OUTBOUND-CRM-REMEDIATION.md §10/§11.
 */
async function claimAndSend(
  input: OutboundSyncInput,
  companyId: string,
  dedupeKey: string,
  dest: Extract<WebhookDestination, { kind: 'ready' }>,
): Promise<OutboundSyncResult> {
  const base = { dedupeKey };
  const integrationId = dest.integrationId;

  const before = await readLedger(companyId, dedupeKey);
  if ('unavailable' in before) return { ...base, status: 'failed', detail: 'sync ledger unavailable; nothing was sent', retryable: true };
  const s0 = evaluate(before.rows);
  if (s0.synced) return { ...base, status: 'deduped', detail: 'already synced (confirmed 2xx on an earlier attempt)', retryable: false };
  if (s0.unknown || s0.unresolvedAttempts.size > 0) {
    return { ...base, status: 'unknown', detail: 'an earlier attempt may have been delivered and its outcome is unknown; not resending automatically (operator review required)', retryable: false };
  }

  const attemptId = crypto.randomUUID();
  await recordSyncLineage(input, companyId, dedupeKey, 'dispatching', { attemptId, integrationId });
  const after = await readLedger(companyId, dedupeKey);
  const mineVisible = 'rows' in after && after.rows.some((r) => r.attemptId === attemptId && r.outcome === 'dispatching');
  if (!('rows' in after) || !mineVisible) {
    await recordSyncLineage(input, companyId, dedupeKey, 'aborted', { attemptId, integrationId, reason: 'claim_not_confirmed' });
    return { ...base, status: 'failed', detail: 'could not durably record the send claim; nothing was sent', retryable: true };
  }
  const s1 = evaluate(after.rows);
  s1.unresolvedAttempts.delete(attemptId);
  if (s1.synced || s1.unknown || s1.unresolvedAttempts.size > 0) {
    await recordSyncLineage(input, companyId, dedupeKey, 'aborted', { attemptId, integrationId, reason: 'concurrent_attempt' });
    return s1.synced
      ? { ...base, status: 'deduped', detail: 'a concurrent attempt already synced', retryable: false }
      : { ...base, status: 'unknown', detail: 'a concurrent attempt for this operation is in flight; not sending (its outcome decides)', retryable: false };
  }

  const body = JSON.stringify({ leadId: input.leadId, event: input.event, payload: input.payload });
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': dedupeKey };
  if (dest.secret) headers['X-Webhook-Signature'] = hmac(body, dest.secret);

  let res: Response;
  try {
    const { safeFetch } = await import('../../../lib/security/safeFetch');
    // maxRedirects: 0 — never re-send the signed body to a redirect target.
    res = await safeFetch(dest.url, { method: 'POST', headers, body }, { timeoutMs: SEND_TIMEOUT_MS, maxBytes: SEND_MAX_BYTES, maxRedirects: 0 });
  } catch (err) {
    const phase = classifySendError(err);
    if (phase === 'pre_send') {
      const cid = await recordSyncLineage(input, companyId, dedupeKey, 'failed', { attemptId, integrationId, reason: 'pre_send' });
      return { ...base, status: 'failed', detail: 'webhook_only request was not sent (connection/validation failure)', correlationId: cid, retryable: true };
    }
    const cid = await recordSyncLineage(input, companyId, dedupeKey, 'unknown', { attemptId, integrationId, reason: 'no_response' });
    return { ...base, status: 'unknown', detail: 'the request may have been delivered but no usable response arrived; outcome unknown, automatic resend is blocked', correlationId: cid, retryable: false };
  }

  const status = typeof res?.status === 'number' ? res.status : 0;
  try { await (res as { body?: { cancel?: () => Promise<void> } }).body?.cancel?.(); } catch { /* best effort */ }
  if (status >= 200 && status < 300) {
    const cid = await recordSyncLineage(input, companyId, dedupeKey, 'synced', { attemptId, integrationId, providerStatus: status });
    return { ...base, status: 'synced', providerStatus: status, detail: `webhook_only accepted ${status}`, correlationId: cid, retryable: false };
  }
  const cid = await recordSyncLineage(input, companyId, dedupeKey, 'failed', { attemptId, integrationId, providerStatus: status });
  return { ...base, status: 'failed', providerStatus: status, detail: `webhook_only returned ${status}`, correlationId: cid, retryable: true };
}

// ─── Report (GET) ────────────────────────────────────────────────────────────

export interface OutboundCrmReport {
  companyId: string;
  generatedAt: string;
  windowDays: number;
  totalEvents: number;
  syncedEvents: number;
  failedEvents: number;
  unknownEvents: number;
  byProvider: Array<{ provider: string; synced: number; failed: number; notConfigured: number; unknown: number }>;
  /** Tenant-owned capability only. Native providers are always false (no tenant credential source). */
  capabilityFlags: { hubspot: boolean; salesforce: boolean; zoho: boolean; webhook_only: boolean };
  /** Why webhook_only is or is not usable; 'lookup_failed' is NOT the same as absent. */
  webhookDestination: WebhookDestination['kind'];
  /** false when the audit ledger could not be read (counts are then not meaningful). */
  ledgerAvailable: boolean;
  capabilityNote: string;
}

const REPORT_WINDOW_DAYS = 30;

export async function buildOutboundCrmReport(rawCompanyId: string): Promise<OutboundCrmReport> {
  const companyId = normaliseTenant(rawCompanyId) ?? '';
  const sinceIso = new Date(Date.now() - REPORT_WINDOW_DAYS * 86_400_000).toISOString();
  const byProvider = new Map<string, { synced: number; failed: number; notConfigured: number; unknown: number }>();
  let total = 0, synced = 0, failed = 0, unknown = 0;
  let ledgerAvailable = false;
  try {
    const { data, error } = await ownedDbTable('audit_events')
      .select('action, metadata, created_at')
      .eq('company_id', companyId)
      .eq('resource_type', RESOURCE_TYPE)
      .gte('created_at', sinceIso)
      .limit(10_000);
    if (!error && Array.isArray(data)) {
      ledgerAvailable = true;
      for (const r of (data as any[])) {
        const md = r.metadata ?? {};
        const outcome = String(md.outcome ?? 'unknown');
        // claim / abort rows are protocol bookkeeping, not events
        if (outcome === 'dispatching' || outcome === 'aborted') continue;
        const prov = String(md.provider ?? 'unknown');
        total += 1;
        const agg = byProvider.get(prov) ?? { synced: 0, failed: 0, notConfigured: 0, unknown: 0 };
        if (outcome === 'synced') { agg.synced += 1; synced += 1; }
        else if (outcome === 'failed') { agg.failed += 1; failed += 1; }
        else if (outcome === 'unknown') { agg.unknown += 1; unknown += 1; }
        else if (outcome === 'not_configured') agg.notConfigured += 1;
        byProvider.set(prov, agg);
      }
    }
  } catch { /* ledgerAvailable stays false */ }

  const dest = companyId ? await resolveWebhookDestination(companyId) : ({ kind: 'refused', detail: 'no tenant' } as WebhookDestination);
  return {
    companyId,
    generatedAt: new Date().toISOString(),
    windowDays: REPORT_WINDOW_DAYS,
    totalEvents: total,
    syncedEvents: synced,
    failedEvents: failed,
    unknownEvents: unknown,
    byProvider: Array.from(byProvider.entries()).map(([provider, v]) => ({ provider, ...v })),
    capabilityFlags: { hubspot: false, salesforce: false, zoho: false, webhook_only: dest.kind === 'ready' },
    webhookDestination: dest.kind,
    ledgerAvailable,
    capabilityNote:
      'Outbound CRM sync sends only to the tenant\'s own lead_webhook (https, HMAC-signed, redirects refused). Native HubSpot/Salesforce/Zoho push is unavailable: no tenant-owned credential source exists. Idempotent per tenant+destination+lead+event+payload; a lost response is recorded as unknown and is not resent automatically.',
  };
}
