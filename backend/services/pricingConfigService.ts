/**
 * Pricing configuration — DB-backed FX rates, market overrides, and plan pricing
 * (Super-Admin managed). Reads from billing_fx_rates / billing_price_overrides /
 * billing_plan_pricing and assembles an `FxConfig` for the currency resolver.
 *
 * Fallback: if the tables/rows are absent (pre-migration), returns the code
 * defaults (DEFAULT_FX / commercialPlans) so nothing breaks. No hardcoded rates
 * once the tables are seeded.
 *
 * Charge currency is INR only (Razorpay). USD/EUR are display-only.
 */
import { supabase } from '../db/supabaseClient';
import { DEFAULT_FX, type FxConfig, type Currency } from '@/lib/billing/currency';

/**
 * Reads contract (B4, e9 ruling): a CHARGE / price path has no real rate to price with - the FX or override read failed,
 * or no rate is configured for the charge currency. Typed and retryable; the caller refuses (503 + Retry-After) BEFORE
 * any purchase row or provider order exists. DEFAULT_FX is for DISPLAY only - a charge is never priced at it.
 */
export class PricingUnavailableError extends Error {
  readonly code = 'PRICING_UNAVAILABLE' as const;
  readonly retryable = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'PricingUnavailableError';
  }
}

type RateRow = { currency: string; rate: number; updated_at?: string };
type OverrideRow = { sku: string; currency: string; amount: number };

function buildFxConfig(rateRows: RateRow[], overrideRows: OverrideRow[]): FxConfig {
  const rates: Record<Currency, number> = { ...DEFAULT_FX.rates };
  let updatedAt: string | undefined;
  for (const r of rateRows) {
    rates[r.currency as Currency] = Number(r.rate);
    if (r.updated_at && (!updatedAt || r.updated_at > updatedAt)) updatedAt = r.updated_at;
  }
  const overrides: NonNullable<FxConfig['overrides']> = {};
  for (const o of overrideRows) {
    (overrides[o.sku] ??= {})[o.currency as Currency] = Number(o.amount);
  }
  return { rates, overrides, updatedAt };
}

/**
 * The FxConfig a CHARGE may be priced with (B4, e9 ruling). Refuses with PricingUnavailableError when either read
 * fails (error object or thrown), or when no real rate row exists for the charge currency (empty table included) - a
 * charge is never priced at DEFAULT_FX, and market overrides are never silently dropped. Charge paths MUST use this,
 * never getFxConfig (pinned by test).
 */
export async function getFxConfigForCharge(chargeCurrency: Currency): Promise<FxConfig> {
  let rateRes: { data: unknown; error: { message?: string } | null };
  let overrideRes: { data: unknown; error: { message?: string } | null };
  try {
    [rateRes, overrideRes] = await Promise.all([
      supabase.from('billing_fx_rates').select('currency, rate, updated_at'),
      supabase.from('billing_price_overrides').select('sku, currency, amount'),
    ]) as any;
  } catch (err) {
    throw new PricingUnavailableError(`pricing read failed: ${(err as Error)?.message ?? 'error'}`);
  }
  if (rateRes?.error) throw new PricingUnavailableError(`billing_fx_rates read failed: ${rateRes.error.message ?? 'error'}`);
  if (overrideRes?.error) throw new PricingUnavailableError(`billing_price_overrides read failed: ${overrideRes.error.message ?? 'error'}`);
  const rateRows = (rateRes?.data ?? []) as RateRow[];
  const usdBase = chargeCurrency === 'USD';
  if (!usdBase && !rateRows.some((r) => r.currency === chargeCurrency && Number.isFinite(Number(r.rate)) && Number(r.rate) > 0)) {
    throw new PricingUnavailableError(`no configured FX rate for ${chargeCurrency}`);
  }
  return buildFxConfig(rateRows, (overrideRes?.data ?? []) as OverrideRow[]);
}

/** Assemble the live FxConfig (rates + market overrides) for DISPLAY. Falls back to defaults - never for a charge. */
export async function getFxConfig(): Promise<FxConfig> {
  try {
    const [{ data: rateRows }, { data: overrideRows }] = await Promise.all([
      supabase.from('billing_fx_rates').select('currency, rate, updated_at'),
      supabase.from('billing_price_overrides').select('sku, currency, amount'),
    ]);

    if (!rateRows || rateRows.length === 0) return DEFAULT_FX;

    const rates: Record<Currency, number> = { ...DEFAULT_FX.rates };
    let updatedAt: string | undefined;
    for (const r of rateRows as Array<{ currency: string; rate: number; updated_at?: string }>) {
      rates[r.currency as Currency] = Number(r.rate);
      if (r.updated_at && (!updatedAt || r.updated_at > updatedAt)) updatedAt = r.updated_at;
    }

    const overrides: NonNullable<FxConfig['overrides']> = {};
    for (const o of (overrideRows ?? []) as Array<{ sku: string; currency: string; amount: number }>) {
      (overrides[o.sku] ??= {})[o.currency as Currency] = Number(o.amount);
    }

    return { rates, overrides, updatedAt };
  } catch {
    return DEFAULT_FX; // tables absent (pre-migration) → safe default
  }
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
