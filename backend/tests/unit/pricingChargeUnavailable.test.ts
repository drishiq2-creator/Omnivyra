/**
 * B4 (e9 BLOCKING + ruling; e1 hunk list + Q3): a CHARGE is never priced without a real rate.
 * Before: getFxConfig read billing_fx_rates / billing_price_overrides with { data } only inside a catch-all -> any
 * failure (or an empty table) priced the charge at the hardcoded DEFAULT_FX and silently dropped market overrides.
 * Now charge paths use getFxConfigForCharge(currency), which throws PRICING_UNAVAILABLE on a read error (error object or
 * thrown), on an empty rate table, or when the charge currency has no rate row; callers refuse (503 + Retry-After)
 * BEFORE any purchase row or provider order. getFxConfig keeps its DEFAULT_FX fallback for DISPLAY only.
 * The fake mirrors PostgREST: an awaited select resolves { data, error } and never throws (the thrown shape is separate).
 */
type Mode = 'ok' | 'error' | 'throw';
const st: { rates: unknown[]; ratesMode: Mode; overrides: unknown[]; overridesMode: Mode } = { rates: [], ratesMode: 'ok', overrides: [], overridesMode: 'ok' };
const answer = (mode: Mode, data: unknown) => {
  if (mode === 'throw') return Promise.reject(new Error('socket hang up'));
  return Promise.resolve(mode === 'error' ? { data: null, error: { message: 'connection reset' } } : { data, error: null });
};

jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => (table === 'billing_fx_rates' ? answer(st.ratesMode, st.rates) : answer(st.overridesMode, st.overrides)),
    }),
  },
}));

// staging order path: everything except pricing is faked; inserts and provider calls are counted
const writes: string[] = [];
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    const c: any = {};
    c.select = () => c; c.eq = () => c; c.update = () => { writes.push(`update:${table}`); return c; };
    c.insert = () => { writes.push(`insert:${table}`); return c; };
    c.maybeSingle = async () => ({ data: table === 'credit_packages' ? { id: 'pkg-1', credits: 100, price: 499, is_active: true, sku: 'pack_100', canonical_usd_price: 5 } : null, error: null });
    c.single = async () => ({ data: { id: 'purchase-1' }, error: null });
    return c;
  },
}));
jest.mock('../../services/purchaseService', () => ({ completePurchase: jest.fn(), failPurchase: jest.fn(), recordPaymentProviderEvent: jest.fn() }));
jest.mock('../../services/monetizationOpsService', () => ({
  assertMonetizationExposureModeConfigured: () => undefined,
  assertMonetizationOperationAllowed: () => undefined,
  getMonetizationControlMode: () => ({ externalBetaEnabled: false }),
  recordMonetizationOperationalEvent: async () => undefined,
}));
jest.mock('../../services/monetizationBetaAccessService', () => ({
  assertMonetizationBetaAccess: async () => ({ beta_cohort: null, access_level: 'internal', monetization_beta_enabled: true }),
  getMonetizationBetaRuntimeMode: () => 'internal',
  getOrganizationBetaTag: async () => null,
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { getFxConfigForCharge, getFxConfig, PricingUnavailableError } = require('../../services/pricingConfigService');
const { DEFAULT_FX } = require('../../../lib/billing/currency');
/* eslint-enable @typescript-eslint/no-var-requires */

const INR_ROW = { currency: 'INR', rate: 83.5, updated_at: '2026-11-01T00:00:00Z' };
beforeEach(() => {
  st.rates = [INR_ROW]; st.ratesMode = 'ok'; st.overrides = []; st.overridesMode = 'ok'; writes.length = 0;
  process.env.RAZORPAY_STAGING_ENABLED = 'true';
  process.env.RAZORPAY_TEST_KEY_ID = 'rzp_test_key';
  process.env.RAZORPAY_TEST_KEY_SECRET = 'test_secret';
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ id: 'order_1' }) })) as any;
});

describe('getFxConfigForCharge refuses whenever there is no real rate', () => {
  it.each<[string, () => void]>([
    ['rates read: error object', () => { st.ratesMode = 'error'; }],
    ['rates read: thrown', () => { st.ratesMode = 'throw'; }],
    ['overrides read: error object (overrides never silently dropped)', () => { st.overridesMode = 'error'; }],
    ['overrides read: thrown', () => { st.overridesMode = 'throw'; }],
    ['rate table EMPTY (e9: DEFAULT_FX is display-only)', () => { st.rates = []; }],
    ['no row for the charge currency', () => { st.rates = [{ currency: 'EUR', rate: 0.9 }]; }],
  ])('%s -> PricingUnavailableError', async (_n, arrange) => {
    arrange();
    const p = getFxConfigForCharge('INR');
    await expect(p).rejects.toBeInstanceOf(PricingUnavailableError);
    await expect(p).rejects.toMatchObject({ code: 'PRICING_UNAVAILABLE', retryable: true });
  });
  it('CONTROL: a real INR row + overrides -> the configured rate and overrides (not the default 84)', async () => {
    st.overrides = [{ sku: 'pack_100', currency: 'INR', amount: 399 }];
    const fx = await getFxConfigForCharge('INR');
    expect(fx.rates.INR).toBe(83.5);
    expect(fx.overrides).toEqual({ pack_100: { INR: 399 } });
  });
  it('CONTROL: USD (the canonical base, rate 1) needs no row', async () => {
    st.rates = [];
    await expect(getFxConfigForCharge('USD')).resolves.toMatchObject({ rates: { USD: 1 } });
  });
  it('CONTROL (display, e1 Q3): getFxConfig still falls back to DEFAULT_FX on a failed read', async () => {
    st.ratesMode = 'throw';
    await expect(getFxConfig()).resolves.toEqual(DEFAULT_FX);
  });
});

describe('staging charge path: pricing unavailable -> no purchase row, NO provider order', () => {
  it.each<[string, () => void]>([
    ['rates read error', () => { st.ratesMode = 'error'; }],
    ['empty rate table', () => { st.rates = []; }],
  ])('%s -> PricingUnavailableError; 0 inserts, 0 provider calls', async (_n, arrange) => {
    arrange();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createRazorpayStagingCreditOrder } = require('../../services/payments/razorpayStagingService');
    await expect(createRazorpayStagingCreditOrder({ organizationId: 'org-1', packageId: 'pkg-1', requestedBy: 'admin-1' }))
      .rejects.toBeInstanceOf(PricingUnavailableError);
    expect(writes).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('CONTROL: a real rate -> the purchase row is inserted and the provider order IS created, priced at the real rate', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createRazorpayStagingCreditOrder } = require('../../services/payments/razorpayStagingService');
    await createRazorpayStagingCreditOrder({ organizationId: 'org-1', packageId: 'pkg-1', requestedBy: 'admin-1' }).catch(() => undefined);
    expect(writes).toContain('insert:credit_purchases');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.amount).not.toBe(Math.round(5 * 84 * 100));   // never the DEFAULT_FX price
  });
});

describe('source pins (e1 Q3): charge paths never price with the display fallback', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs'); const path = require('path');
  const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8') as string;
  it.each([
    'pages/api/billing/checkout/create-order.ts',
    'backend/services/payments/razorpayStagingService.ts',
  ])('%s imports getFxConfigForCharge and never getFxConfig', (rel) => {
    const s = src(rel);
    expect(s).toMatch(/\bgetFxConfigForCharge\(/);
    expect(s).not.toMatch(/\bgetFxConfig\b(?!ForCharge)/);
  });
  it.each([
    ['pages/api/billing/checkout/create-order.ts', /PricingUnavailableError\) \{[\s\S]{0,200}?setHeader\('Retry-After'[\s\S]{0,80}?status\(503\)/],
    ['pages/api/super-admin/razorpay/create-staging-order.ts', /PricingUnavailableError\) \{[\s\S]{0,200}?setHeader\('Retry-After'[\s\S]{0,80}?status\(503\)/],
  ])('%s answers PRICING_UNAVAILABLE with 503 + Retry-After', (rel, re) => { expect(src(rel)).toMatch(re); });
  it('POSITIVE CONTROL: the pin catches a charge path that imports getFxConfig', () => {
    expect("import { getFxConfig } from '../pricingConfigService';").toMatch(/\bgetFxConfig\b(?!ForCharge)/);
  });
});
