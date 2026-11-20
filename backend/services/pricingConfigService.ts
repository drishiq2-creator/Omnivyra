/**
 * Pricing configuration — DB-backed FX rates, market overrides, and plan pricing
 * (Super-Admin managed). Reads from billing_fx_rates / billing_price_overrides /
 * billing_plan_pricing and assembles an `FxConfig` for the currency resolver.
 *
 * FX: a FAILED read of billing_fx_rates or billing_price_overrides THROWS PriceConfigUnavailableError (c6 2026-11-20,
 * b3 ruling, same as PL-114): it used to answer DEFAULT_FX, or silently drop every per-SKU override, so a live top-up
 * could be charged a price we did not read. Successfully-read but EMPTY rates still answer DEFAULT_FX (unchanged -
 * that is "not configured", not "unreadable"). No hardcoded rates once the tables are seeded.
 *
 * Charge currency is INR only (Razorpay). USD/EUR are display-only.
 */
import { supabase } from '../db/supabaseClient';
import { DEFAULT_FX, CURRENCIES, CANONICAL_CURRENCY, type FxConfig, type Currency } from '@/lib/billing/currency';
import { logger } from './logger';
import { recordMetric } from './systemHealthMetricsService';

/** The FX rates / price overrides could not be read. A checkout must not be priced (b3 ruling 2026-11-20). */
export class PriceConfigUnavailableError extends Error {
  readonly code = 'PRICE_CONFIG_UNAVAILABLE';
  constructor(detail: string) {
    super(`price configuration could not be read: ${detail}`);
    this.name = 'PriceConfigUnavailableError';
  }
}

async function priceConfigUnavailable(detail: string): Promise<never> {
  logger.error('pricing_fx_config_unavailable', { message: detail });
  // Durable + alertable. NOT awaited (7c): this runs exactly when the database is unhealthy, and the refusal must stay a
  // fast 503, not wait on an insert. recordMetric never throws (a9 d934fbe99, load-bearing contract).
  void recordMetric('billing', 'price_config_unavailable', 1, 'count', { message: detail.slice(0, 300) });
  throw new PriceConfigUnavailableError(detail);
}

/** Assemble the live FxConfig (rates + market overrides). THROWS PriceConfigUnavailableError if either read fails.
 *  Rates missing from the table are filled from DEFAULT_FX - acceptable for DISPLAY only (see getChargeFxConfig). */
export async function getFxConfig(): Promise<FxConfig> {
  return (await readFxConfig()).config;
}

/** Display: the config plus whether any displayed rate is a code default rather than a configured rate. */
export async function getFxDisplayConfig(): Promise<FxConfig & { estimate: boolean }> {
  const { config, configured } = await readFxConfig();
  return { ...config, estimate: CURRENCIES.some((c) => c !== CANONICAL_CURRENCY && !configured.has(c)) };
}

/**
 * CHARGE path (b3 ruling 2026-11-20): the config for pricing `sku` in `currency`, refusing anything we did not read.
 * Fine: a configured override for (sku, currency); a USD charge (canonical, no rate). Otherwise the rate for `currency`
 * must be a CONFIGURED row (finite, > 0) - an empty or partial table answers PriceConfigUnavailableError instead of
 * DEFAULT_FX (resolvePrice would also silently use `?? 1` for a missing rate).
 */
export async function getChargeFxConfig(currency: Currency, sku?: string): Promise<FxConfig> {
  const { config, configured } = await readFxConfig();
  const override = sku ? config.overrides?.[sku]?.[currency] : undefined;
  if (override != null && Number.isFinite(override) && override > 0) return config;
  if (currency === CANONICAL_CURRENCY) return config;
  if (!configured.has(currency)) return await priceConfigUnavailable(`no configured ${currency} rate`);
  return config;
}

async function readFxConfig(): Promise<{ config: FxConfig; configured: Set<Currency> }> {
  let rateRows: unknown[] | null;
  let overrideRows: unknown[] | null;
  try {
    const [rates, overrides] = await Promise.all([
      supabase.from('billing_fx_rates').select('currency, rate, updated_at'),
      supabase.from('billing_price_overrides').select('sku, currency, amount'),
    ]);
    if (rates.error) return await priceConfigUnavailable(`billing_fx_rates: ${rates.error.message}`);
    // An unread override table is NOT "no overrides": a SKU with an override would be charged the computed price.
    if (overrides.error) return await priceConfigUnavailable(`billing_price_overrides: ${overrides.error.message}`);
    rateRows = rates.data as unknown[] | null;
    overrideRows = overrides.data as unknown[] | null;
  } catch (err) {
    if (err instanceof PriceConfigUnavailableError) throw err;
    return await priceConfigUnavailable(err instanceof Error ? err.message : String(err));
  }
  const configured = new Set<Currency>();
  // read OK, nothing configured: defaults (display may use them; the charge path refuses - getChargeFxConfig)
  if (!rateRows || rateRows.length === 0) return { config: DEFAULT_FX, configured };

  const rates: Record<Currency, number> = { ...DEFAULT_FX.rates };
  let updatedAt: string | undefined;
  for (const r of rateRows as Array<{ currency: string; rate: number; updated_at?: string }>) {
    const value = Number(r.rate);
    rates[r.currency as Currency] = value;
    if (Number.isFinite(value) && value > 0) configured.add(r.currency as Currency);
    if (r.updated_at && (!updatedAt || r.updated_at > updatedAt)) updatedAt = r.updated_at;
  }

  const overrides: NonNullable<FxConfig['overrides']> = {};
  for (const o of (overrideRows ?? []) as Array<{ sku: string; currency: string; amount: number }>) {
    (overrides[o.sku] ??= {})[o.currency as Currency] = Number(o.amount);
  }

  return { config: { rates, overrides, updatedAt }, configured };
}

export interface PlanPricing {
  plan_key: string;
  founder_usd: number;
  regular_usd: number | null;
  active: boolean;
}

export async function getPlanPricing(): Promise<PlanPricing[]> {
  try {
    const { data } = await supabase
      .from('billing_plan_pricing')
      .select('plan_key, founder_usd, regular_usd, active');
    return (data ?? []) as PlanPricing[];
  } catch {
    return [];
  }
}

// ── Super-Admin setters ──────────────────────────────────────────────────────

export async function setFxRate(currency: Currency, rate: number, updatedBy?: string) {
  return supabase.from('billing_fx_rates').upsert({
    currency, rate, updated_by: updatedBy ?? null, updated_at: new Date().toISOString(),
  });
}

export async function setPriceOverride(sku: string, currency: Currency, amount: number | null, updatedBy?: string) {
  if (amount == null) {
    return supabase.from('billing_price_overrides').delete().eq('sku', sku).eq('currency', currency);
  }
  return supabase.from('billing_price_overrides').upsert({
    sku, currency, amount, updated_by: updatedBy ?? null, updated_at: new Date().toISOString(),
  });
}

export async function setPlanPricing(
  planKey: string,
  founderUsd: number,
  regularUsd: number | null,
  active = true,
  updatedBy?: string,
) {
  return supabase.from('billing_plan_pricing').upsert({
    plan_key: planKey, founder_usd: founderUsd, regular_usd: regularUsd, active,
    updated_by: updatedBy ?? null, updated_at: new Date().toISOString(),
  });
}
