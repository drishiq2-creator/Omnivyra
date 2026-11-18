/**
 * Owed refunds (b3 rulings 2026-11-18, BLOCKING for billing; criteria from 7c; migration 20270217000061).
 *
 * "AUTO-REFUND" MEANS THE SYSTEM PAYS WITHOUT THE USER ACTING. When a charged work product cannot be returned, the
 * ORIGINAL charge is credited back. The debt is first recorded durably in billing_owed_refunds - ONE row per original
 * confirm transaction, enforced by a UNIQUE index (a concurrent completer run and a user retry: the loser gets 23505
 * and does nothing). The grant is then attempted at once; if it fails, the scheduled grant-only job
 * 'billing-owed-refund-complete' (completeOwedRefunds) pays it. Every grant is a forward 'grant' ledger entry via
 * createCredit keyed '<prefix>:<original confirm id>:<category>' (credit_transactions.idempotency_key is unique), so the
 * immediate attempt, a user retry and the job can never grant twice.
 *
 * GRANT-ONLY: nothing here releases a hold, so it is not behind the 053 hold-release gate (b3/7c). Keep it that way -
 * the moment this module releases anything it belongs behind the gate.
 * Protected orgs (Embrosales 73e5fa6f) are never auto-refunded: a critical anomaly asks for review instead.
 */
import { supabase } from '../../db/supabaseClient';
import { createCredit, type CreditCategory } from '../creditExecutionService';
import { logger } from '../logger';
import { emitAnomaly, emitFinancialAudit } from './billingAuditEmitter';
import { incrCounter } from './billingMetrics';

const TABLE = 'billing_owed_refunds';
export const PROTECTED_ORG_PREFIXES: readonly string[] = ['73e5fa6f'];
export const OWED_REFUND_MAX_ATTEMPTS = 10;
export const OWED_REFUND_JOB = 'billing-owed-refund-complete';

/** The credits an ORIGINAL confirm transaction consumed, per category. */
export type OriginalCharge = { confirmTxnId: string; free: number; paid: number; incentive: number };

export const totalOf = (c: { free: number; paid: number; incentive: number }) => c.free + c.paid + c.incentive;

/**
 * Strict read of the original confirm row by its idempotency key. THROWS on a read error (a null error is not an
 * answer); returns null when no confirm row exists for the key.
 */
export async function readOriginalCharge(confirmKey: string): Promise<OriginalCharge | null> {
  const { data, error } = await supabase
    .from('credit_transactions')
    .select('id, execution_phase, free_delta, paid_delta, incentive_delta')
    .eq('idempotency_key', confirmKey)
    .maybeSingle();
  if (error) throw new Error(`original charge read failed: ${error.message}`);
  const row = data as { id: string; execution_phase: string | null; free_delta: number | null; paid_delta: number | null; incentive_delta: number | null } | null;
  if (!row) return null;
  if (!['confirm', 'confirm_partial'].includes(String(row.execution_phase))) return null;
  return {
    confirmTxnId: row.id,
    free: Math.abs(Number(row.free_delta ?? 0)),
    paid: Math.abs(Number(row.paid_delta ?? 0)),
    incentive: Math.abs(Number(row.incentive_delta ?? 0)),
  };
}

type OwedRow = {
  organization_id: string; original_confirm_txn_id: string; free_credits: number; paid_credits: number;
  incentive_credits: number; reason: string; grant_key_prefix: string; performed_by: string; reference_id: string | null;
  attempts: number; status: 'owed' | 'granted';
};

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms))]);

/**
 * Write the grants for one owed row and mark it granted. Idempotent end to end: the grant keys are on the original
 * confirm id, and only the caller that flips owed -> granted audits. Throws on any failure (the row stays owed).
 */
async function payOwedRow(row: OwedRow, timeoutMs: number): Promise<number> {
  const parts: Array<[CreditCategory, number]> = [
    ['free', Number(row.free_credits)], ['paid', Number(row.paid_credits)], ['incentive', Number(row.incentive_credits)],
  ];
  for (const [category, amount] of parts) {
    if (!(amount > 0)) continue;
    await withTimeout(createCredit({
      orgId: row.organization_id, amount, category,
      referenceType: 'billing_refund', referenceId: row.original_confirm_txn_id,
      note: `Refund (${row.reason}) of original charge ${row.original_confirm_txn_id}`,
      performedBy: row.performed_by,
      idempotencyKey: `${row.grant_key_prefix}:${row.original_confirm_txn_id}:${category}`,
    }), timeoutMs, 'refund grant');
  }
  const total = parts.reduce((n, [, v]) => n + (v > 0 ? v : 0), 0);
  const { data, error } = await supabase
    .from(TABLE)
    .update({ status: 'granted', granted_at: new Date().toISOString(), last_error: null })
    .eq('original_confirm_txn_id', row.original_confirm_txn_id)
    .eq('status', 'owed')
    .select('original_confirm_txn_id');
  if (error) throw new Error(`owed refund mark-granted failed: ${error.message}`);
  if (Array.isArray(data) && data.length === 1) {
    incrCounter('owed_refund_granted_total');
    await emitFinancialAudit({
      actorUserId: row.performed_by, actionType: 'system_refund', organizationId: row.organization_id,
      amountCredits: total, reasonType: 'system', reason: row.reason,
      ledgerIdempotencyKey: `${row.grant_key_prefix}:${row.original_confirm_txn_id}`,
      metadata: { originalConfirmTxnId: row.original_confirm_txn_id, referenceId: row.reference_id },
    });
  }
  return total;
}

async function noteFailedAttempt(row: OwedRow, err: unknown): Promise<void> {
  incrCounter('owed_refund_grant_failed_total');
  const attempts = Number(row.attempts ?? 0) + 1;
  try {
    await supabase.from(TABLE).update({ attempts, last_error: String((err as Error)?.message ?? err).slice(0, 500) })
      .eq('original_confirm_txn_id', row.original_confirm_txn_id).eq('status', 'owed');
  } catch { /* the row stays owed either way; the next run retries */ }
  if (attempts >= OWED_REFUND_MAX_ATTEMPTS) {
    incrCounter('owed_refund_stuck_total');
    emitAnomaly({ organizationId: row.organization_id, kind: 'owed_refund_stuck', severity: 'critical', message: 'owed_refund_stuck',
      metadata: { originalConfirmTxnId: row.original_confirm_txn_id, attempts, reason: row.reason } });
  }
}

export type RefundOutcome =
  /** Paid now. */
  | { status: 'granted'; credits: number }
  /** Recorded as owed; the grant failed now and the job will pay it. The customer may be told it is being returned. */
  | { status: 'owed'; credits: number }
  /** The debt could not even be recorded (ERROR alert): the caller must answer 503 and promise nothing. */
  | { status: 'unrecorded' }
  /** A protected org: never auto-refunded (critical anomaly for review). */
  | { status: 'protected' };

/** Record the debt for an original charge, then try to pay it at once. Never throws. */
export async function refundOriginalCharge(a: {
  orgId: string; performedBy: string; charge: OriginalCharge; reason: string; grantKeyPrefix: string; referenceId?: string | null;
  grantTimeoutMs?: number;
}): Promise<RefundOutcome> {
  if (PROTECTED_ORG_PREFIXES.some((p) => a.orgId.toLowerCase().startsWith(p))) {
    emitAnomaly({ organizationId: a.orgId, kind: 'owed_refund_stuck', severity: 'critical', message: 'protected_org_refund_needs_review',
      metadata: { originalConfirmTxnId: a.charge.confirmTxnId, reason: a.reason } });
    return { status: 'protected' };
  }
  const credits = totalOf(a.charge);
  const row: OwedRow = {
    organization_id: a.orgId, original_confirm_txn_id: a.charge.confirmTxnId,
    free_credits: a.charge.free, paid_credits: a.charge.paid, incentive_credits: a.charge.incentive,
    reason: a.reason, grant_key_prefix: a.grantKeyPrefix, performed_by: a.performedBy, reference_id: a.referenceId ?? null,
    attempts: 0, status: 'owed',
  };
  try {
    if (!(credits > 0)) throw new Error('original charge moved no credits');
    const { error } = await supabase.from(TABLE).upsert(row, { onConflict: 'original_confirm_txn_id', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  } catch (err) {
    incrCounter('credit_refund_unrecorded_total');
    logger.error('credit_refund_unrecorded', { orgId: a.orgId, originalConfirmTxnId: a.charge.confirmTxnId, reason: a.reason, message: (err as Error)?.message });
    return { status: 'unrecorded' };
  }
  // The row now exists (ours or an earlier one): pay it from the DURABLE row's values, never from this request's.
  let stored: OwedRow | null = null;
  try {
    const { data, error } = await supabase.from(TABLE).select('*').eq('original_confirm_txn_id', a.charge.confirmTxnId).maybeSingle();
    if (error) throw new Error(error.message);
    stored = data as OwedRow | null;
    if (!stored) throw new Error('owed refund row not readable back');
    if (stored.organization_id !== a.orgId) throw new Error('owed refund row belongs to another org');
  } catch (err) {
    incrCounter('credit_refund_unrecorded_total');
    logger.error('credit_refund_unrecorded', { orgId: a.orgId, originalConfirmTxnId: a.charge.confirmTxnId, message: (err as Error)?.message });
    return { status: 'unrecorded' };
  }
  if (stored.status === 'granted') return { status: 'granted', credits: totalOf({ free: Number(stored.free_credits), paid: Number(stored.paid_credits), incentive: Number(stored.incentive_credits) }) };
  try {
    return { status: 'granted', credits: await payOwedRow(stored, a.grantTimeoutMs ?? 15_000) };
  } catch (err) {
    await noteFailedAttempt(stored, err);
    logger.warn('owed_refund_deferred_to_job', { orgId: a.orgId, originalConfirmTxnId: a.charge.confirmTxnId, message: (err as Error)?.message });
    return { status: 'owed', credits };
  }
}

/**
 * The grant-only completer (scheduled as 'billing-owed-refund-complete', ALWAYS_RUN). Pays owed rows oldest first,
 * bounded by a row limit and a wall-clock budget; each grant has its own timeout. Never releases a hold.
 */
export async function completeOwedRefunds(opts: { limit?: number; budgetMs?: number; grantTimeoutMs?: number } = {}):
  Promise<{ processed: number; granted: number; failed: number }> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 60_000;
  const { data, error } = await withTimeout(Promise.resolve(supabase.from(TABLE).select('*').eq('status', 'owed')
    .lt('attempts', OWED_REFUND_MAX_ATTEMPTS).order('created_at', { ascending: true }).limit(opts.limit ?? 50)), 15_000, 'owed refund read');
  if (error) throw new Error(`owed refund read failed: ${error.message}`);
  let granted = 0; let failed = 0; let processed = 0;
  for (const row of (data ?? []) as OwedRow[]) {
    if (Date.now() - started > budget) break;
    processed++;
    if (PROTECTED_ORG_PREFIXES.some((p) => String(row.organization_id).toLowerCase().startsWith(p))) continue;
    try { await payOwedRow(row, opts.grantTimeoutMs ?? 15_000); granted++; }
    catch (err) { failed++; await noteFailedAttempt(row, err); }
  }
  return { processed, granted, failed };
}
