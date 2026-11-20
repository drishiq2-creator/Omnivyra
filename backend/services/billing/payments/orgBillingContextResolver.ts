/**
 * Organization billing-context resolver (SINGLE READ PATH).
 *
 * Resolves an organization's checkout-relevant geography with precedence:
 *
 *   1. billing_context        (lightweight, eligibility-only — migration 20260715)
 *   2. company_billing_profiles (full profile fallback — migration 20260664)
 *   3. { null, null, null }   (no context → conservative fallback downstream)
 *
 * The lightweight table is checked FIRST so payment-provider eligibility does
 * NOT depend on completing a full company billing profile. An org that
 * captured geography during onboarding is fully resolvable here even with no
 * billing_email / billing_address / tax id.
 *
 * NEVER THROWS: a missing row, absent table, or malformed value resolves to
 * null fields. Null country/currency means "unknown" — downstream the
 * provider resolver applies a conservative geography filter (it does NOT
 * blindly expose geography-restricted providers).
 *
 * SCOPE GUARD: geography resolution ONLY. NO pricing data. Does not touch
 * ledger/wallet/HOLD.
 */

import { supabase } from '../../../db/supabaseClient';
import { logger } from '../../logger';

export interface OrgBillingContext {
  /** ISO-3166-1 alpha-2, uppercased; null when unknown (→ conservative fallback). */
  country: string | null;
  /** ISO-4217, uppercased; null when unknown (→ conservative fallback). */
  currency: string | null;
  /** Free-form sub-national region; null when not captured. */
  region: string | null;
  /** Which source backed the resolution. 'none' = nothing found. */
  source: 'billing_context' | 'company_billing_profile' | 'none';
}

function normalizeCountry(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const c = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

function normalizeCurrency(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const c = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

function normalizeRegion(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const r = v.trim();
  return r.length > 0 && r.length <= 120 ? r : null;
}

/**
 * The org's billing context could not be READ (c6 2026-11-20, dropped-error batch 4). It used to answer source='none'
 * (geography unknown): the /billing page then treated an org WITH a profile as having none and resolved providers for
 * an unknown geography. Now thrown; the routes answer 503 BILLING_CONTEXT_UNREADABLE.
 */
export class OrgBillingContextUnreadableError extends Error {
  readonly code = 'BILLING_CONTEXT_UNREADABLE';
  constructor(detail: string) {
    super(`billing context could not be read: ${detail}`);
    this.name = 'OrgBillingContextUnreadableError';
  }
}

/** (1) Lightweight billing_context lookup. null = genuinely no row; a failed read THROWS. */
async function readLightweightContext(organizationId: string): Promise<OrgBillingContext | null> {
  const { data, error } = await supabase
    .from('billing_context')
    .select('billing_country, billing_currency, billing_region')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) {
    // billing_context is a LEGACY read-compat tier that nothing writes any more (billingProfileCaptureService header).
    // Its table being ABSENT is a schema state, not a failed read: fall through to company_billing_profiles. Exactly
    // "undefined table" (Postgres 42P01 / PostgREST PGRST205) - any other error is unreadable and throws.
    const code = (error as { code?: string }).code;
    if (code === '42P01' || code === 'PGRST205') {
      logger.warn('org_billing_context_legacy_table_absent', { code });
      return null;
    }
    throw new OrgBillingContextUnreadableError(`billing_context: ${error.message}`);
  }
  if (!data) return null;
  const row = data as { billing_country?: unknown; billing_currency?: unknown; billing_region?: unknown };
  const country = normalizeCountry(row.billing_country);
  const currency = normalizeCurrency(row.billing_currency);
  const region = normalizeRegion(row.billing_region);
  // A row that yields nothing usable is treated as "no lightweight context"
  // so the resolver falls through to the full-profile source.
  if (!country && !currency && !region) return null;
  return { country, currency, region, source: 'billing_context' };
}

/** (2) Full company_billing_profiles fallback. null = genuinely no row; a failed read THROWS. */
async function readFullProfileContext(organizationId: string): Promise<OrgBillingContext | null> {
  const { data, error } = await supabase
    .from('company_billing_profiles')
    .select('billing_address, currency_preference')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw new OrgBillingContextUnreadableError(`company_billing_profiles: ${error.message}`);
  if (!data) return null;
  const row = data as { billing_address?: unknown; currency_preference?: unknown };
  const address = (row.billing_address && typeof row.billing_address === 'object')
    ? row.billing_address as Record<string, unknown>
    : {};
  const country = normalizeCountry(address.country) ?? normalizeCountry(address.country_code);
  const currency = normalizeCurrency(row.currency_preference);
  const region = normalizeRegion(address.region) ?? normalizeRegion(address.state);
  if (!country && !currency && !region) return null;
  return { country, currency, region, source: 'company_billing_profile' };
}

/**
 * Resolve { country, currency, region } for an organization. source='none' with null fields ONLY when both tiers were
 * READ and have nothing; a failed read THROWS OrgBillingContextUnreadableError (never "geography unknown").
 */
export async function resolveOrgBillingContext(
  organizationId: string | null | undefined,
): Promise<OrgBillingContext> {
  const EMPTY: OrgBillingContext = { country: null, currency: null, region: null, source: 'none' };
  if (!organizationId) return EMPTY;
  try {
    const light = await readLightweightContext(organizationId);
    if (light) return light;
    const full = await readFullProfileContext(organizationId);
    if (full) return full;
    return EMPTY;
  } catch (err) {
    logger.warn('org_billing_context_resolve_failed', {
      org: organizationId,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err instanceof OrgBillingContextUnreadableError
      ? err
      : new OrgBillingContextUnreadableError(err instanceof Error ? err.message : String(err));
  }
}
