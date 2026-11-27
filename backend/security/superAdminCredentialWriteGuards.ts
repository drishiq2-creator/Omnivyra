/**
 * Round 26 (Agent C) — server-side guards for the Super Admin credential write routes:
 *   - pages/api/provider-accounts (POST) and pages/api/provider-accounts/[id] (PUT);
 *   - pages/api/admin/intelligence/api-presets (POST, PUT base_url).
 *
 * Production evidence (round 25 CT, shape only): five `api_provider_accounts` envelopes held a
 * raw provider key — one as a legacy PLAINTEXT `api_key_value`, four inside
 * `api_key_env_name`. The shared envelope builder (providerAccountService, owned by another
 * track) carries every existing field forward, so a re-save kept those values. These guards
 * make every credential save converge to the safe shape:
 *
 *   { api_key_env_name?: <ENV_VAR_NAME>, api_key_value?: <ciphertext>,
 *     oauth_client_id_ref?: <ciphertext>, oauth_client_secret_ref?: <ciphertext> }
 *
 * Nothing here returns, logs or echoes a credential value. Rejections name the FIELD only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { encryptCredential } from '../auth/credentialEncryption';
import { describeRejectedEnvVarName, isEncryptedCredential, isEnvVarName } from './credentialSafety';
import { requireCapability } from './requireCapability';
import { enforcePlatformWriteAuthority } from './platformWriteAuthority';
import { INTEGRATION_PLATFORM_OAUTH_MANAGE } from '../../shared/contracts/security';
import { supabase } from '../db/supabaseClient';

export type SourceOwnershipCheck =
  | { ok: true }
  | { ok: false; status: 400 | 500; body: { error: string; detail: string } };

/**
 * Round 26 final (Agent E request C-1 / S-3 route half): a provider account holds PLATFORM
 * credentials, so it may only be created on, or carry credentials for, a PLATFORM source
 * (`external_api_sources.company_id IS NULL`). A tenant-owned source is refused.
 *
 *  - read error            -> 500, fail closed (nothing written);
 *  - row with company_id   -> 400 PROVIDER_ACCOUNT_TENANT_SOURCE;
 *  - no row                -> allowed here: the api_source_id foreign key refuses the insert,
 *                             and an absent row is not evidence of a tenant row.
 */
export async function checkPlatformOwnedSource(apiSourceId: string): Promise<SourceOwnershipCheck> {
  const { data, error } = await supabase
    .from('external_api_sources')
    .select('id, company_id')
    .eq('id', apiSourceId)
    .maybeSingle();
  if (error) {
    return { ok: false, status: 500, body: { error: 'SOURCE_LOOKUP_FAILED', detail: 'Could not verify the API source owner.' } };
  }
  const companyId = (data as { company_id?: unknown } | null)?.company_id;
  if (typeof companyId === 'string' && companyId.trim() !== '') {
    return {
      ok: false, status: 400,
      body: {
        error: 'PROVIDER_ACCOUNT_TENANT_SOURCE',
        detail: 'Provider accounts hold platform credentials and can only be attached to platform API sources, not to a company-owned source.',
      },
    };
  }
  return { ok: true };
}

/** The only credential fields a provider-account write may carry. */
export const PROVIDER_ACCOUNT_CREDENTIAL_FIELDS = [
  'api_key_env_name',
  'api_key_value',
  'oauth_client_id',
  'oauth_client_secret',
  'oauth_client_id_ref',
  'oauth_client_secret_ref',
] as const;

export type CredentialInputCheck =
  | { ok: true; supplied: Record<string, string>; suppliedKeys: Set<string>; clearEnvName: boolean }
  | { ok: false; status: 400; body: { error: string; detail: string; field?: string } };

/**
 * Validate the `credentials` object of a provider-account POST/PUT.
 *  - unknown fields are refused (a key pasted under an unexpected name is never stored);
 *  - every value is a string; `api_key_env_name: null` (PUT only) clears the reference;
 *  - `api_key_env_name` must be an env-var NAME — a raw key is refused (400, not echoed);
 *  - `*_ref` must already be ciphertext — a plaintext value submitted as a ref is refused.
 */
export function checkProviderAccountCredentialsInput(
  credentials: unknown,
  opts: { allowClearEnvName: boolean },
): CredentialInputCheck {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    return { ok: false, status: 400, body: { error: 'INVALID_CREDENTIALS', detail: 'credentials must be an object.' } };
  }
  const supplied: Record<string, string> = {};
  const suppliedKeys = new Set<string>();
  let clearEnvName = false;
  for (const [field, value] of Object.entries(credentials as Record<string, unknown>)) {
    if (!(PROVIDER_ACCOUNT_CREDENTIAL_FIELDS as readonly string[]).includes(field)) {
      return {
        ok: false, status: 400,
        body: { error: 'UNSUPPORTED_CREDENTIAL_FIELD', field, detail: `Unsupported credential field. Allowed: ${PROVIDER_ACCOUNT_CREDENTIAL_FIELDS.join(', ')}.` },
      };
    }
    if (field === 'api_key_env_name' && value === null && opts.allowClearEnvName) {
      clearEnvName = true;
      continue;
    }
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      return { ok: false, status: 400, body: { error: 'INVALID_CREDENTIAL_FIELD', field, detail: `${field} must be a string.` } };
    }
    if (!value.trim()) continue; // empty = "leave unchanged" (existing UI contract)
    if (field === 'api_key_env_name' && !isEnvVarName(value)) {
      return { ok: false, status: 400, body: { error: 'INVALID_ENV_VAR_NAME', field, detail: describeRejectedEnvVarName(value) } };
    }
    if ((field === 'oauth_client_id_ref' || field === 'oauth_client_secret_ref') && !isEncryptedCredential(value)) {
      return {
        ok: false, status: 400,
        body: { error: 'INVALID_CREDENTIAL_REF', field, detail: `${field} must be an encrypted reference. Submit the value as ${field.replace(/_ref$/, '')} so it is encrypted.` },
      };
    }
    supplied[field] = value;
    suppliedKeys.add(field);
  }
  return { ok: true, supplied, suppliedKeys, clearEnvName };
}

/**
 * Post-process a merged envelope so no save can persist a legacy unsafe field:
 *  - a non-env-name `api_key_env_name` (a raw key) is DROPPED, never carried forward;
 *  - a plaintext `api_key_value` is ENCRYPTED (the effective key is unchanged);
 *  - a plaintext direct `oauth_client_id` / `oauth_client_secret` is moved into its
 *    encrypted `_ref` (or dropped when this request supplied that field, since the
 *    builder already wrote the new ref);
 *  - `clearEnvName` removes the reference on request.
 * Throws only when encryption fails, so the caller fails closed.
 */
export function hardenCredentialEnvelope(
  envelope: string,
  opts: { clearEnvName?: boolean; suppliedKeys?: Set<string> } = {},
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    return envelope;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return envelope;
  const next = { ...(parsed as Record<string, unknown>) };

  if (opts.clearEnvName) delete next.api_key_env_name;
  if (typeof next.api_key_env_name === 'string' && !isEnvVarName(next.api_key_env_name)) {
    delete next.api_key_env_name;
  }

  if (typeof next.api_key_value === 'string' && next.api_key_value.trim() && !isEncryptedCredential(next.api_key_value)) {
    next.api_key_value = encryptCredential(next.api_key_value.trim());
  }

  for (const base of ['oauth_client_id', 'oauth_client_secret'] as const) {
    const direct = next[base];
    if (typeof direct !== 'string' || !direct.trim()) {
      delete next[base];
      continue;
    }
    const ref = `${base}_ref`;
    const suppliedThisRequest = opts.suppliedKeys?.has(base) || opts.suppliedKeys?.has(ref);
    if (!suppliedThisRequest) {
      // The resolver prefers the direct field today, so keep the EFFECTIVE value — encrypted.
      next[ref] = encryptCredential(direct.trim());
    }
    delete next[base];
  }
  return JSON.stringify(next);
}

/** Shape-only state of a stored envelope, for the Super Admin list. Never a value. */
export type ProviderAccountCredentialState = {
  key: 'absent' | 'encrypted' | 'plaintext';
  env_reference: 'absent' | 'valid' | 'invalid';
  oauth: 'absent' | 'encrypted' | 'plaintext';
  needs_resave: boolean;
};

export function describeCredentialEnvelopeShape(envelope: unknown): ProviderAccountCredentialState {
  let creds: Record<string, unknown> = {};
  if (typeof envelope === 'string' && envelope.trim()) {
    try {
      const p = JSON.parse(envelope);
      if (p && typeof p === 'object' && !Array.isArray(p)) creds = p as Record<string, unknown>;
    } catch { /* unparseable: reported as absent */ }
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const keyVal = str(creds.api_key_value);
  const envVal = str(creds.api_key_env_name);
  const key = !keyVal ? 'absent' : isEncryptedCredential(keyVal) ? 'encrypted' : 'plaintext';
  const env_reference = !envVal ? 'absent' : isEnvVarName(envVal) ? 'valid' : 'invalid';
  const directOauth = Boolean(str(creds.oauth_client_id) || str(creds.oauth_client_secret));
  const refs = [str(creds.oauth_client_id_ref), str(creds.oauth_client_secret_ref)].filter(Boolean) as string[];
  const oauth = directOauth || refs.some((r) => !isEncryptedCredential(r))
    ? 'plaintext'
    : refs.length > 0 ? 'encrypted' : 'absent';
  return { key, env_reference, oauth, needs_resave: key === 'plaintext' || env_reference === 'invalid' || oauth === 'plaintext' };
}

/** Column names that may hold credential material and must never reach a browser. */
const SECRET_COLUMN_RE = /(credential|secret|token|encrypted|key_value|password)/i;

/**
 * Serialise a provider-account row for a response: drop every credential-bearing column
 * (deny by name, so a column added later is withheld by default) and add the shape-only
 * `credential_state`.
 */
export function toSafeProviderAccount<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    if (SECRET_COLUMN_RE.test(k)) continue;
    out[k] = v;
  }
  out.credential_state = describeCredentialEnvelopeShape((row as Record<string, unknown>)?.credentials_encrypted);
  return out;
}

/**
 * H-4: a write that sets WHERE platform credentials are sent (a preset's `base_url`, or a new
 * preset with its credential reference/templates) needs the same custody as writing the
 * credential itself: INTEGRATION_PLATFORM_OAUTH_MANAGE (passkey step-up; bridge principals
 * refused) plus platform write authority.
 */
export async function requireCredentialDestinationWriteAuthority(
  req: NextApiRequest,
  res: NextApiResponse,
  operation: string,
): Promise<boolean> {
  const guard = await requireCapability(req, res, {
    capability: INTEGRATION_PLATFORM_OAUTH_MANAGE,
    reason: operation,
  });
  if (guard.ok !== true) return false;
  return enforcePlatformWriteAuthority(req, res, guard.principal, INTEGRATION_PLATFORM_OAUTH_MANAGE, operation);
}
