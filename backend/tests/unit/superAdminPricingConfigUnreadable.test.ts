/**
 * Super-admin pricing (7c 2026-11-20): an unreadable FX config is STATED (503 PRICE_CONFIG_UNAVAILABLE), never rendered
 * as DEFAULT_FX to an admin about to edit live rates; a save that succeeded is never reported as failed because the
 * re-read after it failed.
 */
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../security/requireCapability', () => ({ requireCapability: async () => ({ ok: true, principal: { userId: 'admin-1' } }) }));
jest.mock('../../services/requestAccessService', () => ({ requireAdminRateLimit: async () => true }));
const mockState = { fxFails: false, saved: [] as unknown[] };
jest.mock('../../services/pricingConfigService', () => {
  class PriceConfigUnavailableError extends Error { readonly code = 'PRICE_CONFIG_UNAVAILABLE'; }
  return {
    PriceConfigUnavailableError,
    getFxConfig: async () => { if (mockState.fxFails) throw new PriceConfigUnavailableError('down'); return { rates: { USD: 1, INR: 84, EUR: 0.92 } }; },
    getPlanPricing: async () => [],
    setFxRate: async (...a: unknown[]) => { mockState.saved.push(a); },
    setPriceOverride: async () => undefined,
    setPlanPricing: async () => undefined,
  };
});
import handler from '../../../pages/api/super-admin/pricing/index';

const call = async (method: string, body?: unknown) => {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.end = () => res;
  await (handler as any)({ method, body, query: {}, headers: {} }, res);
  return res;
};
beforeEach(() => { mockState.fxFails = false; mockState.saved.length = 0; });

describe('super-admin pricing - unreadable FX config', () => {
  it('GET: unreadable -> 503 PRICE_CONFIG_UNAVAILABLE (never defaults)', async () => {
    mockState.fxFails = true;
    const r = await call('GET');
    expect(r.statusCode).toBe(503);
    expect(r.body).toEqual({ error: 'price_config_unavailable', code: 'PRICE_CONFIG_UNAVAILABLE' });
  });
  it('CONTROL GET: readable -> 200 with the config', async () => {
    const r = await call('GET');
    expect(r.statusCode).toBe(200);
    expect(r.body.fx.rates.INR).toBe(84);
  });
  it('POST: the save SUCCEEDED, the re-read failed -> 200 saved (not a failed save)', async () => {
    mockState.fxFails = true;
    const r = await call('POST', { action: 'fx', currency: 'INR', rate: 85 });
    expect(mockState.saved).toHaveLength(1);               // PREMISE: the write happened
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ ok: true, saved: true, reread: 'price_config_unavailable' });
  });
  it('CONTROL POST: save + readable re-read -> 200 with the config', async () => {
    const r = await call('POST', { action: 'fx', currency: 'INR', rate: 85 });
    expect(r.body).toMatchObject({ ok: true, fx: { rates: { INR: 84 } } });
  });
});
