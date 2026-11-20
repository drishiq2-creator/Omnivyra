/**
 * Section D — provider credentials + mode + startup validation.
 *
 * Mode is resolved from env (`PAYMENT_PROVIDER_MODE`), DEFAULT 'test'. Each mode
 * has its own credential env vars; validation requires the keys for the ACTIVE
 * mode (test keys in test, live keys in live) and fails fast on missing creds.
 *
 * `assertConfiguredProvidersOrThrow` is intentionally NOT called from global
 * bootstrap (that would crash key-less environments). Call at orchestrator init.
 *
 * Live mode is ARCHITECTURE ONLY — it is never enabled here; default stays test.
 */
import type { PaymentProvider, PaymentProviderId, ProviderMode } from './types';

/** PAYMENT_PROVIDER_MODE holds something other than 'test' / 'live' (go-live readiness, c6 2026-11-20). */
export class PaymentModeInvalidError extends Error {
  readonly code = 'PAYMENT_MODE_INVALID';
  constructor(raw: string) {
    super(`PAYMENT_PROVIDER_MODE must be 'test' or 'live' (got ${JSON.stringify(raw.slice(0, 20))})`);
    this.name = 'PaymentModeInvalidError';
  }
}

/**
 * Active provider mode. UNSET/empty = 'test' (unchanged default). Exactly 'test' or 'live' (no trim, case-sensitive) are
 * accepted; ANY OTHER value THROWS PaymentModeInvalidError. It used to mean 'test' silently - so 'LIVE', 'production'
 * or a typo in a go-live env ran TEST keys in production with no signal (b3: never silently fall back to test keys).
 */
export function getActiveMode(): ProviderMode {
  const raw = process.env.PAYMENT_PROVIDER_MODE;
  if (raw === undefined || raw === '') return 'test';
  // EXACT match - no trimming or case folding: 'live ' / 'LIVE' are near-misses and must neither become live (TEST 10)
  // nor silently become test. They are refused with a code an operator can act on.
  if (raw === 'test' || raw === 'live') return raw;
  throw new PaymentModeInvalidError(raw);
}

export interface ProviderCredentials {
  keyId?: string;
  keySecret?: string;
  webhookSecret?: string;
}

interface CredEnv { id: string; secret: string; webhook: string }

export const CRED_ENV: Record<ProviderMode, Partial<Record<PaymentProviderId, CredEnv>>> = {
  test: {
    razorpay: { id: 'RAZORPAY_TEST_KEY_ID', secret: 'RAZORPAY_TEST_KEY_SECRET', webhook: 'RAZORPAY_WEBHOOK_SECRET' },
    cashfree: { id: 'CASHFREE_TEST_APP_ID', secret: 'CASHFREE_TEST_SECRET_KEY', webhook: 'CASHFREE_WEBHOOK_SECRET' },
  },
  live: {
    razorpay: { id: 'RAZORPAY_LIVE_KEY_ID', secret: 'RAZORPAY_LIVE_KEY_SECRET', webhook: 'RAZORPAY_LIVE_WEBHOOK_SECRET' },
    cashfree: { id: 'CASHFREE_PROD_APP_ID', secret: 'CASHFREE_PROD_SECRET_KEY', webhook: 'CASHFREE_PROD_WEBHOOK_SECRET' },
  },
};

export function getProviderCredentials(id: PaymentProviderId, mode: ProviderMode = getActiveMode()): ProviderCredentials {
  const env = CRED_ENV[mode]?.[id];
  if (!env) return {};
  return {
    keyId: process.env[env.id],
    keySecret: process.env[env.secret],
    webhookSecret: WEBHOOK_SIGNED_WITH_CLIENT_SECRET.has(id)
      ? process.env[env.webhook] ?? process.env[env.secret]
      : process.env[env.webhook],
  };
}

/**
 * SEC91-B13: only providers that sign webhooks WITH the API client secret may
 * fall back to it. Cashfree does (by design). Razorpay signs with the separate
 * webhook secret set in its dashboard, so falling back to the API key secret
 * conflated two credentials; an unset Razorpay webhook secret now verifies
 * nothing (verifyWebhookSignature → false).
 */
const WEBHOOK_SIGNED_WITH_CLIENT_SECRET: ReadonlySet<PaymentProviderId> = new Set<PaymentProviderId>(['cashfree']);

export function isProviderConfigured(id: PaymentProviderId, mode: ProviderMode = getActiveMode()): boolean {
  const c = getProviderCredentials(id, mode);
  return Boolean(c.keyId && c.keySecret);
}

export interface ConfigValidation {
  mode: ProviderMode;
  ok: boolean;
  errors: string[];
  configured: PaymentProviderId[];
  missing: PaymentProviderId[];
}

/**
 * Env NAMES (never values) a provider needs in `mode`. In LIVE a provider that signs webhooks with a SEPARATE secret
 * (razorpay) also needs that webhook secret: without it every webhook is rejected and a paid order depends on the
 * browser's verify call alone. Cashfree signs with its client secret by design, so its webhook name is optional.
 */
export function requiredEnvNames(id: PaymentProviderId, mode: ProviderMode): string[] {
  const env = CRED_ENV[mode]?.[id];
  if (!env) return [];
  const names = [env.id, env.secret];
  if (mode === 'live' && !WEBHOOK_SIGNED_WITH_CLIENT_SECRET.has(id)) names.push(env.webhook);
  return names;
}

/** Validate each ENABLED provider has its required credentials for the active mode. */
export function validateConfiguredProviders(providers: PaymentProvider[], mode: ProviderMode = getActiveMode()): ConfigValidation {
  const errors: string[] = [];
  const configured: PaymentProviderId[] = [];
  const missing: PaymentProviderId[] = [];

  for (const p of providers.filter((x) => x.enabled)) {
    const absent = requiredEnvNames(p.provider_id, mode).filter((n) => !(process.env[n] ?? '').trim());
    if (mode === 'live' && absent.length > 0) {
      missing.push(p.provider_id);
      errors.push(`Provider '${p.provider_id}' enabled in live mode but missing: ${absent.join(', ')}`);
      continue;
    }
    // Mirror of razorpayAdapter's test-mode guard: a TEST key in the LIVE slot is a misconfiguration, not a live setup.
    if (mode === 'live' && p.provider_id === 'razorpay' && (process.env[CRED_ENV.live.razorpay!.id] ?? '').trim().startsWith('rzp_test_')) {
      missing.push(p.provider_id);
      errors.push(`Provider 'razorpay' in live mode has a TEST key id in ${CRED_ENV.live.razorpay!.id}`);
      continue;
    }
    if (isProviderConfigured(p.provider_id, mode)) {
      configured.push(p.provider_id);
    } else {
      missing.push(p.provider_id);
      const env = CRED_ENV[mode]?.[p.provider_id];
      errors.push(`Provider '${p.provider_id}' enabled in ${mode} mode but missing credentials: ${env ? `${env.id}, ${env.secret}` : '(no mode mapping)'}`);
    }
  }
  return { mode, ok: errors.length === 0, errors, configured, missing };
}

/** Fail-fast. Call at orchestrator init / opt-in startup — NOT global bootstrap. */
export function assertConfiguredProvidersOrThrow(providers: PaymentProvider[], mode: ProviderMode = getActiveMode()): void {
  const v = validateConfiguredProviders(providers, mode);
  if (!v.ok) {
    throw new Error(`[paymentOrchestrator] provider configuration invalid (${mode}):\n - ${v.errors.join('\n - ')}`);
  }
}
