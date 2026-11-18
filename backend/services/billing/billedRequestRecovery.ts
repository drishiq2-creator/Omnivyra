/**
 * Billed request recovery - ONE implementation of the rules every billed generate-and-return path follows (b3 rulings
 * 2026-11-18 + 7c criteria; used by wirePhase2Route, runBilledAiCompletion and runReservedFixedWorkflow):
 *
 *   KEY        a billed request's identity is the client's Idempotency-Key. A key synthesised from a clock or a random
 *              value is not an idempotency key (7c): a path that requires one REFUSES without it (400), never mints one.
 *   PERSIST    the result is persisted - any durable write the route does, plus the billedResultStore copy, read back -
 *              INSIDE the executor, so the engine can only confirm a charge for a result that can be returned. Not
 *              persisted -> BilledResultUnpersistedError(value): the engine releases, the caller returns the work free.
 *   REPLAY     a same-key retry of a charged request replays the stored result. A read failure is 503 while the DURABLE
 *              count is below the terminal bound; TERMINAL -> the request's ORIGINAL charges are refunded by the system
 *              (owedRefunds) and it ends (409 RESULT_UNAVAILABLE, truthful text) - never an endless "try again".
 */
import type { BillingSurface } from './phase2EnforcementGate';
import { persistBilledResult, replayBilledResult } from './billedResultStore';
import { readOriginalCharge, refundOriginalCharge, type RefundOutcome } from './owedRefunds';
import { emitAnomaly } from './billingAuditEmitter';
import { logger } from '../logger';

/** The client's Idempotency-Key when usable (>= 8 chars after trim), else null. Never synthesises one. */
export function clientIdempotencyKey(header: unknown): string | null {
  const k = Array.isArray(header) ? header[0] : header;
  return typeof k === 'string' && k.trim().length >= 8 ? k.trim().slice(0, 200) : null;
}

export class BilledRouteKeyRequiredError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REQUIRED';
  readonly retryable = false;
  constructor(public readonly surface: BillingSurface | string) {
    super('An Idempotency-Key header (at least 8 characters, one per user action) is required for this billed request.');
    this.name = 'BilledRouteKeyRequiredError';
  }
}

/** A same-key request whose earlier attempt failed and was released (not charged): end the key; a new click is new. */
export class BilledRouteRequestEndedError extends Error {
  readonly code = 'REQUEST_ENDED';
  readonly retryable = false;
  constructor(public readonly surface: BillingSurface | string) {
    super('This request did not finish and was not charged. Start it again.');
    this.name = 'BilledRouteRequestEndedError';
  }
}

/** The stored result of an already-charged request could not be read (transient): retry with the same key. */
export class BilledRouteReplayUnavailableError extends Error {
  readonly code = 'REPLAY_UNAVAILABLE';
  readonly httpStatus = 503;
  readonly retryable = true;
  constructor(public readonly surface: BillingSurface | string) {
    super('We could not load the result of this request right now. Please try again.');
    this.name = 'BilledRouteReplayUnavailableError';
  }
}

/** The charged result cannot be returned: the original charge is refunded by the system; the text says what happened. */
export class BilledRouteResultUnavailableError extends Error {
  readonly code = 'RESULT_UNAVAILABLE';
  readonly retryable = false;
  constructor(public readonly surface: BillingSurface | string, public readonly refund: 'granted' | 'owed' | 'none' | 'protected', public readonly credits: number) {
    super(refund === 'granted' ? `We couldn't recover this result, so your ${credits} credits have been returned.`
      : refund === 'owed' ? `We couldn't recover this result, so your ${credits} credits are being returned to your account.`
      : refund === 'protected' ? "We couldn't recover this result. We will review the charge."
      : "We couldn't recover this result. You were not charged for it.");
    this.name = 'BilledRouteResultUnavailableError';
  }
}

/** The refund for an unrecoverable result could not be recorded yet: retry (nothing is promised). */
export class BilledRouteRefundPendingError extends Error {
  readonly code = 'REFUND_PENDING';
  readonly retryable = true;
  constructor(public readonly surface: BillingSurface | string) {
    super('We could not recover this result and could not record the refund yet. Please try again in a moment.');
    this.name = 'BilledRouteRefundPendingError';
  }
}

/** Internal carrier: the work finished but could not be persisted - the engine releases, the caller returns it free. */
export class BilledResultUnpersistedError extends Error {
  constructor(public readonly result: unknown) { super('billed result not persisted'); this.name = 'BilledResultUnpersistedError'; }
}

/**
 * Persist a result INSIDE the executor: the route's own durable write first (it must THROW on failure), then the
 * billedResultStore copy, read back. Any failure throws BilledResultUnpersistedError(value) so the charge releases.
 */
export async function persistBilledResultOrThrow(a: {
  scope: string; orgId: string; key: string; value: unknown; durableWrite?: () => Promise<void>;
}): Promise<void> {
  if (a.durableWrite) {
    try { await a.durableWrite(); } catch (err) {
      logger.error('billed_result_durable_write_failed', { scope: a.scope, orgId: a.orgId, message: (err as Error)?.message });
      throw new BilledResultUnpersistedError(a.value);
    }
  }
  if (!(await persistBilledResult({ scope: a.scope, orgId: a.orgId, key: a.key, value: a.value }))) {
    throw new BilledResultUnpersistedError(a.value);
  }
}

/**
 * Refund the ORIGINAL charges (by their confirm keys) of a request whose stored result cannot be returned. Each confirm
 * row is its own owed record. Returns the error to throw.
 */
export async function refundUnrecoverableCharges(a: {
  surface: BillingSurface | string; orgId: string; performedBy: string; confirmKeys: string[]; referenceId: string; grantKeyPrefix?: string;
}): Promise<Error> {
  emitAnomaly({ organizationId: a.orgId, kind: 'billed_result_lost', severity: 'critical', message: 'billed_result_lost', metadata: { surface: String(a.surface), referenceId: a.referenceId } });
  const outcomes: RefundOutcome[] = [];
  try {
    for (const confirmKey of a.confirmKeys) {
      const charge = await readOriginalCharge(confirmKey);
      if (!charge) continue;
      outcomes.push(await refundOriginalCharge({ orgId: a.orgId, performedBy: a.performedBy, charge, reason: 'billed_result_unavailable', grantKeyPrefix: a.grantKeyPrefix ?? 'billed_refund', referenceId: a.referenceId }));
    }
  } catch (err) {
    logger.error('billed_result_unavailable_charge_unreadable', { surface: a.surface, orgId: a.orgId, message: (err as Error)?.message });
    return new BilledRouteRefundPendingError(a.surface);
  }
  if (outcomes.some((o) => o.status === 'unrecorded')) return new BilledRouteRefundPendingError(a.surface);
  if (outcomes.some((o) => o.status === 'protected')) return new BilledRouteResultUnavailableError(a.surface, 'protected', 0);
  if (outcomes.length === 0) return new BilledRouteResultUnavailableError(a.surface, 'none', 0);
  const credits = outcomes.reduce((n, o) => n + ('credits' in o ? o.credits : 0), 0);
  return new BilledRouteResultUnavailableError(a.surface, outcomes.every((o) => o.status === 'granted') ? 'granted' : 'owed', credits);
}

/**
 * Before charging: replay a stored result for this identity. found -> the value; absent -> null (go on);
 * transient -> throws REPLAY_UNAVAILABLE; terminal -> refunds the original charges and throws the result error.
 */
export async function replayOrRefund(a: {
  surface: BillingSurface | string; scope: string; orgId: string; key: string; performedBy: string; confirmKeys: string[]; referenceId: string;
}): Promise<{ found: true; value: unknown } | null> {
  const r = await replayBilledResult({ scope: a.scope, orgId: a.orgId, key: a.key });
  if (r.kind === 'found') return { found: true, value: r.value };
  if (r.kind === 'absent') return null;
  if (r.kind === 'transient') throw new BilledRouteReplayUnavailableError(a.surface);
  throw await refundUnrecoverableCharges(a);
}
