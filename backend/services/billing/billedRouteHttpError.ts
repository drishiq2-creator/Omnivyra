/**
 * The STANDARD billed HTTP shape for every refusal a wirePhase2Route-billed route can raise (e9 2026-11-13: the UI's
 * shared helper shows ONE consistent "top up" / "already done" / "try again" message):
 *   402 { error, code: 'INSUFFICIENT_CREDITS', required?, balance? }   not enough credits
 *   402 { error, code: 'NO_CREDIT_ACCOUNT' }                           the organization has no credit account
 *   409 { error, code: 'ALREADY_PROCESSED' }   this exact request (same Idempotency-Key) was already charged and
 *                                               answered - it is NOT re-run for free
 *   500 { error, code: 'RECLAIM_CAP_EXHAUSTED', retryable: false }   every retry slot of this request failed
 *                                               uncharged - OUR failure (critical anomaly raised); start a new request
 *   503 { error, code: 'PRICING_UNAVAILABLE' } the action has no active price - a configuration gap, never "top up"
 *   503 { error, code: 'REPLAY_UNAVAILABLE', retryable: true }   an already-charged request's stored result could not
 *                                               be read - retry with the same key (never "start a new request")
 *   409 { error, code: 'RESULT_UNAVAILABLE', retryable: false }  the charged result cannot be returned (durable read
 *                                               failures): the original charge is refunded by the system; the text says
 *                                               'have been returned' / 'are being returned' / 'not charged' truthfully
 *   503 { error, code: 'REFUND_PENDING', retryable: true }   the refund could not be recorded yet - retry; nothing promised
 * Returns null for any other error - the route's own handling applies.
 */
import { PaymentRequiredError } from './phase2EnforcementGate';
import {
  BilledRouteAlreadyProcessedError,
  BilledRouteReclaimExhaustedError,
  BilledRoutePaymentRequiredError,
  BilledRoutePricingUnavailableError,
  BilledRouteReplayUnavailableError,
  BilledRouteResultUnavailableError,
  BilledRouteRefundPendingError,
} from './phase2RouteWiring';

export type BilledRouteHttpBody = { error: string; code: string; required?: number; balance?: number; retryable?: boolean };

export function billedRouteHttpError(err: unknown): { status: number; body: BilledRouteHttpBody } | null {
  if (err instanceof BilledRoutePaymentRequiredError) {
    const body: BilledRouteHttpBody = { error: err.message, code: err.billedCode };
    if (typeof err.required === 'number') body.required = err.required;
    if (typeof err.balance === 'number') body.balance = err.balance;
    return { status: 402, body };
  }
  if (err instanceof PaymentRequiredError) {
    // the gate / admission boundary: insufficient credits without a measured balance
    return { status: 402, body: { error: err.message, code: 'INSUFFICIENT_CREDITS' } };
  }
  if (err instanceof BilledRouteAlreadyProcessedError) {
    return { status: 409, body: { error: err.message, code: 'ALREADY_PROCESSED' } };
  }
  if (err instanceof BilledRouteReclaimExhaustedError) {
    return { status: 500, body: { error: err.message, code: 'RECLAIM_CAP_EXHAUSTED', retryable: false } };
  }
  if (err instanceof BilledRouteResultUnavailableError) {
    return { status: 409, body: { error: err.message, code: 'RESULT_UNAVAILABLE', retryable: false } };
  }
  if (err instanceof BilledRouteRefundPendingError) {
    return { status: 503, body: { error: err.message, code: 'REFUND_PENDING', retryable: true } };
  }
  if (err instanceof BilledRouteReplayUnavailableError) {
    return { status: 503, body: { error: err.message, code: 'REPLAY_UNAVAILABLE', retryable: true } };
  }
  if (err instanceof BilledRoutePricingUnavailableError) {
    return { status: 503, body: { error: err.message, code: 'PRICING_UNAVAILABLE' } };
  }
  return null;
}
