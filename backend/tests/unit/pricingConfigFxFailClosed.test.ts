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

import { getFxConfig, PriceConfigUnavailableError } from '../../services/pricingConfigService';
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
