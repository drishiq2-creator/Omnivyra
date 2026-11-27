/**
 * Round 26 (Agent C) — credential-INPUT validation shared by the Super Admin UI and the
 * Super Admin write routes.
 *
 * Why this exists: the Super Admin catalog form used to say "paste the key directly or enter
 * env var name" for reference fields (`api_key_env_name`) and wrote Unsplash keys into the
 * row's `headers` JSON. Those fields are stored in plaintext and (for presets) served raw to
 * tenant roles. Production then held five raw provider keys in provider-account envelopes.
 *
 * Rules (shape only — this module never returns, logs or echoes a value):
 *   - a credential REFERENCE must be an environment-variable NAME (`isEnvVarName`);
 *   - a `headers` / `query_params` value may contain `{{NAME}}` templates and ordinary
 *     configuration text, but never a literal credential. A literal is rejected when it sits
 *     under a credential-named key (Authorization, api_key, key, token, secret, client_id …)
 *     or when it has a well-known secret shape anywhere;
 *   - a destination URL (`base_url`) must be http(s), carry no userinfo, and carry no
 *     credential in its query string.
 *
 * Pure and dependency-free apart from the shared env-name rule, so it runs in the browser
 * (client-side validation) and on the server (the route is the security boundary).
 */
import { isEnvVarName } from '../../backend/security/credentialSafety';

export { isEnvVarName };

const TEMPLATE_RE = /\{\{\s*[A-Za-z0-9_]+\s*\}\}/g;

/** Key names (normalised: lower-case, `-`/`_` removed) whose literal values are credentials. */
const CREDENTIAL_KEY_NAMES = new Set([
  'authorization', 'proxyauthorization', 'key', 'apikey', 'accesskey', 'secretkey', 'token',
  'accesstoken', 'authtoken', 'bearertoken', 'refreshtoken', 'idtoken', 'sessiontoken', 'secret',
  'clientsecret', 'clientid', 'password', 'passwd', 'signature', 'credential', 'credentials',
  'subscriptionkey', 'ocpapimsubscriptionkey', 'xapikey', 'xauthtoken', 'xaccesstoken',
]);

function isCredentialKeyName(key: string): boolean {
  if (/^_client_/i.test(key)) return true;
  const n = key.toLowerCase().replace(/[-_\s]/g, '');
  if (CREDENTIAL_KEY_NAMES.has(n)) return true;
  return /(apikey|secret|accesstoken|authtoken|password)$/.test(n);
}

/** Scheme words that may precede a template in a credential header (`Bearer {{API_KEY}}`). */
const SCHEME_WORDS_RE = /^(bearer|basic|token|key|apikey|api-key|client-id|client_id|otoken|sso-key)$/i;

/** Well-known secret shapes, flagged under ANY key name. */
const SECRET_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,            // OpenAI-style
  /\bAIza[0-9A-Za-z_-]{20,}/,           // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,       // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,     // Slack
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, // JWT
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/,
  /^[0-9a-f]{32,}$/i,                   // long hex API key
];

/** A long opaque token: >= 32 chars of key alphabet with both letters and digits, no spaces. */
function isLongOpaqueToken(value: string): boolean {
  return value.length >= 32 && /^[A-Za-z0-9._~+=-]+$/.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

/** True when `value` (a header or query value) carries a literal credential. Never echoes it. */
export function isSecretShapedConfigValue(key: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw) return false;
  if (SECRET_SHAPES.some((re) => re.test(raw))) return true;
  const literal = raw.replace(TEMPLATE_RE, ' ').trim();
  if (!literal) return false; // template-only, e.g. "{{API_KEY}}"
  if (isCredentialKeyName(key)) {
    // Under a credential-named key only scheme words may remain next to a template, and an
    // env-var NAME is tolerated (legacy `_client_*_env` stored names, never values).
    const words = literal.split(/\s+/).filter(Boolean);
    const onlySchemeWords = words.every((w) => SCHEME_WORDS_RE.test(w));
    const hadTemplate = literal !== raw;
    if (hadTemplate && onlySchemeWords) return false;
    if (!hadTemplate && words.length === 1 && isEnvVarName(words[0])) return false;
    return true;
  }
  return isLongOpaqueToken(literal);
}

/**
 * Names (never values) of the entries in a `headers` / `query_params` record that carry a
 * literal credential. Nested objects (e.g. `query_params._config`) are scanned for the
 * well-known secret shapes and credential-named keys too.
 */
export function findSecretShapedEntries(record: unknown, field: string): string[] {
  const out: string[] = [];
  const walk = (obj: unknown, path: string, depth: number) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 3) return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const p = `${path}.${k}`;
      if (v && typeof v === 'object') walk(v, p, depth + 1);
      else if (isSecretShapedConfigValue(k, v)) out.push(p);
    }
  };
  walk(record, field, 0);
  return out;
}

/** Header keys the old catalog form used to carry Unsplash keys; never sent by the new form. */
export const LEGACY_CLIENT_KEY_HEADERS = ['_client_id_env', '_client_secret_env'] as const;

export type CredentialInputProblem = { field: string; code: string; message: string };

/** Validate a credential REFERENCE field. `null`/empty is allowed (no reference). */
export function checkCredentialReference(field: string, value: unknown): CredentialInputProblem | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return { field, code: 'INVALID_ENV_VAR_NAME', message: `${field} must be an environment-variable name.` };
  if (!value.trim()) return null;
  if (isEnvVarName(value)) return null;
  return {
    field,
    code: 'INVALID_ENV_VAR_NAME',
    message: `${field} must be the NAME of an environment variable (for example SERPAPI_KEY), never the key itself. Store a key on the provider account's Credentials form, where it is encrypted at rest.`,
  };
}

/** Validate a `headers` / `query_params` object. */
export function checkConfigRecord(field: string, value: unknown): CredentialInputProblem | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { field, code: 'INVALID_CONFIG_RECORD', message: `${field} must be an object.` };
  }
  const offending = findSecretShapedEntries(value, field);
  if (offending.length === 0) return null;
  return {
    field,
    code: 'SECRET_IN_CONFIG',
    message: `${offending.join(', ')} looks like a literal credential. Use a {{ENV_VAR_NAME}} template here and store the key on the provider account's Credentials form.`,
  };
}

/** Validate a destination URL that platform credentials may be sent to. */
export function checkDestinationUrl(field: string, value: unknown): CredentialInputProblem | null {
  if (typeof value !== 'string' || !value.trim()) {
    return { field, code: 'INVALID_BASE_URL', message: `${field} is required.` };
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { field, code: 'INVALID_BASE_URL', message: `${field} must be an absolute http(s) URL.` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { field, code: 'INVALID_BASE_URL', message: `${field} must be an absolute http(s) URL.` };
  }
  if (url.username || url.password) {
    return { field, code: 'SECRET_IN_BASE_URL', message: `${field} must not contain user credentials.` };
  }
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { query[k] = v; });
  if (findSecretShapedEntries(query, `${field}?`).length > 0) {
    return { field, code: 'SECRET_IN_BASE_URL', message: `${field} must not carry a credential in its query string. Use a {{ENV_VAR_NAME}} template in query_params instead.` };
  }
  return null;
}
