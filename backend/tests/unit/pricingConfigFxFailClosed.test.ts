/**
 * getFxConfig fails CLOSED (b3 ruling 2026-11-20, the PL-114 class on the LIVE top-up path). Before: both reads
 * destructured `{ data }` only - a failed rate read answered DEFAULT_FX and a failed OVERRIDE read silently dropped
 * every per-SKU price override; the catch answered DEFAULT_FX. Each failure case is paired with a readable control.
 */
type R = { data: unknown; error: { message: string } | null };
const mockTables: Record<string, () => Promise<R>> = {};
jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: (t: string) => ({ select: () => mockTables[t]() }) },
}));
const mockLog = { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
jest.mock('../../services/logger', () => ({ logger: mockLog }));
const mockMetrics: unknown[][] = [];
jest.mock('../../services/systemHealthMetricsService', () => ({ recordMetric: async (...a: unknown[]) => { mockMetrics.push(a); } }));

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

import { getFxConfig, getChargeFxConfig, PriceConfigUnavailableError } from '../../services/pricingConfigService';
import fxRoute from '../../../pages/api/billing/fx';
import { DEFAULT_FX } from '../../../lib/billing/currency';

const RATES: R = { data: [{ currency: 'INR', rate: 85, updated_at: '2026-11-01' }], error: null };
const OVERRIDES: R = { data: [{ sku: 'credits_100', currency: 'INR', amount: 499 }], error: null };
const ERR: R = { data: null, error: { message: 'connection reset' } };

beforeEach(() => {
  mockTables.billing_fx_rates = async () => RATES;
  mockTables.billing_price_overrides = async () => OVERRIDES;
  mockMetrics.length = 0; mockLog.error.mockClear();
});

describe('getFxConfig - an unreadable config is never priced from defaults', () => {
  it('rate read error -> throws PriceConfigUnavailableError, logged + counted', async () => {
    mockTables.billing_fx_rates = async () => ERR;
    await expect(getFxConfig()).rejects.toMatchObject({ name: 'PriceConfigUnavailableError', code: 'PRICE_CONFIG_UNAVAILABLE' });
    expect(mockLog.error).toHaveBeenCalledWith('pricing_fx_config_unavailable', expect.anything());
    expect(mockMetrics.map((m) => m.slice(0, 3))).toEqual([['billing', 'price_config_unavailable', 1]]);
  });
  it('OVERRIDE read error -> throws (not "no overrides")', async () => {
    mockTables.billing_price_overrides = async () => ERR;
    await expect(getFxConfig()).rejects.toBeInstanceOf(PriceConfigUnavailableError);
  });
  it('a thrown client -> throws (not DEFAULT_FX)', async () => {
    mockTables.billing_fx_rates = async () => { throw new TypeError('fetch failed'); };
    await expect(getFxConfig()).rejects.toBeInstanceOf(PriceConfigUnavailableError);
  });
  it('CONTROL: readable rates + overrides -> the live config with the override, nothing counted', async () => {
    const fx = await getFxConfig();
    expect(fx.rates.INR).toBe(85);
    expect(fx.overrides).toEqual({ credits_100: { INR: 499 } });
    expect(mockMetrics).toEqual([]);
  });
  it('CONTROL (PROD SHAPE, cb C143): 3 rates + ZERO override rows -> live rates, no overrides, NOT a failure', async () => {
    // Prod 2026-11-20: billing_price_overrides is EMPTY. Treating empty as unreadable would 503 every live top-up.
    mockTables.billing_fx_rates = async () => ({ data: [
      { currency: 'USD', rate: 1, updated_at: '2026-06-20' },
      { currency: 'INR', rate: 84, updated_at: '2026-06-20' },
      { currency: 'EUR', rate: 0.92, updated_at: '2026-06-20' },
    ], error: null });
    mockTables.billing_price_overrides = async () => ({ data: [], error: null });
    const fx = await getFxConfig();
    expect(fx.rates).toMatchObject({ USD: 1, INR: 84, EUR: 0.92 });
    expect(fx.overrides).toEqual({});
    expect(mockMetrics).toEqual([]);
  });
  it('CONTROL: read OK but no rates configured -> DEFAULT_FX (unchanged: unconfigured, not unreadable)', async () => {
    mockTables.billing_fx_rates = async () => ({ data: [], error: null });
    await expect(getFxConfig()).resolves.toBe(DEFAULT_FX);
    expect(mockMetrics).toEqual([]);
  });
});

describe('GET /api/billing/fx (display) - unreadable config is 503 with a code, never defaults or the DB message', () => {
  const call = async () => {
    const res: any = { statusCode: 0, body: null, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    await (fxRoute as any)({ method: 'GET', query: {}, headers: {} }, res);
    return res;
  };
  it('override read error -> 503 PRICE_CONFIG_UNAVAILABLE + Retry-After, no raw message', async () => {
    mockTables.billing_price_overrides = async () => ERR;
    const r = await call();
    expect(r.statusCode).toBe(503);
    expect(r.body).toEqual({ error: 'price_config_unavailable', code: 'PRICE_CONFIG_UNAVAILABLE' });
    expect(r.headers['Retry-After']).toBe('60');
  });
  it('CONTROL: readable -> 200 with the live config', async () => {
    const r = await call();
    expect(r.statusCode).toBe(200);
    expect(r.body.overrides).toEqual({ credits_100: { INR: 499 } });
  });
});

// b3 ruling 2026-11-20 (i): the CHARGE path refuses empty or partial rates; display keeps defaults, labelled estimate.
describe('getChargeFxConfig - strict on the charge path', () => {
  const rows = (...cs: Array<[string, number]>): R => ({ data: cs.map(([currency, rate]) => ({ currency, rate })), error: null });
  const NO_OVERRIDES: R = { data: [], error: null };
  beforeEach(() => { mockTables.billing_price_overrides = async () => NO_OVERRIDES; });
  it('EMPTY rates -> INR charge refused (never DEFAULT_FX)', async () => {
    mockTables.billing_fx_rates = async () => ({ data: [], error: null });
    await expect(getChargeFxConfig('INR', 'credits_100')).rejects.toBeInstanceOf(PriceConfigUnavailableError);
  });
  it('PARTIAL rates (no INR row) -> INR charge refused', async () => {
    mockTables.billing_fx_rates = async () => rows(['USD', 1], ['EUR', 0.92]);
    await expect(getChargeFxConfig('INR')).rejects.toBeInstanceOf(PriceConfigUnavailableError);
  });
  it('a non-positive / non-numeric INR rate is not "configured" -> refused', async () => {
    mockTables.billing_fx_rates = async () => rows(['USD', 1], ['INR', 0]);
    await expect(getChargeFxConfig('INR')).rejects.toBeInstanceOf(PriceConfigUnavailableError);
  });
  it('CONTROL (PROD SHAPE C143): USD/INR/EUR configured, no overrides -> every chargeable currency prices', async () => {
    mockTables.billing_fx_rates = async () => rows(['USD', 1], ['INR', 84], ['EUR', 0.92]);
    for (const c of ['USD', 'INR', 'EUR'] as const) await expect(getChargeFxConfig(c, 'credits_100')).resolves.toBeDefined();
    expect(mockMetrics).toEqual([]);
  });
  it('CONTROL: a configured override for (sku, currency) prices even without that rate', async () => {
    mockTables.billing_fx_rates = async () => rows(['USD', 1]);
    mockTables.billing_price_overrides = async () => ({ data: [{ sku: 'credits_100', currency: 'INR', amount: 499 }], error: null });
    await expect(getChargeFxConfig('INR', 'credits_100')).resolves.toMatchObject({ overrides: { credits_100: { INR: 499 } } });
  });
  it('CONTROL: a USD charge needs no rate (canonical)', async () => {
    mockTables.billing_fx_rates = async () => ({ data: [], error: null });
    await expect(getChargeFxConfig('USD')).resolves.toBeDefined();
  });
});

describe('GET /api/billing/fx - defaults are labelled an estimate', () => {
  const call = async () => {
    const res: any = { statusCode: 0, body: null, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    await (fxRoute as any)({ method: 'GET', query: {}, headers: {} }, res);
    return res;
  };
  it('partial rates -> 200 with estimate: true', async () => {
    mockTables.billing_fx_rates = async () => ({ data: [{ currency: 'USD', rate: 1 }], error: null });
    const r = await call();
    expect(r.statusCode).toBe(200);
    expect(r.body.estimate).toBe(true);
  });
  it('CONTROL: all rates configured -> estimate: false', async () => {
    mockTables.billing_fx_rates = async () => ({ data: [{ currency: 'USD', rate: 1 }, { currency: 'INR', rate: 84 }, { currency: 'EUR', rate: 0.92 }], error: null });
    const r = await call();
    expect(r.body.estimate).toBe(false);
  });
});
