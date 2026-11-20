/**
 * Integration secrets are visible to company ADMINS only (04, 2026-11-20).
 *
 * GET /api/integrations and GET /api/integrations/[id] are open to every company member, and the integration they
 * return is HYDRATED: `config` carries the decrypted connection credentials (integrationService.hydrateIntegration ->
 * integrationCredentialService.mergeConnectionConfig). The list handler's comment said "Mask sensitive config fields
 * for non-admins" but nothing masked them, so any member could read a CMS admin key or a webhook secret.
 *
 * This module is the mechanism that comment promised. A non-admin gets every secret-named key replaced by
 * REDACTED_SECRET in BOTH `config` and `non_secret_config` (the latter falls back to the legacy `config` column, which
 * can still hold plaintext secrets on un-migrated rows). An empty value stays empty, so "no secret configured" is
 * still distinguishable from "a secret you may not see".
 */
import { SECRET_CONFIG_KEYS } from './integrationCredentialService';

export const REDACTED_SECRET = '********';

/**
 * The named set is authoritative for what the credential store splits out. The NAME pattern is the backstop for a key
 * that set never listed (a new provider's `consumer_secret`, a legacy `token`): for a non-admin, over-masking a
 * harmless field costs a display; under-masking leaks a credential.
 */
const SECRET_NAME = /(secret|token|password|passwd|api_?key|private_?key|credential)/i;

export function isSecretConfigKey(key: string): boolean {
  return SECRET_CONFIG_KEYS.has(key) || SECRET_NAME.test(key);
}

function redactMap(map: unknown): unknown {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return map;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    const hasValue = value !== undefined && value !== null && value !== '';
    out[key] = isSecretConfigKey(key) && hasValue ? REDACTED_SECRET : value;
  }
  return out;
}

export function redactIntegrationSecrets<T extends { config?: unknown; non_secret_config?: unknown }>(integration: T): T {
  return {
    ...integration,
    config: redactMap(integration.config),
    non_secret_config: redactMap(integration.non_secret_config),
  } as T;
}

/**
 * Write-side guard: a redacted placeholder coming BACK in an update means "unchanged", never a new secret. Without it,
 * an edit form prefilled from a redacted read (e.g. an admin whose role read failed, which answers redacted) would
 * save '********' over the real credential. The existing value is kept; if there is none, the key is dropped.
 */
export function restoreRedactedSecrets(
  incoming: Record<string, string>,
  existing: Record<string, string> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...incoming };
  for (const [key, value] of Object.entries(out)) {
    if (value !== REDACTED_SECRET) continue;
    const kept = existing?.[key];
    if (typeof kept === 'string' && kept !== '' && kept !== REDACTED_SECRET) out[key] = kept;
    else delete out[key];
  }
  return out;
}

/** The same roles the write paths admit (enforceRole allowedRoles [COMPANY_ADMIN, SUPER_ADMIN]; ADMIN normalises). */
export function canViewIntegrationSecrets(role: string | null | undefined): boolean {
  return role === 'COMPANY_ADMIN' || role === 'SUPER_ADMIN';
}
