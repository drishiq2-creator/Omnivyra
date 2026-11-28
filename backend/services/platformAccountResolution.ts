/**
 * Refusal codes for resolving the ONE social_accounts row an organization
 * sends through on a platform (see platformTokenService.resolveSocialAccountForOrg).
 *
 * Kept in its own dependency-free module so callers can classify the refusal
 * even where platformTokenService itself is module-mocked.
 */

export type PlatformAccountResolutionCode = 'PLATFORM_ACCOUNT_AMBIGUOUS' | 'PLATFORM_ACCOUNT_LOOKUP_FAILED';

/**
 * Thrown by platformTokenService.getToken when the (organization, platform)
 * account cannot be resolved to exactly one row. Callers MUST NOT send, and
 * must surface `code` rather than "not connected".
 */
export class PlatformAccountResolutionError extends Error {
  readonly code: PlatformAccountResolutionCode;
  constructor(code: PlatformAccountResolutionCode, message: string) {
    super(message);
    this.name = 'PlatformAccountResolutionError';
    this.code = code;
  }
}

/** The refusal code carried by `error` (matched by shape, not instanceof), else null. */
export function platformAccountResolutionCode(error: unknown): PlatformAccountResolutionCode | null {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'PLATFORM_ACCOUNT_AMBIGUOUS' || code === 'PLATFORM_ACCOUNT_LOOKUP_FAILED' ? code : null;
}
