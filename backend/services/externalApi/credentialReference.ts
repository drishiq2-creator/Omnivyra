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

function redactOne<T>(row: T): T {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  let out = redactApiSourceRow(row as unknown as AnyRow);
  if ('api_key_name' in out && looksLikeSecretValue(out.api_key_name)) {
    out = { ...out, api_key_name: REDACTED_ENV_VAR_NAME };
  }
  const nested = out.user_access;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    out = { ...out, user_access: redactApiSourceRow(nested as AnyRow) };
  }
  return out as unknown as T;
}

/**
 * Response-boundary redaction for external API source rows (and per-user access rows,
 * request rows, and a nested `user_access`). Returns new objects; never mutates the input.
 */
export function redactSourceCredentialFields<T>(input: T): T {
  if (Array.isArray(input)) return input.map((row) => redactOne(row)) as unknown as T;
  return redactOne(input);
}
