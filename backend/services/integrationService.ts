import crypto from 'crypto';
import { ownedDbTable } from '../db/writeOwner';
/**
 * Integration Service — company_integrations table
 * Supports: lead_webhook | wordpress | custom_blog_api
 */
import { createWebsiteConnection, resolveWebsiteForCompany } from './websiteService';
import {
  deleteConnectionCredentials,
  mergeConnectionConfig,
  splitSecretConfig,
  upsertConnectionCredentials,
} from './integrationCredentialService';
import { REDACTED_SECRET, isSecretConfigKey, redactIntegrationSecrets, restoreRedactedSecrets } from './integrationSecretRedaction';
import { recordAuditEvent } from './auditEventService';
import { constantTimeEqual } from '../security/constantTimeEqual';
import { getCmsAdapter, isCmsProvider } from './cms/registry';
import { ensureCanonicalConnectionForIntegration } from './cms/cmsConnectionNormalizationService';

export type IntegrationType =
  | 'lead_webhook'
  | 'wordpress'
  | 'custom_blog_api'
  | 'ghost'
  | 'drupal'
  | 'joomla'
  | 'webflow'
  | 'shopify'
  | 'hubspot'
  | 'wix'
  | 'squarespace';
export type IntegrationStatus = 'connected' | 'failed' | 'pending';

/** Connection auth_type per CMS provider (drives website_connections.auth_type). */
const PROVIDER_AUTH_TYPE: Record<string, string> = {
  wordpress: 'basic',
  ghost: 'admin_api_key',
  drupal: 'bearer_token',
  joomla: 'api_token',
  webflow: 'oauth2',
  shopify: 'api_token',
  hubspot: 'oauth2',
  wix: 'api_token',
  squarespace: 'api_token',
  custom_blog_api: 'api_key',
};

export interface Integration {
  id: string;
  company_id: string;
  created_by: string;
  website_id?: string | null;
  website_connection_id?: string | null;
  type: IntegrationType;
  name: string;
  status: IntegrationStatus;
  config: Record<string, string>;
  non_secret_config?: Record<string, string>;
  credential_migration_status?: string | null;
  last_tested_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// Lead payload contract
export interface LeadPayload {
  name: string;
  email: string;
  phone?: string;
  source?: string;
}

// Blog payload contract
export interface BlogPayload {
  title: string;
  content: string;
  author?: string;
}

/** A request the caller can fix (answered 400 by the routes, never 500). */
export class IntegrationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationValidationError';
  }
}

// ─── R26 T-2: WRITE-ONLY SECRETS ─────────────────────────────────────────────

/**
 * The ONLY shape an integration may leave the server in (R26 T-2).
 *
 * A hydrated Integration carries DECRYPTED credentials in `config` (hydrateIntegration -> mergeConnectionConfig).
 * Until round 26 company admins, SUPER_ADMIN and the `content_architect` principal received them on every list load
 * and the edit form echoed them into the DOM. Secrets are now write-only for EVERY role:
 *   - every secret-named key with a value is replaced by REDACTED_SECRET ('********'); an empty one stays empty;
 *   - `secret_fields_set` names the secret keys that hold a value (the "has_secret" indicator), never a value or a
 *     suffix of one;
 *   - an edit that leaves a secret blank, or sends the placeholder back, keeps the stored secret ("replace"
 *     semantics: only a NEW value replaces it; restoreRedactedSecrets + splitSecretConfig).
 * No role, SUPER_ADMIN included, is shown a value. There is no reveal endpoint: whoever set the secret has it, and a
 * forgotten secret is replaced, not recovered.
 */
export type PublicIntegration = Integration & {
  secret_fields_set: string[];
  /** lead_webhook only: signing mode, whether the raw secret is still sent, and the admin deprecation warning. */
  webhook_signing?: LeadWebhookSigningStatus;
  /** lead_webhook only: whether deliveries can go out (https-only rule), with the reason when they cannot. */
  webhook_destination?: { ok: true } | { ok: false; code: string; reason: string };
};

export function toPublicIntegration(integration: Integration): PublicIntegration {
  const secretFieldsSet = new Set<string>();
  for (const map of [integration.config, integration.non_secret_config]) {
    for (const [key, value] of Object.entries(map ?? {})) {
      if (isSecretConfigKey(key) && value !== undefined && value !== null && value !== '') secretFieldsSet.add(key);
    }
  }
  const out: PublicIntegration = { ...redactIntegrationSecrets(integration), secret_fields_set: [...secretFieldsSet].sort() };
  if (integration.type === 'lead_webhook') {
    out.webhook_signing = leadWebhookSigningStatus(integration.config);
    // Integration review M-3: an http:// destination is visible to the admin, not only refused at send time.
    const problem = webhookDestinationProblem(integration.config?.webhook_url);
    out.webhook_destination = problem ? { ok: false, code: WEBHOOK_HTTPS_REQUIRED, reason: problem } : { ok: true };
  }
  return out;
}

// ─── R26 T-3 (final round): SIGNED LEAD WEBHOOKS, ONE SECRET PER DIRECTION ──

/**
 * Per-integration outbound signing mode (owner decision, round 26 final). Non-secret config key `signing_mode`.
 *
 *   mode      headers sent                                                    raw secret leaves Omnivyra?
 *   legacy    X-Omnivyra-Signature + X-Webhook-Signature + X-Webhook-Secret    YES  (pre-R26 receivers keep working)
 *   dual      same as legacy, plus a deprecation warning (logged on every       YES  (the migration window)
 *             send, shown to the admin in the API response and the UI)
 *   signed    X-Omnivyra-Signature + X-Webhook-Signature                       NO
 *
 * - NEW integrations default to 'signed' (createIntegration writes it when the caller sends none).
 * - EXISTING integrations (no key) stay 'legacy' until the tenant migrates them.
 * - LEAD_WEBHOOK_LEGACY_SUNSET (ISO date): from that instant 'legacy' and 'dual' BEHAVE as 'signed'. An unparseable
 *   value is ignored (and warned once), never treated as "already past": a typo must not cut every receiver off.
 *
 * Signatures (both keyed by the lead_webhook `secret`, HMAC-SHA256, lowercase hex):
 *   X-Omnivyra-Signature: t=<unix seconds>,v1=<hex HMAC(secret, "<t>.<raw body>")>   <- RECOMMENDED: verify this one,
 *                                                                                      reject |now - t| > 300 s
 *   X-Webhook-Signature:  <hex HMAC(secret, raw body)>                                <- body-only, the scheme
 *                         outboundCrmSyncService (webhook_only) already sends; kept so one receiver verifies both
 *                         senders during the migration. No replay protection.
 * The receiver recipe is in CT-ROUND26-SIGNED-WEBHOOK-PLAN.md.
 */
export type LeadWebhookSigningMode = 'legacy' | 'dual' | 'signed';
export const LEAD_WEBHOOK_TIMESTAMPED_SIGNATURE_HEADER = 'X-Omnivyra-Signature';
export const LEAD_WEBHOOK_SIGNATURE_HEADER = 'X-Webhook-Signature';
export const LEAD_WEBHOOK_LEGACY_SECRET_HEADER = 'X-Webhook-Secret';
export const LEAD_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;
const LEAD_WEBHOOK_MODES = new Set<LeadWebhookSigningMode>(['legacy', 'dual', 'signed']);

let sunsetWarned = false;
/** The configured sunset instant, or null when unset or unparseable. */
export function leadWebhookLegacySunset(): Date | null {
  const raw = String(process.env.LEAD_WEBHOOK_LEGACY_SUNSET ?? '').trim();
  if (!raw) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    if (!sunsetWarned) {
      sunsetWarned = true;
      console.warn('[lead_webhook] LEAD_WEBHOOK_LEGACY_SUNSET is not a valid ISO date; ignored');
    }
    return null;
  }
  return at;
}

/** What the integration is configured as. A row without the key predates R26 and is 'legacy'. */
export function configuredLeadWebhookMode(config: Record<string, string> | null | undefined): LeadWebhookSigningMode {
  const own = String(config?.signing_mode ?? '').trim().toLowerCase() as LeadWebhookSigningMode;
  return LEAD_WEBHOOK_MODES.has(own) ? own : 'legacy';
}

/** What is actually sent: after the sunset every integration is 'signed'. */
export function effectiveLeadWebhookMode(
  config: Record<string, string> | null | undefined,
  now: Date = new Date(),
): LeadWebhookSigningMode {
  const configured = configuredLeadWebhookMode(config);
  const sunset = leadWebhookLegacySunset();
  if (configured !== 'signed' && sunset && now.getTime() >= sunset.getTime()) return 'signed';
  return configured;
}

export function signLeadWebhookBody(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` */
export function timestampedLeadWebhookSignature(body: string, secret: string, nowSeconds: number): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${nowSeconds}.${body}`).digest('hex');
  return `t=${nowSeconds},v1=${v1}`;
}

/**
 * Reference verifier for the timestamped header (the receiver recipe, and what the tests prove the sender against).
 * Constant-time compare; rejects a missing/garbled header and a timestamp outside the tolerance either way.
 */
export function verifyTimestampedLeadWebhookSignature(
  header: string | null | undefined,
  body: string,
  secret: string,
  nowSeconds: number,
  toleranceSeconds = LEAD_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((kv) => {
    const i = kv.indexOf('=');
    return i < 0 ? [kv.trim(), ''] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
  }));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(parts.v1, 'hex'), Buffer.from(expected, 'hex'));
}

/** The admin-visible state of one lead webhook's signing (API `webhook_signing`, UI warning). */
export interface LeadWebhookSigningStatus {
  configured_mode: LeadWebhookSigningMode;
  effective_mode: LeadWebhookSigningMode;
  raw_secret_sent: boolean;
  legacy_sunset: string | null;
  deprecation_warning: string | null;
}

export function leadWebhookSigningStatus(config: Record<string, string> | null | undefined, now: Date = new Date()): LeadWebhookSigningStatus {
  const configured = configuredLeadWebhookMode(config);
  const effective = effectiveLeadWebhookMode(config, now);
  const sunset = leadWebhookLegacySunset();
  const rawSent = effective !== 'signed';
  return {
    configured_mode: configured,
    effective_mode: effective,
    raw_secret_sent: rawSent,
    legacy_sunset: sunset ? sunset.toISOString() : null,
    deprecation_warning: rawSent
      ? `This webhook still sends its secret in the X-Webhook-Secret header (${configured} mode). Verify X-Omnivyra-Signature in your receiver, then switch to "signed".${sunset ? ` From ${sunset.toISOString()} the raw header stops being sent.` : ''}`
      : null,
  };
}

/** Headers for one outbound lead_webhook delivery of exactly `body`. */
export function buildLeadWebhookHeaders(
  config: Record<string, string>,
  body: string,
  opts: { now?: Date; integrationId?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const secret = config.secret;
  if (!secret || constantTimeEqual(secret, REDACTED_SECRET)) return headers;
  const now = opts.now ?? new Date();
  headers[LEAD_WEBHOOK_TIMESTAMPED_SIGNATURE_HEADER] = timestampedLeadWebhookSignature(body, secret, Math.floor(now.getTime() / 1000));
  headers[LEAD_WEBHOOK_SIGNATURE_HEADER] = signLeadWebhookBody(body, secret);
  const mode = effectiveLeadWebhookMode(config, now);
  if (mode !== 'signed') {
    headers[LEAD_WEBHOOK_LEGACY_SECRET_HEADER] = secret;
    if (mode === 'dual') {
      console.warn('[lead_webhook] DEPRECATED: raw secret header sent (dual mode); migrate the receiver to X-Omnivyra-Signature', {
        integration_id: opts.integrationId ?? null,
      });
    }
  }
  return headers;
}

/**
 * HTTPS-only webhook destinations (owner decision 3). Checked at WRITE time (create/update) and at SEND time.
 * http:// is accepted ONLY for a loopback host (localhost, 127.0.0.1, ::1) AND only when NODE_ENV is 'development'
 * or 'test' — never in production, whatever any flag says. safeFetch (Agent E) enforces the same rule underneath;
 * this is the service-level guard, so a refusal carries a reason code the tenant can act on.
 */
export const WEBHOOK_HTTPS_REQUIRED = 'WEBHOOK_HTTPS_REQUIRED';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function webhookDestinationProblem(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return 'webhook_url is required';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'webhook_url is not a valid URL';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:') {
    const env = String(process.env.NODE_ENV ?? '').trim();
    const devLike = env === 'development' || env === 'test';
    if (devLike && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null;
    return 'webhook_url must use https://';
  }
  return 'webhook_url must use https://';
}

/**
 * A refused lead-webhook delivery (http:// destination), made visible (integration review M-3): a warning log, an
 * audit_events row, and the integration itself marked status 'failed' with last_error carrying the code — the admin
 * sees it in Integrations / Leads. Best effort: recording the refusal must never turn into a delivery.
 */
async function recordLeadWebhookRefusal(integration: Integration, reason: string, phase: 'send' | 'test'): Promise<void> {
  console.warn('[lead_webhook] delivery refused', { integration_id: integration.id, code: WEBHOOK_HTTPS_REQUIRED, reason, phase });
  const lastError = `${WEBHOOK_HTTPS_REQUIRED}: ${reason}. Deliveries are paused until the Webhook URL uses https://.`;
  try {
    if (phase === 'send') {
      await ownedDbTable('company_integrations')
        .update({ status: 'failed', last_error: lastError, updated_at: new Date().toISOString() })
        .eq('id', integration.id)
        .eq('company_id', integration.company_id);
    }
  } catch (err) {
    console.warn('[lead_webhook] could not mark the integration failed', { integration_id: integration.id, message: err instanceof Error ? err.message : String(err) });
  }
  await recordAuditEvent({
    companyId: integration.company_id,
    actorUserId: null,
    actorType: 'system',
    action: 'lead_webhook.delivery_refused',
    resourceType: 'company_integration',
    resourceId: integration.id,
    severity: 'warning',
    metadata: { code: WEBHOOK_HTTPS_REQUIRED, reason, phase },
  });
}

/** Lead-webhook config rules, checked on the config that will be IN FORCE after the write. */
function assertLeadWebhookConfig(type: IntegrationType, config: Record<string, string>): void {
  if (type !== 'lead_webhook') return;
  const mode = String(config.signing_mode ?? '').trim().toLowerCase();
  if (mode && !LEAD_WEBHOOK_MODES.has(mode as LeadWebhookSigningMode)) {
    throw new IntegrationValidationError("signing_mode must be 'legacy', 'dual' or 'signed'");
  }
  const destination = webhookDestinationProblem(config.webhook_url);
  if (destination) {
    throw new IntegrationValidationError(`${destination}. Set an https:// Webhook URL to save this integration.`);
  }
  // One credential must never serve both directions: the outbound recipient would hold inbound write access.
  if (config.inbound_secret && config.secret && constantTimeEqual(config.inbound_secret, config.secret)) {
    throw new IntegrationValidationError('inbound_secret must differ from the outbound secret');
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function createIntegration(
  companyId: string,
  userId: string,
  type: IntegrationType,
  name: string,
  config: Record<string, string>,
  options: { websiteId?: string | null; authType?: string } = {},
): Promise<Integration> {
  const normalizedConfig = normalizeIntegrationConfig(type, config);
  // Owner decision 1: a NEW lead webhook is 'signed' unless the caller explicitly asks for a compatibility mode.
  if (type === 'lead_webhook' && !normalizedConfig.signing_mode) normalizedConfig.signing_mode = 'signed';
  assertLeadWebhookConfig(type, normalizedConfig);
  const { nonSecretConfig, credentials } = splitSecretConfig(normalizedConfig);
  const website = await resolveWebsiteForCompany(companyId, options.websiteId ?? null, userId);
  const connection = await createWebsiteConnection({
    websiteId: website.id,
    provider: type,
    authType: options.authType ?? PROVIDER_AUTH_TYPE[type] ?? 'api_key',
    nonSecretConfig,
    status: 'pending',
  });
  await upsertConnectionCredentials(companyId, connection.id, credentials);

  const { data, error } = await ownedDbTable('company_integrations')
    .insert({
      company_id: companyId,
      created_by: userId,
      website_id: website.id,
      website_connection_id: connection.id,
      type,
      name,
      config: nonSecretConfig,
      non_secret_config: nonSecretConfig,
      credential_migration_status: 'encrypted',
      status: 'pending',
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return hydrateIntegration(data as Integration);
}

export async function updateIntegration(
  id: string,
  companyId: string,
  updates: { name?: string; config?: Record<string, string>; websiteId?: string | null }
): Promise<Integration> {
  const existing = await getIntegration(id, companyId);
  if (!existing) throw new Error('Integration not found');

  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (updates.name) payload.name = updates.name;
  if (updates.websiteId !== undefined) {
    const website = await resolveWebsiteForCompany(companyId, updates.websiteId, existing.created_by);
    payload.website_id = website.id;
    if (existing.website_connection_id) {
      await ownedDbTable('website_connections')
        .update({ website_id: website.id, updated_at: new Date().toISOString() })
        .eq('id', existing.website_connection_id);
    }
  }
  if (updates.config) {
    // A redacted placeholder in the update means "unchanged" (integrationSecretRedaction.ts): keep the stored secret.
    const normalizedConfig = normalizeIntegrationConfig(existing.type, restoreRedactedSecrets(updates.config, existing.config));
    // An edit that does not mention signing_mode keeps the stored one: dropping the key would read as 'legacy' and
    // silently put the raw secret back on the wire.
    if (existing.type === 'lead_webhook' && !normalizedConfig.signing_mode && existing.config?.signing_mode) {
      normalizedConfig.signing_mode = existing.config.signing_mode;
    }
    // Validated against what will be in force after the write: a secret left blank keeps its stored value.
    const effective: Record<string, string> = { ...existing.config };
    for (const [key, value] of Object.entries(normalizedConfig)) {
      if (value !== '' || !isSecretConfigKey(key)) effective[key] = value;
    }
    assertLeadWebhookConfig(existing.type, effective);
    const { nonSecretConfig, credentials } = splitSecretConfig(normalizedConfig);
    if (existing.website_connection_id) {
      await upsertConnectionCredentials(companyId, existing.website_connection_id, credentials);
      await ownedDbTable('website_connections')
        .update({ non_secret_config: nonSecretConfig, updated_at: new Date().toISOString() })
        .eq('id', existing.website_connection_id);
    }
    payload.config = nonSecretConfig;
    payload.non_secret_config = nonSecretConfig;
    payload.credential_migration_status = existing.website_connection_id ? 'encrypted' : 'legacy_missing_connection';
  }

  const { data, error } = await ownedDbTable('company_integrations')
    .update(payload)
    .eq('id', id)
    .eq('company_id', companyId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return hydrateIntegration(data as Integration);
}

function normalizeIntegrationConfig(
  type: IntegrationType,
  config: Record<string, string>,
): Record<string, string> {
  const normalized = Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, String(value ?? '').trim()]),
  ) as Record<string, string>;

  if (isCmsProvider(type) && normalized.site_url) {
    normalized.site_url = normalizeCmsSiteUrl(normalized.site_url);
  }

  return normalized;
}

function normalizeCmsSiteUrl(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return '';

  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    const host = url.hostname.toLowerCase();
    const isDevelopmentHost =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.test');

    if (url.protocol === 'http:' && !isDevelopmentHost) {
      url.protocol = 'https:';
    }
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

/**
 * What a disconnect actually did (R26 T-4). Returned and audited, so "disconnected" is a fact, not an assumption.
 * `provider_revocation` is 'not_supported' for every integration type today: none of the CMS/webhook providers
 * exposes a revoke call we can make with what we store (a WordPress application password, a Ghost admin key, a
 * Shopify token are revoked in the provider's own admin). The tenant is told to rotate there.
 */
export interface DeleteIntegrationResult {
  deleted: boolean;
  credentials_deleted: number;
  connection_retired: boolean;
  provider_revocation: 'not_supported';
}

/**
 * R26 T-4: disconnect = the stored credentials are GONE, then the row.
 *
 * Order matters. Credentials are deleted first (tenant-proven, deleteConnectionCredentials), then the website
 * connection is retired (status 'deleted', legacy encrypted_credentials blanked), then the integration row is
 * removed. A failure at any step throws BEFORE the row is deleted, so the tenant still sees the integration and can
 * retry; the old code deleted only the row and left a decryptable credential with nothing pointing at it in the UI.
 *
 * A connection that another integration of the company still references keeps its credentials (they are that
 * integration's too); the audit row says so.
 */
export async function deleteIntegration(
  id: string,
  companyId: string,
  opts: { actorUserId?: string | null } = {},
): Promise<DeleteIntegrationResult> {
  const { data: row, error: readError } = await ownedDbTable('company_integrations')
    .select('id, type, website_connection_id')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!row) return { deleted: false, credentials_deleted: 0, connection_retired: false, provider_revocation: 'not_supported' };

  const connectionId = (row as { website_connection_id?: string | null }).website_connection_id ?? null;
  let credentialsDeleted = 0;
  let connectionRetired = false;
  let sharedConnection = false;

  if (connectionId) {
    const { data: others, error: othersError } = await ownedDbTable('company_integrations')
      .select('id')
      .eq('company_id', companyId)
      .eq('website_connection_id', connectionId)
      .neq('id', id)
      .limit(1);
    if (othersError) throw new Error(othersError.message);
    sharedConnection = ((others as unknown[] | null) ?? []).length > 0;

    if (!sharedConnection) {
      credentialsDeleted = await deleteConnectionCredentials(companyId, connectionId);
      const now = new Date().toISOString();
      const { error: retireError } = await ownedDbTable('website_connections')
        .update({ status: 'deleted', deleted_at: now, encrypted_credentials: {}, updated_at: now })
        .eq('id', connectionId);
      if (retireError) throw new Error(retireError.message);
      connectionRetired = true;
    }
  }

  const { error } = await ownedDbTable('company_integrations')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId);
  if (error) throw new Error(error.message);

  const result: DeleteIntegrationResult = {
    deleted: true,
    credentials_deleted: credentialsDeleted,
    connection_retired: connectionRetired,
    provider_revocation: 'not_supported',
  };
  await recordAuditEvent({
    companyId,
    actorUserId: opts.actorUserId ?? null,
    actorType: opts.actorUserId ? 'user' : 'system',
    action: 'tenant_credential.integration_disconnected',
    resourceType: 'company_integration',
    resourceId: id,
    severity: 'info',
    metadata: {
      integration_type: (row as { type?: string }).type ?? null,
      connection_id: connectionId,
      shared_connection_credentials_retained: sharedConnection,
      ...result,
    },
  });
  return result;
}

export async function getIntegration(id: string, companyId: string): Promise<Integration | null> {
  const { data, error } = await ownedDbTable('company_integrations')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single();
  if (error) return null;
  return hydrateIntegration(data as Integration);
}

export async function getIntegrations(companyId: string, type?: IntegrationType): Promise<Integration[]> {
  let query = ownedDbTable('company_integrations')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });
  if (type) query = query.eq('type', type);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return Promise.all(((data || []) as Integration[]).map(hydrateIntegration));
}

// Reusable by other modules: get first active integration of a type
export async function getActiveIntegration(
  companyId: string,
  type: IntegrationType
): Promise<Integration | null> {
  const { data, error } = await ownedDbTable('company_integrations')
    .select('*')
    .eq('company_id', companyId)
    .eq('type', type)
    .eq('status', 'connected')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error) return null;
  return hydrateIntegration(data as Integration);
}

async function hydrateIntegration(row: Integration): Promise<Integration> {
  const nonSecretConfig = (row.non_secret_config ?? row.config ?? {}) as Record<string, string>;
  const config = await mergeConnectionConfig(row.company_id, row.website_connection_id, nonSecretConfig, row.config);
  return {
    ...row,
    non_secret_config: nonSecretConfig,
    config,
  };
}

// ─── TEST CONNECTION ─────────────────────────────────────────────────────────

export interface TestResult {
  success: boolean;
  message: string;
  /** Machine-readable failure code (e.g. WordPress HTTPS_REQUIRED). */
  code?: string;
  /** Structured WordPress environment / REST / auth diagnostics, when available. */
  diagnostics?: unknown;
}

export async function validateIntegration(
  id: string,
  companyId: string,
  opts: { rediscover?: boolean } = {},
): Promise<TestResult> {
  const integration = await getIntegration(id, companyId);
  if (!integration) return { success: false, message: 'Integration not found.' };
  const normalizedConfig = normalizeIntegrationConfig(integration.type, integration.config);
  if (JSON.stringify(normalizedConfig) !== JSON.stringify(integration.config)) {
    integration.config = normalizedConfig;
    const { nonSecretConfig } = splitSecretConfig(normalizedConfig);
    await ownedDbTable('company_integrations')
      .update({
        config: nonSecretConfig,
        non_secret_config: nonSecretConfig,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('company_id', companyId);
    if (integration.website_connection_id) {
      await ownedDbTable('website_connections')
        .update({ non_secret_config: nonSecretConfig, updated_at: new Date().toISOString() })
        .eq('id', integration.website_connection_id);
    }
  }

  // Enforcement: no CMS operation runs without a canonical connection.
  if (isCmsProvider(integration.type) && !integration.website_connection_id) {
    const connId = await ensureCanonicalConnectionForIntegration(integration).catch(() => null);
    if (connId) integration.website_connection_id = connId;
  }

  let result: TestResult;
  try {
    result = await testConnection(integration, opts);
  } catch (err) {
    result = { success: false, message: err instanceof Error ? err.message : 'Unknown error' };
  }

  // Persist result
  await ownedDbTable('company_integrations')
    .update({
      status: result.success ? 'connected' : 'failed',
      last_tested_at: new Date().toISOString(),
      last_error: result.success ? null : result.message,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('company_id', companyId);

  return result;
}

async function testConnection(
  integration: Integration,
  opts: { rediscover?: boolean } = {},
): Promise<TestResult> {
  const { type, config } = integration;
  const timeout = 10_000;

  if (type === 'lead_webhook') {
    if (!config.webhook_url) return { success: false, message: 'webhook_url is required.' };
    const destinationProblem = webhookDestinationProblem(config.webhook_url);
    if (destinationProblem) {
      // validateIntegration persists status 'failed' + last_error from this result; the refusal is also audited.
      await recordLeadWebhookRefusal(integration, destinationProblem, 'test');
      return { success: false, message: `${WEBHOOK_HTTPS_REQUIRED}: ${destinationProblem}. Edit the integration and set an https:// Webhook URL.`, code: WEBHOOK_HTTPS_REQUIRED };
    }
    const testPayload: LeadPayload = { name: 'Test Lead', email: 'test@example.com', source: 'integration_test' };
    const body = JSON.stringify(testPayload);
    // R26 T-3: signed; the raw secret rides along only in 'legacy'/'dual' mode before the sunset.
    const res = await fetchWithTimeout(config.webhook_url, {
      method: 'POST',
      headers: buildLeadWebhookHeaders(config, body, { integrationId: integration.id }),
      body,
    }, timeout);
    if (res.ok || res.status === 200 || res.status === 201 || res.status === 204) {
      return { success: true, message: `Webhook responded with ${res.status}.` };
    }
    return { success: false, message: `Webhook returned status ${res.status}.` };
  }

  if (type === 'wordpress' || isCmsProvider(type)) {
    const health = await getCmsAdapter(type).validateConnection({
      provider: type,
      companyId: integration.company_id,
      connectionId: integration.website_connection_id,
      websiteId: integration.website_id,
      config,
      timeoutMs: timeout,
      forceApiRediscovery: opts.rediscover === true,
    });
    return {
      success: health.healthy,
      message: health.message,
      code: health.code,
      diagnostics: health.diagnostics,
    };
  }

  return { success: false, message: `Unknown integration type: ${type}` };
}

async function fetchWithTimeout(url: string, options: RequestInit, ms: number): Promise<Response> {
  // HARDEN-005A: used for WordPress/custom-blog publish where the base URL is
  // customer-configured — route through the SSRF-safe fetcher. allowHttp for
  // self-hosted sites; private-IP checks still block internal targets.
  const { safeFetch } = await import('../../lib/security/safeFetch');
  return safeFetch(url, options, { allowHttp: true, timeoutMs: ms, maxBytes: 10 * 1024 * 1024 });
}

// ─── REUSABLE SENDERS ────────────────────────────────────────────────────────

/** Send a lead to the configured lead_webhook integration */
export async function sendLead(companyId: string, payload: LeadPayload): Promise<void> {
  const integration = await getActiveIntegration(companyId, 'lead_webhook');
  if (!integration) return;
  // Owner decision 3: HTTPS-only at SEND time too (a row stored before the write-time check may still say http://).
  const destinationProblem = webhookDestinationProblem(integration.config.webhook_url);
  if (destinationProblem) {
    // Integration review M-3: never silent. The refusal is logged, audited, and put ON the integration (status
    // 'failed' + last_error with the code), so the admin sees it in Integrations and Leads until the URL is fixed.
    await recordLeadWebhookRefusal(integration, destinationProblem, 'send');
    return;
  }
  const body = JSON.stringify(payload);
  // R26 T-3: signed; the raw secret rides along only in 'legacy'/'dual' mode before the sunset (buildLeadWebhookHeaders).
  const headers = buildLeadWebhookHeaders(integration.config, body, { integrationId: integration.id });
  // HARDEN-005: webhook_url is customer-configured — deliver via the SSRF-safe
  // fetcher so a lead webhook can't be pointed at an internal address.
  const { safeFetch } = await import('../../lib/security/safeFetch');
  await safeFetch(integration.config.webhook_url, {
    method: 'POST',
    headers,
    body,
  }, { maxBytes: 1 * 1024 * 1024 }).catch(() => null);
}

/** Publish a blog post via wordpress or custom_blog_api integration */
export async function publishBlog(
  companyId: string,
  payload: BlogPayload,
  preferType?: 'wordpress' | 'custom_blog_api'
): Promise<{ success: boolean; message: string }> {
  const type = preferType || 'wordpress';
  const integration = await getActiveIntegration(companyId, type);
  if (!integration) return { success: false, message: `No active ${type} integration found.` };
  // Enforcement: ensure the canonical connection exists before publishing.
  const connId =
    integration.website_connection_id ??
    (await ensureCanonicalConnectionForIntegration(integration).catch(() => null));
  const adapter = getCmsAdapter(type);
  const result = await adapter.publishPost({
    provider: type,
    companyId,
    connectionId: connId,
    websiteId: integration.website_id,
    config: integration.config,
  }, {
    blog: {
      id: 'direct-publish',
      company_id: companyId,
      created_by: '',
      title: payload.title,
      content: payload.content,
      slug: null,
      excerpt: null,
      content_blocks: null,
      featured_image_url: null,
      category: null,
      tags: [],
      seo_meta_title: null,
      seo_meta_description: null,
      is_featured: false,
      views_count: 0,
      status: 'draft',
      integration_id: integration.id,
      external_id: null,
      external_url: null,
      published_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      angle_type: null,
      hook_strength: null,
    },
    htmlContent: payload.content,
  });
  return { success: result.success, message: result.message };
}
