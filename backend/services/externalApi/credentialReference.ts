/**
 * Credential-REFERENCE hygiene for external API sources (round 23 B/C — NewsAPI leak).
 *
 * `external_api_sources.api_key_env_name` / `api_key_name` (and a provider account's or a
 * per-user override's `api_key_env_name`) are meant to hold the NAME of an environment
 * variable. A production row was found holding a plaintext 32-character provider key in
 * `api_key_env_name`. The execution path correctly refused to resolve it, but then reported
 * the refused "name" — i.e. the key itself — in `missingEnv`, from where it reached logs,
 * Super Admin test responses, `missing_env_placeholders` and recommendation
 * `omnivyra_metadata.placeholders`; and several routes served the row unredacted.
 *
 * This module is a thin layer over `backend/security/credentialSafety.ts` (the single
 * definition of a legitimate env-var name and of the redaction marker). It never logs,
 * returns or reproduces a rejected value.
 */
import {
  isEnvVarName,
  redactApiSourceRow,
  REDACTED_ENV_VAR_NAME,
} from '../../security/credentialSafety';
import { redactSecretsInText } from '../../../lib/security/redactUrl';

/** Stand-in reported instead of a credential reference that is not a valid env-var name. */
export function invalidCredentialReference(sourceId: unknown): string {
  const id = typeof sourceId === 'string' && sourceId.trim() ? sourceId.trim() : 'unknown';
  return `<invalid credential reference on source ${id}>`;
}

/**
 * The entry to report as "missing" for a credential reference. A valid env-var name is
 * reported as-is (unchanged behaviour); anything else is replaced by a fixed diagnostic that
 * names the source id only.
 */
export function reportableMissingEnvName(name: unknown, sourceId: unknown): string {
  return isEnvVarName(name) ? String(name) : invalidCredentialReference(sourceId);
}

/**
 * `api_key_name` is not always an env-var name (e.g. the PageSpeed row stores the query
 * parameter name `key` there), so it cannot be redacted on `isEnvVarName` alone. It is
 * redacted when it fails `isEnvVarName` AND has the shape of a secret: long, or a known
 * secret prefix. `api_key_env_name` is always held to the strict `isEnvVarName` rule.
 */
const SECRET_PREFIX = /^(?:sk-|AIza|ghp_|github_pat_|xox[baprs]-|Bearer\s)/i;
export function looksLikeSecretValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || isEnvVarName(trimmed)) return false;
  return trimmed.length >= 20 || SECRET_PREFIX.test(trimmed);
}

/** True when the client echoed the redaction marker back (meaning: "unchanged"). */
export function isRedactionMarker(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === REDACTED_ENV_VAR_NAME;
}

type AnyRow = Record<string, unknown>;

// ── Round 26 (H-2): secret-shaped values inside `headers` / `query_params` ──────────────────
//
// These maps are meant to hold literal non-secret parameters (`country: us`) and
// `{{ENV_VAR_NAME}}` templates that the executor resolves server-side. The Super Admin UI
// invited pasting raw keys into them (e.g. `headers._client_secret_env`), and every tenant
// read served them raw. The rule below is deliberately two-tier:
//   - under a credential-NAMED key (Authorization, x-api-key, api_key, key, token, secret,
//     `_client_*_env`, …) any literal that is not an env-var NAME and not a template is a
//     secret;
//   - under any other key only high-confidence shapes count (known secret prefixes, 32+ hex,
//     or a 32+ character single token mixing letters and digits), so ordinary parameters
//     (ids, locales, user agents, dates, URLs) are never flagged.

/** Marker served in place of a secret-shaped `headers` / `query_params` value or ciphertext. */
export const REDACTED_SECRET_VALUE = '__REDACTED_SECRET_VALUE__';

const CREDENTIAL_KEY_NAME =
  /^(?:authorization|proxy-authorization|x-api-key|x-auth-token|x-access-token|api[_-]?key|apikey|api[_-]?token|key|access[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|client[_-]?id|secret|password|passwd|signature|_client_id_env|_client_secret_env)$/i;
const TEMPLATE_TOKEN = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g;
const AUTH_SCHEME_PREFIX = /^(?:Bearer|Basic|Token|Key)(?:\s+|$)/i;
const KNOWN_SECRET_PREFIX = /^(?:sk-|sk_live_|rk_live_|pk_live_|AIza|ghp_|gho_|github_pat_|xox[baprs]-|ya29\.|EAA[A-Za-z0-9])/;

/** True when `value`, stored under map key `key`, has the shape of a literal credential. */
export function isSecretShapedMapValue(key: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.trim() === REDACTED_SECRET_VALUE) return false;
  // Templates are references, not secrets: judge only what is left around them.
  const remainder = value.replace(TEMPLATE_TOKEN, '').trim().replace(AUTH_SCHEME_PREFIX, '').trim();
  if (!remainder) return false;
  if (isEnvVarName(remainder)) return false;
  if (CREDENTIAL_KEY_NAME.test(String(key).trim())) return true;
  if (KNOWN_SECRET_PREFIX.test(remainder) && remainder.length >= 8 && !/\s/.test(remainder)) return true;
  if (/^[0-9a-f]{32,}$/i.test(remainder)) return true;
  // A canonical UUID under a non-credential key is an identifier (a channel, list or account id).
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(remainder)) return false;
  return remainder.length >= 32
    && /^[A-Za-z0-9_\-.~+/=]+$/.test(remainder)
    && /[0-9]/.test(remainder)
    && /[A-Za-z]/.test(remainder);
}

function asMap(value: unknown): AnyRow | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRow) : null;
}

/** Read-path: a copy of `map` with every secret-shaped value replaced by the marker. */
export function redactSecretShapedMap<T>(map: T): T {
  const m = asMap(map);
  if (!m) return map;
  let changed = false;
  const out: AnyRow = {};
  for (const [k, v] of Object.entries(m)) {
    if (isSecretShapedMapValue(k, v)) {
      out[k] = REDACTED_SECRET_VALUE;
      changed = true;
    } else {
      out[k] = v;
    }
  }
  return (changed ? out : map) as T;
}

/**
 * Write-path: the marker served by a read means "unchanged" — put the stored value back for
 * that key (or drop the key when nothing is stored), so a UI round-trip neither stores the
 * marker nor loses a legacy value. Returns `supplied` unchanged when it is not a map.
 */
export function restoreRedactedMapValues<T>(supplied: T, existing: unknown): T {
  const s = asMap(supplied);
  if (!s) return supplied;
  const e = asMap(existing) ?? {};
  const out: AnyRow = {};
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'string' && v.trim() === REDACTED_SECRET_VALUE) {
      if (k in e) out[k] = e[k];
      continue;
    }
    out[k] = v;
  }
  return out as T;
}

/** A key name that is safe to echo in an error (short and not itself secret-shaped). */
function reportableKeyName(key: string): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(key) && !isSecretShapedMapValue('', key) ? key : '<unnamed>';
}

/**
 * Write-path: names (never values) of the entries of `supplied` that are secret-shaped AND
 * new or changed relative to `existing`. An unchanged legacy value is left as stored (it is
 * redacted on every read), mirroring the api_key_env_name rule.
 */
export function findNewSecretShapedEntries(supplied: unknown, existing?: unknown): string[] {
  const s = asMap(supplied);
  if (!s) return [];
  const e = asMap(existing) ?? {};
  const bad: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (!isSecretShapedMapValue(k, v)) continue;
    if (k in e && e[k] === v) continue;
    bad.push(reportableKeyName(k));
  }
  return bad;
}

/** The 400 body for a secret pasted into a map field. Never echoes a value. */
export function secretInMapError(field: string, keys: string[]) {
  return {
    error: 'SECRET_VALUE_NOT_ALLOWED',
    field,
    keys,
    detail: `${field} must not contain a literal credential. Use an {{ENV_VAR_NAME}} template `
      + 'and store the secret itself on the provider account\'s Credentials form, where it is encrypted at rest.',
  };
}

const MAP_FIELDS = ['headers', 'query_params', 'headers_override', 'query_params_override'] as const;
const CIPHERTEXT_FIELDS = ['oauth_client_id_encrypted', 'oauth_client_secret_encrypted'] as const;

function redactOne<T>(row: T): T {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  let out = redactApiSourceRow(row as unknown as AnyRow);
  if ('api_key_name' in out && looksLikeSecretValue(out.api_key_name)) {
    out = { ...out, api_key_name: REDACTED_ENV_VAR_NAME };
  }
  // Round 26 (H-2 / S-9): secret-shaped map values, and OAuth ciphertext (never needed by a
  // client; replaced by a truthy marker so "is configured" checks keep working).
  for (const field of MAP_FIELDS) {
    if (field in out) {
      const redacted = redactSecretShapedMap(out[field]);
      if (redacted !== out[field]) out = { ...out, [field]: redacted };
    }
  }
  for (const field of CIPHERTEXT_FIELDS) {
    if (field in out && out[field]) out = { ...out, [field]: REDACTED_SECRET_VALUE };
  }
  const nested = out.user_access;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    out = { ...out, user_access: redactOne(nested as AnyRow) };
  }
  return out as unknown as T;
}

/**
 * Round 26 (H-3): redact a diagnostic message (provider error text, thrown error message)
 * before it is returned or persisted. Every value in `knownSecrets` (the credentials that
 * were actually sent) is cut out verbatim, then the generic free-text redaction runs, and the
 * result is bounded.
 */
export function redactDiagnosticMessage(
  message: unknown,
  knownSecrets: Iterable<string> = [],
  maxLength = 300,
): string {
  let text = typeof message === 'string' ? message : String(message ?? '');
  const secrets = Array.from(new Set(Array.from(knownSecrets).filter((s) => typeof s === 'string' && s.length >= 4)))
    .sort((a, b) => b.length - a.length);
  for (const s of secrets) text = text.split(s).join('[REDACTED]');
  text = redactSecretsInText(text);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Response-boundary redaction for external API source rows (and per-user access rows,
 * request rows, and a nested `user_access`). Returns new objects; never mutates the input.
 */
export function redactSourceCredentialFields<T>(input: T): T {
  if (Array.isArray(input)) return input.map((row) => redactOne(row)) as unknown as T;
  return redactOne(input);
}
