/**
 * Canonical billing amount-resolution service (HIDDEN, server-side only).
 *
 * Resolves a checkout amount + currency from a plan_reference (subscription)
 * or topup_reference (topup). DB-BACKED: reads the hidden operator-managed
 * `hidden_billing_catalog` table (migration 20260717).
 *
 * FAIL CLOSED (PL-114, b3 ruling 2026-11-20): an unreadable catalog (absent table, DB error, thrown client) THROWS
 * AmountSourceUnavailableError - checkout answers 503 PRICE_CATALOG_UNAVAILABLE and creates no provider session. A
 * customer never pays a price we did not read. (Before: a compiled-in COMPILED_FALLBACK mirroring the 20260717 seed
 * priced the checkout - stale by design once the new pricing release lands. Deleted; checkout was its only consumer.)
 * Every occurrence is logged at error level and counted durably (system_health_metrics billing/price_catalog_unavailable).
 *
 * HIDDEN-PRICING — STRICT:
 *   - No pricing source is ever exported. The resolver returns ONLY
 *     { amount, currency } and only to the server-side orchestrator.
 *   - Never serialized into an API response, billing shell, frontend state,
 *     provider discovery, query params, or logs.
 *
 * Deterministic: same reference → same result (the DB row / fallback entry is
 * the single source of truth). Rejection behavior preserved exactly:
 * malformed_reference / unknown_reference / disabled_reference.
 *
 * NO live settlement, NO ledger mutation, NO invoice generation — resolves a
 * number, nothing more.
 */

import { supabase } from '../../../db/supabaseClient';
import { logger } from '../../logger';
import { recordMetric } from '../../systemHealthMetricsService';

export type BillingReferenceKind = 'subscription' | 'topup';

export interface ResolvedBillingAmount {
  /** Major-currency-unit amount (the provider adapter handles sub-unit conversion). */
  amount: number;
  /** ISO-4217. */
  currency: string;
}

export type ResolveAmountResult =
  | { ok: true; amount: ResolvedBillingAmount }
  | { ok: false; code: 'unknown_reference' | 'disabled_reference' | 'malformed_reference'; reason: string };

interface CatalogEntry {
  kind: BillingReferenceKind;
  amount_minor: number;
  currency: string;
  enabled: boolean;
}

/** Reference identifier shape — lowercase, alphanumeric + underscore, 3-64 chars. */
const REFERENCE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

/** ISO-4217 zero-decimal currencies (no minor unit). */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'XOF', 'XAF']);

function minorToMajor(minor: number, currency: string): number {
  const m = Math.max(0, Math.round(minor) || 0);
  return ZERO_DECIMAL.has(currency.trim().toUpperCase()) ? m : m / 100;
}

/** The price catalog could not be read. Checkout must not proceed (PL-114). */
export class AmountSourceUnavailableError extends Error {
  readonly code = 'PRICE_CATALOG_UNAVAILABLE';
  constructor(detail: string) {
    super(`price catalog could not be read: ${detail}`);
    this.name = 'AmountSourceUnavailableError';
  }
}

async function catalogUnavailable(referenceKey: string, detail: string): Promise<never> {
  logger.error('hidden_billing_catalog_unavailable', { reference: referenceKey, message: detail });
  // Durable + alertable (b3 condition): a long catalog outage must be seen, not inferred from missing sales.
  await recordMetric('billing', 'price_catalog_unavailable', 1, 'count', { message: detail.slice(0, 300) });
  throw new AmountSourceUnavailableError(detail);
}

/**
 * Single read path. Returns the catalog entry for `referenceKey`, or null when the table was READ and has no such row.
 * Any failure to read THROWS AmountSourceUnavailableError (never a guessed price).
 */
async function readCatalogEntry(referenceKey: string): Promise<CatalogEntry | null> {
  let data: unknown;
  try {
    const res = await supabase
      .from('hidden_billing_catalog')
      .select('kind, amount_minor, currency, enabled')
      .eq('reference_key', referenceKey)
      .maybeSingle();
    if (res.error) return await catalogUnavailable(referenceKey, String(res.error.message ?? 'read error'));
    data = res.data;
  } catch (err) {
    if (err instanceof AmountSourceUnavailableError) throw err;
    return await catalogUnavailable(referenceKey, err instanceof Error ? err.message : String(err));
  }
  if (!data) return null; // table read, no such reference -> unknown
  const row = data as Record<string, unknown>;
  return {
    kind: String(row.kind ?? '') as BillingReferenceKind,
    amount_minor: Number(row.amount_minor ?? 0) || 0,
    currency: String(row.currency ?? ''),
    enabled: row.enabled === true,
  };
}

/**
 * Resolve { amount, currency } for a plan/topup reference. DB-backed, deterministic. THROWS
 * AmountSourceUnavailableError when the catalog cannot be read (PL-114).
 *
 *  - malformed reference (shape mismatch)   → malformed_reference
 *  - unknown reference / kind mismatch      → unknown_reference
 *  - retired (enabled=false) plan/topup     → disabled_reference
 */
export async function resolveBillingAmount(args: {
  intentType: BillingReferenceKind;
  reference: string;
}): Promise<ResolveAmountResult> {
  const ref = typeof args.reference === 'string' ? args.reference.trim() : '';

  if (!REFERENCE_PATTERN.test(ref)) {
    return { ok: false, code: 'malformed_reference', reason: 'reference does not match the expected identifier shape' };
  }

  const entry = await readCatalogEntry(ref);
  if (!entry) {
    return { ok: false, code: 'unknown_reference', reason: `no pricing entry for reference: ${ref}` };
  }
  if (entry.kind !== args.intentType) {
    return { ok: false, code: 'unknown_reference', reason: `reference ${ref} is not a ${args.intentType} reference` };
  }
  if (!entry.enabled) {
    return { ok: false, code: 'disabled_reference', reason: `reference ${ref} is retired/disabled` };
  }

  return {
    ok: true,
    amount: { amount: minorToMajor(entry.amount_minor, entry.currency), currency: entry.currency },
  };
}
