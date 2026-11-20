/**
 * A security-relevant READ failed (b3 2026-11-20, BLOCKING: dropped postgrest errors made security reads fail OPEN).
 *
 * ownedDbTable / supabase never throw on a postgrest error - the error comes back in `{ error }`. A repository that
 * destructured only `{ data }` turned a failed read into "no row" (null / []), and callers then decided on that:
 * e.g. "no MFA factor" -> login without the MFA challenge. Every backend/security repository read now checks `error`
 * and throws this instead, so a failure can never read as absence; callers' fail-closed catch blocks become live.
 */
export const SECURITY_READ_FAILED = 'SECURITY_READ_FAILED';

export class SecurityReadError extends Error {
  readonly code = SECURITY_READ_FAILED;
  readonly retryable = true;
  constructor(readonly operation: string, readonly table: string, readonly causeMessage: string | null) {
    super(`${SECURITY_READ_FAILED}:${table}:${operation}${causeMessage ? `:${causeMessage}` : ''}`);
    this.name = 'SecurityReadError';
  }
}

/** Throw if a postgrest result carries an error; returns nothing (callers then read `data`). */
export function throwOnSecurityReadError(
  result: { error?: { message?: string } | null },
  operation: string,
  table: string,
): void {
  if (result.error) throw new SecurityReadError(operation, table, result.error.message ?? null);
}
