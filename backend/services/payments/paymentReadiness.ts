/**
 * Payment go-live readiness gate (b3 2026-11-20: the owner's go-live sitting must be "paste keys", and a mismatch must
 * FAIL CLOSED with a clear code - never a silent fallback to test keys).
 * Its own module on purpose: route suites factory-mock the orchestrator barrel, and a new export from a factory-mocked
 * module is `undefined` under test.
 *
 *   PAYMENT_PROVIDER_MODE invalid          -> { ok:false, code: PAYMENT_MODE_INVALID }
 *   live + any enabled provider incomplete -> { ok:false, code: PAYMENT_CONFIG_INVALID, missing names }
 *   test (or unset)                        -> ok (today's behaviour unchanged; per-provider routing still skips
 *                                             unconfigured providers)
 */
import { getActiveMode, validateConfiguredProviders, PaymentModeInvalidError } from './orchestrator/providerConfig';
import { PROVIDER_REGISTRY } from './orchestrator/providerRegistry';
import type { ProviderMode } from './orchestrator/types';

export type PaymentReadiness =
  | { ok: true; mode: ProviderMode }
  | { ok: false; code: 'PAYMENT_MODE_INVALID' | 'PAYMENT_CONFIG_INVALID'; detail: string };

export function checkPaymentReadiness(): PaymentReadiness {
  let mode: ProviderMode;
  try {
    mode = getActiveMode();
  } catch (e) {
    if (e instanceof PaymentModeInvalidError) return { ok: false, code: e.code, detail: e.message };
    throw e;
  }
  if (mode !== 'live') return { ok: true, mode };
  const v = validateConfiguredProviders(PROVIDER_REGISTRY, mode);
  return v.ok ? { ok: true, mode } : { ok: false, code: 'PAYMENT_CONFIG_INVALID', detail: v.errors.join('; ') };
}

/**
 * Why a payment webhook's signature was rejected (b3/7c 2026-11-20) - so an operator fixes the right thing:
 *   secret_unset       - no webhook secret for the active mode (configure it)
 *   mode_invalid       - PAYMENT_PROVIDER_MODE is invalid, so which secret applies is undeterminable (fix the env var)
 *   signature_mismatch - a secret exists but this delivery did not verify (wrong secret, or not the provider)
 */
export const WEBHOOK_REJECT_REASONS = ['secret_unset', 'mode_invalid', 'signature_mismatch'] as const;
export type WebhookRejectReason = (typeof WEBHOOK_REJECT_REASONS)[number];

export function classifyWebhookRejection(readWebhookSecret: () => string | undefined): WebhookRejectReason {
  let secret: string | undefined;
  try {
    secret = readWebhookSecret();
  } catch {
    return 'mode_invalid';
  }
  return secret ? 'signature_mismatch' : 'secret_unset';
}
