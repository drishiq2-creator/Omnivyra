/**
 * A read that provider-invoice reconciliation depends on did NOT succeed (04, 2026-11-20; c6 handover, money).
 *
 * Before: every reconciler answered a failed usage_events read (and stripe its credit_purchases /
 * payment_transactions / billing_subscriptions reads) with an EMPTY list after a warn. Reconciliation then matched the
 * invoice against "no internal usage" and wrote APPEND-ONLY, immutable cost_reconciliation_adjustments attributing
 * the whole invoice as unaccounted. Worse, the read ran AFTER the provider_invoice_imports insert (the idempotency
 * marker), so the run could not be redone: a retry answered 'duplicate'.
 *
 * Now: a failed read throws this, and every reconciler performs its reads BEFORE the marker, so a failure writes
 * nothing and a retry starts clean. An empty read that SUCCEEDED is still a legitimate empty period.
 */
export class ReconciliationReadError extends Error {
  readonly code = 'RECONCILIATION_READ_FAILED';
  constructor(readonly provider: string, readonly table: string, readonly detail: string | null) {
    super(`${provider} reconciliation: ${table} read failed${detail ? `: ${detail}` : ''}`);
    this.name = 'ReconciliationReadError';
  }
}
