/**
 * ApiConnectionTestService
 *
 * Lightweight connection test for External API configs.
 * Resolves credentials (including OAuth from DB), runs a minimal request,
 * returns structured result. Never returns decrypted secrets to frontend.
 */

import { supabase } from '../db/supabaseClient';
import {
  buildExternalApiRequest,
  type ExternalApiSource,
} from './externalApiService';
import { updateApiHealth } from './externalApiHealthService';
import { decryptCredential } from '../auth/credentialEncryption';
import {
  isSecretShapedMapValue,
  redactDiagnosticMessage,
} from './externalApi/credentialReference';

export type TestConnectionResult = {
  success: boolean;
  status: number;
  message: string;
  latency_ms: number;
  /** Set only when the test was refused before any request (see PLATFORM_SOURCE_SUPER_ADMIN_ONLY). */
  code?: string;
};

/**
 * Round 26 (H-3): a platform row (company_id IS NULL) is tested with PLATFORM credentials and
 * its result is written to the platform health record that gates polling for every tenant.
 * Only a Super Admin may run it.
 */
export const PLATFORM_SOURCE_SUPER_ADMIN_ONLY = 'PLATFORM_SOURCE_SUPER_ADMIN_ONLY';

/** A company id that is safe to place inside a PostgREST `or=(...)` filter. */
const SAFE_COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Round 26 (H-3): every credential value the test request actually carried. A provider error
 * body (or a thrown error) may echo it; it is cut out of the message before it is returned.
 */
function sentCredentialValues(details: {
  url: string;
  maskedUrl?: string;
  headers: Record<string, unknown>;
  maskedHeaders?: Record<string, unknown>;
}): string[] {
  const out: string[] = [];
  const masked = details.maskedHeaders ?? {};
  for (const [k, v] of Object.entries(details.headers || {})) {
    if (typeof v !== 'string') continue;
    if (v !== masked[k] || isSecretShapedMapValue(k, v)) {
      out.push(v);
      const bare = v.replace(/^(?:Bearer|Basic|Token|Key)\s+/i, '');
      if (bare !== v) out.push(bare);
    }
  }
  try {
    const sent = new URL(details.url).searchParams;
    const maskedParams = details.maskedUrl ? new URL(details.maskedUrl).searchParams : new URLSearchParams();
    sent.forEach((v, k) => {
      if (v !== maskedParams.get(k) || isSecretShapedMapValue(k, v)) out.push(v);
    });
  } catch {
    // an unparseable URL carries nothing we can enumerate; redactSecretsInText still runs
  }
  return out;
}

const DEFAULT_TIMEOUT_MS = 8000;

/** OAuth token URLs for known providers (client_credentials grant) */
const OAUTH_TOKEN_URLS: Record<string, string> = {
  linkedin: 'https://www.linkedin.com/oauth/v2/accessToken',
  youtube: 'https://oauth2.googleapis.com/token',
  google: 'https://oauth2.googleapis.com/token',
  facebook: 'https://graph.facebook.com/oauth/access_token',
  instagram: 'https://graph.instagram.com/oauth/access_token',
};

/**
 * Resolve API source by id, optionally scoped by company/platform.
 */
async function resolveApiSource(
  apiId: string,
  companyId?: string | null,
  platformScope?: boolean
): Promise<ExternalApiSource | null> {
  let query = supabase.from('external_api_sources').select('*').eq('id', apiId);
  if (!platformScope) {
    // Round 26: a non-platform caller reaches its own company's rows and platform rows (the
    // latter are then refused unless the caller is a Super Admin, see testApiConnection).
    // The company id is interpolated into a PostgREST filter, so its shape is checked, and the
    // scope is re-checked in process so a filter the data layer ignores cannot widen it.
    if (!companyId || !SAFE_COMPANY_ID.test(companyId)) return null;
    query = query.or(`company_id.eq.${companyId},company_id.is.null`);
  }
  const { data, error } = await query.single();
  if (error || !data) return null;
  const row = data as ExternalApiSource & { company_id?: string | null };
  if (!platformScope && row.company_id != null && row.company_id !== companyId) return null;
  return row as ExternalApiSource;
}

/**
 * Run a lightweight test request and return structured result.
 */
export async function testApiConnection(input: {
  apiId: string;
  companyId?: string | null;
  platformScope?: boolean;
  /**
   * Round 26 (H-3): true only when the CALLER is a Super Admin. Without it a platform row
   * (company_id IS NULL) is refused before any credential is resolved, any request is sent
   * or any health record is written. `platformScope` callers are Super Admins by route gate.
   */
  allowPlatformRows?: boolean;
}): Promise<TestConnectionResult> {
  const start = Date.now();
  const source = await resolveApiSource(
    input.apiId,
    input.companyId,
    input.platformScope
  );
  if (!source) {
    return {
      success: false,
      status: 404,
      message: 'API source not found',
      latency_ms: Date.now() - start,
    };
  }
  if ((source as { company_id?: string | null }).company_id == null
    && !input.platformScope && input.allowPlatformRows !== true) {
    return {
      success: false,
      status: 403,
      code: PLATFORM_SOURCE_SUPER_ADMIN_ONLY,
      message: 'Platform API sources can only be tested by a Super Admin.',
      latency_ms: Date.now() - start,
    };
  }

  const authType = (source.auth_type || 'none').toLowerCase();

  // OAuth: try client_credentials if we have encrypted credentials
  if (
    authType === 'oauth' &&
    source.oauth_client_id_encrypted &&
    source.oauth_client_secret_encrypted
  ) {
    const result = await testOAuthConnection(source, start);
    await persistTestResult(source.id, result);
    return result;
  }

  // api_key, bearer, header, query, none: use buildExternalApiRequest + fetch
  const { details, missingEnv } = buildExternalApiRequest(source, {
    queryParams: { geo: 'US', category: 'test' },
  });

  if (missingEnv.length > 0) {
    const result: TestConnectionResult = {
      success: false,
      status: 400,
      message: `Missing: ${missingEnv.join(', ')}`,
      latency_ms: Date.now() - start,
    };
    await persistTestResult(source.id, result);
    return result;
  }
  const sentSecrets = sentCredentialValues(details as any);

  try {
    // HARDEN-005: `details.url` is a user-supplied API endpoint under test —
    // route it through the SSRF-safe fetcher so it can't probe the internal
    // network. A blocked target throws and surfaces as a normal failed result
    // via the catch below (no behavior change for legitimate external APIs).
    const { safeFetch } = await import('../../lib/security/safeFetch');
    const response = await safeFetch(details.url, {
      method: details.method,
      headers: details.headers as Record<string, string>,
    }, { timeoutMs: DEFAULT_TIMEOUT_MS, maxBytes: 2 * 1024 * 1024 });
    const latencyMs = Date.now() - start;

    let message: string;
    if (response.ok) {
      message = 'Connection successful';
    } else {
      const text = await response.text();
      let parsed: any;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { message: text || response.statusText };
      }
      const errMsg =
        parsed?.error?.message ??
        parsed?.error_description ??
        parsed?.message ??
        parsed?.error ??
        response.statusText;
      message = typeof errMsg === 'string' ? errMsg : `HTTP ${response.status}`;
    }

    const result: TestConnectionResult = {
      success: response.ok,
      status: response.status,
      // Round 26 (H-3): provider error text may echo the credential that was sent.
      message: redactDiagnosticMessage(message, sentSecrets),
      latency_ms: latencyMs,
    };
    await persistTestResult(source.id, result);
    return result;
  } catch (error: any) {
    const latencyMs = Date.now() - start;
    const msg =
      error?.name === 'AbortError'
        ? 'Request timed out'
        : error?.message ?? 'Request failed';
    const result: TestConnectionResult = {
      success: false,
      status: 0,
      message: redactDiagnosticMessage(msg, sentSecrets),
      latency_ms: latencyMs,
    };
    await persistTestResult(source.id, result);
    return result;
  }
}

async function testOAuthConnection(
  source: ExternalApiSource,
  start: number
): Promise<TestConnectionResult> {
  const oauthSecrets: string[] = [];
  try {
    const clientId = decryptCredential(source.oauth_client_id_encrypted!);
    const clientSecret = decryptCredential(source.oauth_client_secret_encrypted!);
    if (clientId) oauthSecrets.push(clientId);
    if (clientSecret) oauthSecrets.push(clientSecret);
    if (!clientId || !clientSecret) {
      return {
        success: false,
        status: 400,
        message: 'Invalid OAuth client credentials',
        latency_ms: Date.now() - start,
      };
    }

    const category = (source.category || source.name || '')
      .toLowerCase()
      .replace(/\s+/g, '');
    const tokenUrl =
      OAUTH_TOKEN_URLS[category] ??
      OAUTH_TOKEN_URLS['linkedin']; // fallback for social APIs

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    // HARDEN-005: `tokenUrl` can be a user-supplied OAuth token endpoint —
    // SSRF-safe fetch (blocked → failed result via the catch below).
    const { safeFetch } = await import('../../lib/security/safeFetch');
    const response = await safeFetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, { timeoutMs: DEFAULT_TIMEOUT_MS, maxBytes: 2 * 1024 * 1024 });
    const latencyMs = Date.now() - start;

    if (response.ok) {
      return {
        success: true,
        status: response.status,
        message: 'Connection successful',
        latency_ms: latencyMs,
      };
    }

    const text = await response.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error_description: text || response.statusText };
    }
    const errMsg =
      parsed?.error_description ??
      parsed?.error ??
      parsed?.message ??
      response.statusText;
    return {
      success: false,
      status: response.status,
      // Round 26 (H-3): the token endpoint's error text may echo the client credentials.
      message: redactDiagnosticMessage(
        typeof errMsg === 'string' ? errMsg : `HTTP ${response.status}`,
        [clientId, clientSecret],
      ),
      latency_ms: latencyMs,
    };
  } catch (error: any) {
    const msg =
      error?.name === 'AbortError'
        ? 'Request timed out'
        : error?.message ?? 'OAuth request failed';
    return {
      success: false,
      status: 0,
      message: redactDiagnosticMessage(msg, oauthSecrets),
      latency_ms: Date.now() - start,
    };
  }
}

async function persistTestResult(
  apiId: string,
  result: TestConnectionResult
): Promise<void> {
  try {
    await updateApiHealth({
      apiId,
      success: result.success,
      latencyMs: result.latency_ms,
      last_test_status: result.success ? 'SUCCESS' : 'FAILED',
      last_test_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[ApiConnectionTestService] Failed to persist test result', e);
  }
}
