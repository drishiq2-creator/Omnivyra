/**
 * HARDEN-005 — safe outbound fetch (the centralized enforcement seam).
 *
 * Every protected server-side outbound request should go through safeFetch /
 * safeFetchBuffer instead of raw fetch/axios. It composes the ssrfGuard policy
 * with the runtime protections that can only happen at request time:
 *
 *   1. URL validation (protocol / credentials / literal-IP) via ssrfGuard.
 *   2. DNS resolution of the hostname, and rejection if ANY resolved address is
 *      in a blocked range (IPv4 + IPv6).
 *   3. Connection PINNING: the socket is forced to connect to the exact IPs we
 *      validated (custom undici lookup), so a hostname that re-resolves to a
 *      private IP between our check and the connection (DNS rebinding) cannot
 *      reach an internal target.
 *   4. Manual redirect following: every hop is re-validated + re-resolved +
 *      re-pinned; capped count; no redirect can escape into a private network.
 *   5. Limits: connect/headers/body timeouts, max response size (declared
 *      Content-Length pre-check AND streamed byte cap to stop decompression
 *      bombs), max redirects.
 *   6. Observability: allowed / blocked / dns-failure / redirect / timeout /
 *      size counters + latency, via the HARDEN-001 registry (fail-safe).
 *   7. Credential containment (round 26, S-8 / T-14; credential policy rule P5 in
 *      backend/services/providerCredentialResolver.ts):
 *        - on a CROSS-ORIGIN redirect hop, credential headers (Authorization,
 *          Proxy-Authorization, Cookie, X-Api-Key, X-Webhook-*, any *signature* /
 *          *secret* / *token* / *api-key* / *password* / *auth* header, plus any
 *          caller-declared `credentialHeaders`) are dropped (Fetch-spec behaviour);
 *        - a 301/302/303 answer to a non-GET/HEAD request is followed as a body-less GET
 *          (request-body headers dropped); 307/308 keep method and body;
 *        - a request that CARRIES a credential header — or (M-1) a credential-named query
 *          parameter (`api_key`, `key`, `access_token`, `token`, `signature`, …, or a
 *          caller-declared `credentialQueryParams` name) — is refused over plain `http:`
 *          (`credential_over_plain_http`), on every hop, except to a loopback host
 *          (localhost / 127.0.0.0/8 / ::1) — the explicit local-dev allowance, which
 *          still needs `allowHttp` and `allowPrivateNetwork`;
 *        - owner decision (round 26 final): plain-http LOOPBACK is allowed ONLY in an
 *          explicit development/test environment — NODE_ENV development|test, or the opt-in
 *          SAFE_FETCH_ALLOW_LOOPBACK_HTTP=1, which is REFUSED when NODE_ENV=production.
 *          Elsewhere any http://loopback request is refused (`loopback_http_not_allowed`).
 *          Private / link-local / metadata addresses stay refused by ssrfGuard as before.
 *
 * Fail-CLOSED: any validation failure throws SsrfBlockedError; the request is
 * never issued.
 */
import dns from 'dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { validateOutboundUrl, isBlockedIp, type SsrfPolicy } from './ssrfGuard';
import { redactUrl, redactSecretsInText } from './redactUrl';
import { recordExternal, recordRawCounter } from '../../backend/observability';
import { defineRolloutFlag, resolveRolloutSync } from '../platform/rollout';
import { getOrCreateCircuitBreaker } from '../resilience/circuitBreaker';

export interface SafeFetchOptions extends SsrfPolicy {
  /** Max redirects to follow (default 3, 0 = none). */
  maxRedirects?: number;
  /** Max response bytes (default 25 MiB). Applies to declared + streamed size. */
  maxBytes?: number;
  /** Overall + per-phase timeouts (ms). */
  timeoutMs?: number;
  /** Label for observability metrics (defaults to the resolved host). */
  metricLabel?: string;
  /**
   * Extra header names (case-insensitive) that carry a credential for this call, beyond the
   * built-in list. They are stripped on a cross-origin redirect and refused over plain http.
   */
  credentialHeaders?: readonly string[];
  /**
   * Round 26 (M-1): extra query-parameter names (case-insensitive) that carry a credential
   * for this call — e.g. the parameter the external-API executor substituted a key into.
   * A request whose URL carries one is refused over plain http, like a credential header.
   */
  credentialQueryParams?: readonly string[];
}

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB
const DEFAULT_TIMEOUT_MS = 15_000;

export class SsrfBlockedError extends Error {
  readonly reason: string;
  /**
   * The blocked target, REDACTED (SEC-E3, STEP 3AH-91): query values, userinfo
   * and fragment are replaced, because several providers only accept their API
   * key as a query parameter and this error's message is logged and copied
   * into provider "unavailable" reasons.
   */
  readonly target: string;
  constructor(reason: string, target: string) {
    const safeTarget = redactSecretsInText(redactUrl(target));
    super(`SSRF blocked (${reason}) for ${safeTarget}`);
    this.name = 'SsrfBlockedError';
    this.reason = reason;
    this.target = safeTarget;
  }
}

function countBlocked(reason: string, hostOrUrl: string): void {
  // Metric labels are exported/persisted: never let a query string reach one.
  const host = redactUrl(hostOrUrl).slice(0, 120);
  try { recordRawCounter('ssrf.request.blocked', 1, { reason, host }); } catch { /* fail-safe */ }
}
function countAllowed(host: string): void {
  try { recordRawCounter('ssrf.request.allowed', 1, { host }); } catch { /* fail-safe */ }
}
/**
 * WS1-E6-T004 — per-host outbound circuit breaker.
 *
 * Reuses the platform breaker (lib/resilience/circuitBreaker) rather than
 * adding another implementation; the named registry there is exactly the
 * per-key model this needs. Thresholds are deliberately conservative:
 * `minimumRequestsBeforeTrigger` keeps a host with a handful of calls from
 * ever opening, so low-traffic upstreams behave exactly as before.
 */
export function outboundBreakerFor(host: string) {
  return getOrCreateCircuitBreaker(`outbound:${host}`, {
    failureThreshold: 5,
    timeout: 30_000,
    minimumRequestsBeforeTrigger: 20,
  });
}

function countEvent(name: string, host: string): void {
  try { recordRawCounter(`ssrf.request.${name}`, 1, { host }); } catch { /* fail-safe */ }
}

/**
 * Validate + DNS-resolve + IP-check a URL WITHOUT issuing the request. Throws
 * SsrfBlockedError if the target is unsafe. For call sites that must keep their
 * existing download mechanics (e.g. axios arraybuffer in the publish hot path)
 * but need to block internal targets before connecting. Note: unlike safeFetch,
 * this does not pin the connection, so a narrow DNS-rebinding TOCTOU window
 * remains — prefer safeFetch/safeFetchBuffer where the mechanics allow.
 */
export async function assertUrlSafe(rawUrl: string, options: SafeFetchOptions = {}): Promise<void> {
  const policy: SsrfPolicy = {
    allowHttp: options.allowHttp,
    allowedHosts: options.allowedHosts,
    allowPrivateNetwork: options.allowPrivateNetwork,
  };
  const check = validateOutboundUrl(rawUrl, policy);
  if (!check.ok || !check.url) {
    countBlocked(check.reason ?? 'invalid', String(rawUrl));
    throw new SsrfBlockedError(check.reason ?? 'invalid', String(rawUrl));
  }
  await resolveAndValidate(check.url.hostname, policy);
  countAllowed(check.url.hostname);
}

/** Resolve a hostname to all A/AAAA records and reject if any is blocked. */
async function resolveAndValidate(hostname: string, policy: SsrfPolicy): Promise<Array<{ address: string; family: number }>> {
  if (policy.allowPrivateNetwork) {
    // Test / explicit-dev path: skip DNS pinning, let the platform resolve.
    return [];
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    countEvent('dns_failure', hostname);
    throw new SsrfBlockedError('dns_resolution_failed', hostname);
  }
  if (!records.length) {
    throw new SsrfBlockedError('dns_no_records', hostname);
  }
  for (const rec of records) {
    if (isBlockedIp(rec.address)) {
      throw new SsrfBlockedError('resolved_to_blocked_ip', `${hostname} → ${rec.address}`);
    }
  }
  return records;
}

/** A custom undici lookup that only ever returns the pre-validated addresses. */
function makePinnedLookup(addresses: Array<{ address: string; family: number }>): (
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
) => void {
  return (_hostname, options, callback) => {
    if (addresses.length === 0) {
      callback(new Error('no validated addresses'), '', 0);
      return;
    }
    if (options && (options as dns.LookupOptions).all) {
      callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// ── Round 26 (S-8 / T-14): credential containment helpers ──────────────────────
const CREDENTIAL_HEADER_EXACT = new Set(['authorization', 'proxy-authorization', 'cookie', 'cookie2']);
const CREDENTIAL_HEADER_PATTERN = /^x-webhook-|signature|secret|token|api[-_]?key|password|passwd|auth/i;
/** Fetch spec "request-body-header names", plus the length. */
const REQUEST_BODY_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']);

/** True when a header name carries a credential (built-in list or caller-declared). */
export function isCredentialHeaderName(name: string, extra: readonly string[] = []): boolean {
  const n = String(name).trim().toLowerCase();
  if (!n) return false;
  if (CREDENTIAL_HEADER_EXACT.has(n) || CREDENTIAL_HEADER_PATTERN.test(n)) return true;
  return extra.some((e) => String(e).trim().toLowerCase() === n);
}

/** Normalise any HeadersInit to a plain lower-cased record (values untouched). */
function headersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const put = (k: unknown, v: unknown) => { if (v !== undefined && v !== null) out[String(k).toLowerCase()] = String(v); };
  if (Array.isArray(headers)) {
    for (const pair of headers as unknown[]) if (Array.isArray(pair) && pair.length >= 2) put(pair[0], pair[1]);
  } else if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    (headers as { forEach: (fn: (v: string, k: string) => void) => void }).forEach((v, k) => put(k, v));
  } else if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) put(k, v);
  }
  return out;
}

/**
 * Round 26 (M-1): credential-NAMED query parameters. Mirrors, character for character, the
 * credential key-name rule of the external-API layer (`CREDENTIAL_KEY_NAME` in Agent B's
 * backend/services/externalApi/credentialReference.ts, round-26 branch — not on main and not
 * in this worktree, so it cannot be imported here yet). Anchored, so ordinary parameters such
 * as `author`, `pageToken` or `q` never match. After B lands, replace this constant with an
 * import of B's exported rule (one detector).
 */
const CREDENTIAL_QUERY_PARAM_NAME =
  /^(?:authorization|proxy-authorization|x-api-key|x-auth-token|x-access-token|api[_-]?key|apikey|api[_-]?token|key|access[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|client[_-]?id|secret|password|passwd|signature|_client_id_env|_client_secret_env)$/i;

/** True when a query-parameter name carries a credential (shared rule, or caller-declared). */
export function isCredentialQueryParamName(name: string, extra: readonly string[] = []): boolean {
  const n = String(name).trim();
  if (!n) return false;
  if (CREDENTIAL_QUERY_PARAM_NAME.test(n)) return true;
  return extra.some((e) => String(e).trim().toLowerCase() === n.toLowerCase());
}

/** True when the URL carries a non-empty credential-named query parameter. Never reads it out. */
function carriesCredentialQueryParam(url: URL, extra: readonly string[]): boolean {
  for (const [name, value] of url.searchParams) {
    if (value !== '' && isCredentialQueryParamName(name, extra)) return true;
  }
  return false;
}

function carriesCredentialHeader(headers: unknown, extra: readonly string[]): boolean {
  return Object.keys(headersToRecord(headers)).some((k) => isCredentialHeaderName(k, extra));
}

/**
 * Round 26 final (owner decision): is the plain-http loopback dev allowance available in
 * this process? Only in development/test (NODE_ENV), or with the explicit opt-in
 * SAFE_FETCH_ALLOW_LOOPBACK_HTTP, which is refused when NODE_ENV=production.
 */
export function isDevLoopbackHttpAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnv = String(env.NODE_ENV ?? '').trim().toLowerCase();
  if (nodeEnv === 'production') return false;
  if (nodeEnv === 'development' || nodeEnv === 'test') return true;
  return /^(1|true|yes|on)$/i.test(String(env.SAFE_FETCH_ALLOW_LOOPBACK_HTTP ?? '').trim());
}

/** localhost, 127.0.0.0/8, ::1 — the only hosts a credential may reach over plain http (dev only). */
export function isLoopbackHost(hostname: string): boolean {
  const h = String(hostname).trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * The request init for the NEXT hop of a redirect (Fetch spec "HTTP-redirect fetch"):
 * 301/302/303 on a non-GET/HEAD request become a body-less GET; a cross-origin hop loses
 * every credential header. Never mutates the caller's init.
 */
export function nextHopInit(
  init: RequestInit,
  status: number,
  fromUrl: URL,
  toUrl: URL,
  extraCredentialHeaders: readonly string[] = [],
): { init: RequestInit; strippedCredentials: boolean; downgradedToGet: boolean } {
  const method = String(init.method ?? 'GET').toUpperCase();
  const toGet = (status === 301 || status === 302 || status === 303) && method !== 'GET' && method !== 'HEAD';
  const crossOrigin = fromUrl.origin !== toUrl.origin;
  if (!toGet && !crossOrigin) return { init, strippedCredentials: false, downgradedToGet: false };

  const headers = headersToRecord(init.headers);
  let stripped = false;
  for (const k of Object.keys(headers)) {
    if (toGet && REQUEST_BODY_HEADERS.has(k)) delete headers[k];
    if (crossOrigin && isCredentialHeaderName(k, extraCredentialHeaders)) { delete headers[k]; stripped = true; }
  }
  const next: RequestInit = { ...init, headers };
  if (toGet) {
    next.method = 'GET';
    delete (next as { body?: unknown }).body;
    delete (next as { duplex?: unknown }).duplex;
  }
  return { init: next, strippedCredentials: stripped, downgradedToGet: toGet };
}

// ── W2-5 (audit B-18): pooled keep-alive agents ───────────────────────────────
//
// With the flag OFF (default) every call builds a fresh single-use Agent —
// today's behavior byte-for-byte. With 'outbound-keepalive' ON, agents are
// reused per (hostname, validated-address-set, timeout): repeat calls to the
// same host skip the TCP+TLS handshake (~50–150 ms each).
//
// SECURITY IS UNCHANGED EITHER WAY: DNS resolution + SSRF validation still
// run on EVERY call and EVERY redirect hop (resolveAndValidate above); an
// agent is only reused when the freshly-validated address set is IDENTICAL
// to the one it was pinned to — a DNS change produces a different pool key
// and a new pinned agent. Bounded LRU; evicted agents are closed.
// Enable: ROLLOUT_OUTBOUND_KEEPALIVE_MODE=enforce (or configureOutboundAgents
// in lib/platform/outboundHttp). Kill: ROLLOUT_OUTBOUND_KEEPALIVE_KILL.
const OUTBOUND_KEEPALIVE_FLAG = defineRolloutFlag({
  key: 'outbound-keepalive',
  description: 'W2-5: pooled keep-alive agents in safeFetch (audit B-18)',
});

const AGENT_POOL = new Map<string, Agent>();
const AGENT_POOL_MAX = 64;

function getPooledAgent(
  host: string,
  addresses: Array<{ address: string; family: number }>,
  timeoutMs: number,
): Agent {
  const key = `${host}|${addresses.map((a) => a.address).sort().join(',')}|${timeoutMs}`;
  const existing = AGENT_POOL.get(key);
  if (existing) {
    AGENT_POOL.delete(key);
    AGENT_POOL.set(key, existing); // LRU bump
    return existing;
  }
  const agent = new Agent({
    connect: { lookup: makePinnedLookup(addresses), timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    maxRedirections: 0, // we follow manually so every hop is re-validated
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
  });
  AGENT_POOL.set(key, agent);
  if (AGENT_POOL.size > AGENT_POOL_MAX) {
    const oldestKey = AGENT_POOL.keys().next().value as string;
    const evicted = AGENT_POOL.get(oldestKey);
    AGENT_POOL.delete(oldestKey);
    void evicted?.close().catch(() => { /* best-effort */ });
  }
  return agent;
}

/**
 * Perform a validated, pinned, redirect-safe outbound fetch. Returns the final
 * undici Response (its body still needs reading; use readCapped/safeFetchBuffer
 * to enforce the streamed byte cap, or read small JSON/text directly).
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}, options: SafeFetchOptions = {}): Promise<Response> {
  const policy: SsrfPolicy = {
    allowHttp: options.allowHttp,
    allowedHosts: options.allowedHosts,
    allowPrivateNetwork: options.allowPrivateNetwork,
  };
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let currentUrl = rawUrl;
  let currentInit: RequestInit = init;
  const extraCredentialHeaders = options.credentialHeaders ?? [];
  const extraCredentialQueryParams = options.credentialQueryParams ?? [];
  let redirects = 0;
  const t0 = Date.now();

  while (true) {
    const check = validateOutboundUrl(currentUrl, policy);
    if (!check.ok || !check.url) {
      countBlocked(check.reason ?? 'invalid', String(currentUrl));
      throw new SsrfBlockedError(check.reason ?? 'invalid', String(currentUrl));
    }
    const url = check.url;
    const host = url.hostname;

    // Round 26 (S-8/T-14 + owner decision): a credential never travels over plain http.
    // The only exception is loopback in an explicit dev/test environment; outside one, ANY
    // http://loopback request is refused. Checked on EVERY hop, before DNS and before any
    // byte is sent. Private/link-local targets remain refused by ssrfGuard / DNS pinning.
    if (url.protocol === 'http:') {
      if (isLoopbackHost(host)) {
        if (!isDevLoopbackHttpAllowed()) {
          countBlocked('loopback_http_not_allowed', String(currentUrl));
          throw new SsrfBlockedError('loopback_http_not_allowed', String(currentUrl));
        }
      } else if (
        carriesCredentialHeader(currentInit.headers, extraCredentialHeaders) ||
        carriesCredentialQueryParam(url, extraCredentialQueryParams)
      ) {
        countBlocked('credential_over_plain_http', String(currentUrl));
        throw new SsrfBlockedError('credential_over_plain_http', String(currentUrl));
      }
    }

    const addresses = await resolveAndValidate(host, policy);

    // W2-5: pooled keep-alive agent when the rollout flag is on; otherwise
    // the historical fresh-per-call agent. Pinning semantics identical.
    const agent = resolveRolloutSync(OUTBOUND_KEEPALIVE_FLAG).mode !== 'off'
      ? getPooledAgent(host, addresses, timeoutMs)
      : new Agent({
          connect: { lookup: makePinnedLookup(addresses), timeout: timeoutMs },
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          maxRedirections: 0, // we follow manually so every hop is re-validated
        });

    let res: Response;
    try {
      // WS1-E6-T004: per-HOST circuit breaker on the single outbound seam.
      // Keyed by hostname so one failing upstream cannot cascade into every
      // other outbound call, and a healthy host is never affected by a sick
      // one. The breaker wraps ONLY the network call — SSRF validation and
      // DNS pinning above always run, so an open circuit can never relax a
      // security check. Wrapping here (rather than at 66 call sites) keeps
      // safeFetch the single outbound seam that HARDEN-005 established.
      res = (await outboundBreakerFor(host).call(async () =>
        (await undiciFetch(url, {
          ...(currentInit as Record<string, unknown>),
          redirect: 'manual',
          dispatcher: agent,
        } as never)) as unknown as Response,
      )) as Response;
    } catch (err) {
      const timedOut = /timeout|UND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)/i.test((err as Error)?.message ?? '');
      if (timedOut) countEvent('timeout', host);
      try { recordExternal({ host, durationMs: Date.now() - t0, error: true, timeout: timedOut }); } catch { /* fail-safe */ }
      throw err instanceof SsrfBlockedError ? err : err;
    }

    if (isRedirectStatus(res.status)) {
      const location = res.headers.get('location');
      if (location) {
        if (redirects >= maxRedirects) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          countBlocked('too_many_redirects', host);
          throw new SsrfBlockedError('too_many_redirects', currentUrl);
        }
        redirects += 1;
        countEvent('redirect', host);
        try { await res.body?.cancel(); } catch { /* ignore */ }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, url);
        } catch {
          countBlocked('invalid_redirect_location', host);
          throw new SsrfBlockedError('invalid_url', currentUrl);
        }
        // Round 26 (S-8/T-14): strip credentials cross-origin; 301/302/303 → body-less GET.
        const hop = nextHopInit(currentInit, res.status, url, nextUrl, extraCredentialHeaders);
        if (hop.strippedCredentials) countEvent('redirect_credentials_stripped', host);
        currentInit = hop.init;
        currentUrl = nextUrl.href; // re-validated at loop top
        continue;
      }
    }

    // Declared-size pre-check (cheap; the streamed cap in readCapped is the real guard).
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      countBlocked('response_too_large', host);
      throw new SsrfBlockedError('response_too_large', currentUrl);
    }

    countAllowed(host);
    try { recordExternal({ host, durationMs: Date.now() - t0, status: res.status, error: res.status >= 500 }); } catch { /* fail-safe */ }
    // Stash the cap so readCapped/safeFetchBuffer can enforce it.
    (res as { __ssrfMaxBytes?: number }).__ssrfMaxBytes = maxBytes;
    return res;
  }
}

/**
 * Read a Response body into a Buffer, aborting if it exceeds maxBytes (defeats
 * decompression bombs / oversized downloads that lie about Content-Length).
 */
export async function readCapped(res: Response, maxBytes?: number): Promise<Buffer> {
  const cap = maxBytes ?? (res as { __ssrfMaxBytes?: number }).__ssrfMaxBytes ?? DEFAULT_MAX_BYTES;
  const body = res.body;
  if (!body) return Buffer.alloc(0);
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > cap) {
          try { await reader.cancel(); } catch { /* ignore */ }
          const host = (() => { try { return new URL(res.url).hostname; } catch { return 'unknown'; } })();
          countBlocked('stream_exceeded_max_bytes', host);
          throw new SsrfBlockedError('stream_exceeded_max_bytes', res.url || 'unknown');
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return Buffer.concat(chunks, total);
}

/**
 * Convenience for media/asset downloads: validate + fetch + size-capped read.
 * Returns the bytes, content-type, and status. Throws SsrfBlockedError on any
 * policy failure or oversize.
 */
export async function safeFetchBuffer(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<{ buffer: Buffer; contentType: string | null; status: number; finalUrl: string }> {
  const res = await safeFetch(rawUrl, { method: 'GET' }, options);
  const buffer = await readCapped(res, options.maxBytes);
  return {
    buffer,
    contentType: res.headers.get('content-type'),
    status: res.status,
    finalUrl: res.url || rawUrl,
  };
}
