/**
 * Go-live readiness at the ROUTES (b3 2026-11-20).
 *  - create-order refuses an invalid mode / incomplete live config with 503 + a code, BEFORE any row or provider order.
 *  - the live payment webhook COUNTS a rejected signature and says WHY (secret_unset vs signature_mismatch) - C144 could
 *    not tell "not configured" from "signature always invalid".
 */
import { EventEmitter } from 'events';

const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
const mockMetrics: unknown[][] = [];
const mockWrites: string[] = [];
const mockSinks: string[] = [];
const mockCreds: { webhookSecret?: string } = {};

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../middleware/withOrgAccess', () => ({
  withOrgAccess: (h: (req: any, res: any) => unknown) => (req: any, res: any) => { req.orgAccess = { orgId: 'org-1' }; return h(req, res); },
}));
jest.mock('../../services/logger', () => ({ logger: mockLog }));
jest.mock('../../services/systemHealthMetricsService', () => ({ recordMetric: async (...a: unknown[]) => { mockMetrics.push(a); } }));
jest.mock('../../security/IdentityResolver', () => ({ resolvePrincipal: async () => ({ ok: true, principal: { userId: 'u1' } }) }));
jest.mock('../../services/pricingConfigService', () => ({ getFxConfig: async () => ({ rates: { USD: 1, INR: 84, EUR: 0.92 } }) }));
jest.mock('../../db/supabaseClient', () => {
  const b: any = {};
  for (const m of ['select', 'eq', 'update']) b[m] = () => b;
  b.insert = () => { mockWrites.push('insert'); return b; };
  b.maybeSingle = async () => ({ data: { id: 'pkg', credits: 100, price: 500, sku: null, canonical_usd_price: null, is_active: true }, error: null });
  b.single = async () => ({ data: { id: 'p1' }, error: null });
  return { supabase: { from: () => b } };
});
jest.mock('../../services/billing/purchaseClosureService', () => ({ fulfillProviderConfirmedPurchase: async () => ({ ok: true }) }));
jest.mock('../../services/payments/orchestrator', () => ({
  createOrder: async () => { mockSinks.push('provider:createOrder'); return { order: null, provider: null, attempts: [] }; },
  getProviderCredentials: () => mockCreds,
  getActiveMode: () => 'test',
  handleWebhook: async () => ({ verified: false, eventId: null, eventType: null, recorded: false }),
}));

import createOrder from '../../../pages/api/billing/checkout/create-order';
import webhook from '../../../pages/api/webhooks/payments/[provider]';

const res = () => {
  const r: any = { statusCode: 0, body: null, headers: {} };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; return r; };
  return r;
};
const saved = process.env.PAYMENT_PROVIDER_MODE;
beforeEach(() => {
  mockMetrics.length = 0; mockWrites.length = 0; mockSinks.length = 0; mockLog.error.mockClear(); mockLog.warn.mockClear();
  delete process.env.PAYMENT_PROVIDER_MODE; delete mockCreds.webhookSecret;
});
afterAll(() => { if (saved === undefined) delete process.env.PAYMENT_PROVIDER_MODE; else process.env.PAYMENT_PROVIDER_MODE = saved; });
const flush = () => new Promise((r) => setImmediate(r));

describe('create-order - readiness gate', () => {
  const post = () => ({ method: 'POST', body: { package_id: 'pkg' }, query: {}, headers: {} }) as any;
  it('invalid PAYMENT_PROVIDER_MODE -> 503 PAYMENT_MODE_INVALID, no purchase row, no provider order', async () => {
    process.env.PAYMENT_PROVIDER_MODE = 'production';
    const r = res();
    await (createOrder as any)(post(), r);
    expect(r.statusCode).toBe(503);
    expect(r.body).toEqual({ error: 'payments_unavailable', code: 'PAYMENT_MODE_INVALID' });
    expect(r.headers['Retry-After']).toBe('300');
    expect(mockWrites).toEqual([]);
    expect(mockSinks).toEqual([]);
    await flush();
    expect(mockMetrics.map((m) => m.slice(0, 3))).toEqual([['payments', 'checkout_config_invalid', 1]]);
  });
  it('live with no live keys -> 503 PAYMENT_CONFIG_INVALID, nothing created', async () => {
    process.env.PAYMENT_PROVIDER_MODE = 'live';
    const r = res();
    await (createOrder as any)(post(), r);
    expect(r.body).toMatchObject({ code: 'PAYMENT_CONFIG_INVALID' });
    expect(mockWrites).toEqual([]);
  });
  it('CONTROL: mode unset (today) -> passes the gate (reaches the purchase insert)', async () => {
    const r = res();
    await (createOrder as any)(post(), r);
    expect(mockWrites).toEqual(['insert']);
    expect(r.body?.code).toBeUndefined();
  });
});

describe('payment webhook - a rejected signature is counted, with WHY', () => {
  const call = async () => {
    const req: any = new EventEmitter();
    Object.assign(req, { method: 'POST', query: { provider: 'razorpay' }, headers: {} });
    const r = res();
    const p = (webhook as any)(req, r);
    req.emit('data', '{"event":"payment.captured"}'); req.emit('end');
    await p; await flush();
    return r;
  };
  it('no webhook secret configured -> 401, reason secret_unset at ERROR level, counted', async () => {
    const r = await call();
    expect(r.statusCode).toBe(401);
    expect(mockLog.error).toHaveBeenCalledWith('payment_webhook_rejected', { provider: 'razorpay', reason: 'secret_unset' });
    expect(mockMetrics).toEqual([['payments', 'webhook_signature_rejected', 1, 'count', { provider: 'razorpay', reason: 'secret_unset' }]]);
  });
  it('secret configured but delivery does not verify -> reason signature_mismatch (warn), counted', async () => {
    mockCreds.webhookSecret = 'w';
    const r = await call();
    expect(r.statusCode).toBe(401);
    expect(mockLog.warn).toHaveBeenCalledWith('payment_webhook_rejected', { provider: 'razorpay', reason: 'signature_mismatch' });
    expect(mockMetrics[0][4]).toEqual({ provider: 'razorpay', reason: 'signature_mismatch' });
  });
});

describe('payment webhook - an invalid mode is its own reason (7c)', () => {
  it('getProviderCredentials throws (invalid PAYMENT_PROVIDER_MODE) -> reason mode_invalid at ERROR, counted', async () => {
    const orch = jest.requireMock('../../services/payments/orchestrator');
    const orig = orch.getProviderCredentials;
    orch.getProviderCredentials = () => { throw new Error("PAYMENT_PROVIDER_MODE must be 'test' or 'live'"); };
    try {
      const req: any = new EventEmitter();
      Object.assign(req, { method: 'POST', query: { provider: 'razorpay' }, headers: {} });
      const r = res();
      const p = (webhook as any)(req, r);
      req.emit('data', '{}'); req.emit('end');
      await p; await flush();
      expect(r.statusCode).toBe(401);
      expect(mockLog.error).toHaveBeenCalledWith('payment_webhook_rejected', { provider: 'razorpay', reason: 'mode_invalid' });
      expect(mockMetrics[0][4]).toEqual({ provider: 'razorpay', reason: 'mode_invalid' });
    } finally {
      orch.getProviderCredentials = orig;
    }
  });
});
