/**
 * MONEY unread-error sites (owner rule 2026-11-11/12): checkout/verify and
 * checkout/create-order now READ every database error on the money path.
 *
 *  - verify: a failed purchase lookup is 503 (retryable), never the 404
 *    "purchase_not_found" a customer who just paid used to get; nothing is
 *    verified or settled on an unread row.
 *  - create-order: a failed package lookup is 503 with no DB message leaked;
 *    if the provider order id cannot be recorded (error OR 0 rows) the order is
 *    NOT handed to the browser (no key_id / client token) and the row is closed;
 *    a failed 'failed' flip is logged, not swallowed.
 */
export {};
const ORG = 'a0000000-0000-4000-8000-00000000000a';
const PURCHASE = '11111111-0000-4000-8000-0000000000p1';

type Res = { data: unknown; error: { message: string } | null };
let mockScript: Record<string, (op: string, payload: unknown) => Res> = {};
const mockWrites: Array<{ table: string; op: string; payload: unknown }> = [];
const mockLogs: Array<[string, string]> = [];
const mockSinks: string[] = [];

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../middleware/withOrgAccess', () => ({
  withOrgAccess: (h: (req: any, res: any) => unknown) => (req: any, res: any) => { req.orgAccess = { orgId: ORG }; return h(req, res); },
}));
jest.mock('../../services/logger', () => ({
  logger: {
    error: (e: string) => mockLogs.push(['error', e]),
    warn: (e: string) => mockLogs.push(['warn', e]),
    info: (e: string) => mockLogs.push(['info', e]),
  },
}));
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      let op = 'select';
      let payload: unknown = null;
      const b: any = {};
      const result = () => (mockScript[table + ':' + op] ?? (() => ({ data: null, error: null })))(op, payload);
      b.select = () => b;
      b.eq = () => b;
      b.insert = (p: unknown) => { op = 'insert'; payload = p; mockWrites.push({ table, op, payload: p }); return b; };
      b.update = (p: unknown) => { op = 'update'; payload = p; mockWrites.push({ table, op, payload: p }); return b; };
      b.maybeSingle = async () => result();
      b.single = async () => result();
      b.then = (ok: (v: Res) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, ko);
      return b;
    },
  },
}));
jest.mock('../../security/IdentityResolver', () => ({ resolvePrincipal: async () => ({ ok: true, principal: { userId: 'u1' } }) }));
// c6 2026-11-20: controllable, and it carries the error class the route matches on (a factory mock that omitted a new
// export would make `instanceof` throw only on the failure path - the blind spot this avoids).
let mockFx: () => Promise<unknown> = async () => ({});
jest.mock('../../services/pricingConfigService', () => {
  class PriceConfigUnavailableError extends Error { readonly code = 'PRICE_CONFIG_UNAVAILABLE'; }
  return { getFxConfig: () => mockFx(), PriceConfigUnavailableError };
});
jest.mock('../../services/payments/orchestrator', () => ({
  createOrder: async () => {
    mockSinks.push('provider:createOrder');
    return { order: { providerOrderId: 'order_1', amountSubunits: 100, clientToken: 'tok' }, provider: 'razorpay', attempts: [] };
  },
  getProviderCredentials: () => ({ keyId: 'rzp_key' }),
  getActiveMode: () => 'test',
  verifyPayment: async () => { mockSinks.push('provider:verifyPayment'); return { verified: true }; },
}));
jest.mock('../../services/billing/topupInvoiceService', () => ({ generateTopupInvoice: async () => null }));
jest.mock('../../services/billing/purchaseClosureService', () => ({
  closePurchaseFromClient: async () => { mockSinks.push('closePurchaseFromClient'); return { action: 'failed' }; },
  fulfillProviderConfirmedPurchase: async () => { mockSinks.push('fulfill'); return { ok: true, creditsGranted: 10 }; },
}));

import verify from '../../../pages/api/billing/checkout/verify';
import createOrder from '../../../pages/api/billing/checkout/create-order';

function mockRes() {
  const r: any = { statusCode: 0, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.headers = {} as Record<string, string>;
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; return r; };
  return r;
}
const post = (body: unknown) => ({ method: 'POST', body, query: {}, headers: {} }) as any;
const PKG_OK: Res = { data: { id: 'pkg', credits: 100, price: 500, sku: null, canonical_usd_price: null, is_active: true }, error: null };

beforeEach(() => { mockScript = {}; mockWrites.length = 0; mockLogs.length = 0; mockSinks.length = 0; mockFx = async () => ({}); });

describe('checkout/verify', () => {
  it('purchase lookup error -> 503 retryable, NOT 404; nothing verified or settled', async () => {
    mockScript['credit_purchases:select'] = () => ({ data: null, error: { message: 'connection reset' } });
    const res = mockRes();
    await verify(post({ purchase_id: PURCHASE }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'purchase_lookup_unavailable', retryable: true });
    expect(mockSinks).toEqual([]);
    expect(mockLogs).toContainEqual(['error', 'checkout_verify_purchase_lookup_failed']);
  });

  it('a genuinely absent purchase is still 404 (unchanged)', async () => {
    mockScript['credit_purchases:select'] = () => ({ data: null, error: null });
    const res = mockRes();
    await verify(post({ purchase_id: PURCHASE }), res);
    expect(res.statusCode).toBe(404);
    expect(mockSinks).toEqual([]);
  });

  it('an own purchase that reads cleanly still settles (unchanged)', async () => {
    mockScript['credit_purchases:select'] = () => ({ data: { id: PURCHASE, organization_id: ORG, provider_order_id: 'order_1' }, error: null });
    const res = mockRes();
    await verify(post({ purchase_id: PURCHASE, payment_id: 'pay_1', signature: 's' }), res);
    expect(res.statusCode).toBe(200);
    expect(mockSinks).toEqual(['provider:verifyPayment', 'fulfill']);
  });
});

describe('checkout/create-order', () => {
  const inserted = (): Res => ({ data: { id: PURCHASE }, error: null });

  it('package lookup error -> 503, the DB message never reaches the client, no purchase, no provider call', async () => {
    mockScript['credit_packages:select'] = () => ({ data: null, error: { message: 'secret internal detail' } });
    const res = mockRes();
    await createOrder(post({ package_id: 'pkg' }), res);
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
    expect(mockWrites).toEqual([]);
    expect(mockSinks).toEqual([]);
  });

  it.each([
    ['an error', { data: null, error: { message: 'timeout' } } as Res],
    ['0 rows', { data: [], error: null } as Res],
  ])('provider order id not recorded (%s) -> 503, order NOT handed out, row closed as failed', async (_label, recordResult) => {
    mockScript['credit_packages:select'] = () => PKG_OK;
    mockScript['credit_purchases:insert'] = inserted;
    mockScript['credit_purchases:update'] = (_op, payload) =>
      ((payload as any)?.provider_order_id ? recordResult : { data: null, error: null });
    const res = mockRes();
    await createOrder(post({ package_id: 'pkg' }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ ok: false, error: 'order_record_failed' });
    expect(JSON.stringify(res.body)).not.toMatch(/rzp_key|tok|order_1/);
    expect(mockWrites.filter((w) => w.op === 'update').map((w) => w.payload)).toEqual([
      { provider: 'razorpay', provider_order_id: 'order_1' },
      { status: 'failed' },
    ]);
    expect(mockLogs).toContainEqual(['error', 'checkout_provider_order_record_failed']);
  });

  it('a failed "failed" flip after a provider failure is logged, not swallowed', async () => {
    mockScript['credit_packages:select'] = () => PKG_OK;
    mockScript['credit_purchases:insert'] = inserted;
    mockScript['credit_purchases:update'] = () => ({ data: null, error: { message: 'down' } });
    const orch = jest.requireMock('../../services/payments/orchestrator');
    const orig = orch.createOrder;
    orch.createOrder = async () => ({ order: null, provider: null, attempts: [] });
    try {
      const res = mockRes();
      await createOrder(post({ package_id: 'pkg' }), res);
      expect(res.statusCode).toBe(502);
      expect(mockLogs).toContainEqual(['error', 'checkout_purchase_fail_mark_failed']);
    } finally {
      orch.createOrder = orig;
    }
  });

  it('the recorded happy path still returns the order (unchanged)', async () => {
    mockScript['credit_packages:select'] = () => PKG_OK;
    mockScript['credit_purchases:insert'] = inserted;
    mockScript['credit_purchases:update'] = () => ({ data: [{ id: PURCHASE }], error: null });
    const res = mockRes();
    await createOrder(post({ package_id: 'pkg' }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ ok: true, provider_order_id: 'order_1', key_id: 'rzp_key' });
  });
});

// b3 ruling 2026-11-20 (PL-114 class, LIVE): a USD-priced pack is never charged from FX config we could not read.
describe('checkout/create-order - unreadable price configuration', () => {
  const PKG_USD: Res = { data: { id: 'pkg', credits: 100, price: 500, sku: 'credits_100', canonical_usd_price: 6, is_active: true }, error: null };
  it('PriceConfigUnavailableError -> 503 PRICE_CONFIG_UNAVAILABLE + Retry-After; no purchase row, no provider order', async () => {
    const { PriceConfigUnavailableError } = jest.requireMock('../../services/pricingConfigService');
    mockScript['credit_packages:select'] = () => PKG_USD;
    mockFx = async () => { throw new PriceConfigUnavailableError('billing_price_overrides: timeout'); };
    const res = mockRes();
    await createOrder(post({ package_id: 'pkg', currency: 'INR' }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'price_config_unavailable', code: 'PRICE_CONFIG_UNAVAILABLE' });
    expect(res.headers['Retry-After']).toBe('60');
    expect(JSON.stringify(res.body)).not.toMatch(/timeout|override/);
    expect(mockWrites).toEqual([]);
    expect(mockSinks).toEqual([]);
  });
  it('CONTROL: readable config -> priced from it (override applied) and the order is created', async () => {
    mockScript['credit_packages:select'] = () => PKG_USD;
    mockScript['credit_purchases:insert'] = () => ({ data: { id: PURCHASE }, error: null });
    mockScript['credit_purchases:update'] = () => ({ data: [{ id: PURCHASE }], error: null });
    mockFx = async () => ({ rates: { USD: 1, INR: 85, EUR: 0.9 }, overrides: { credits_100: { INR: 499 } } });
    const res = mockRes();
    await createOrder(post({ package_id: 'pkg', currency: 'INR' }), res);
    expect(res.statusCode).toBe(201);
    expect(mockWrites.find((w) => w.op === 'insert')?.payload).toMatchObject({ amount_paid: 499 });
  });
  it('CONTROL: any OTHER error is not mapped to 503 PRICE_CONFIG_UNAVAILABLE', async () => {
    mockScript['credit_packages:select'] = () => PKG_USD;
    mockFx = async () => { throw new Error('unrelated'); };
    const res = mockRes();
    await Promise.resolve(createOrder(post({ package_id: 'pkg', currency: 'INR' }), res)).catch(() => undefined);
    expect(res.body?.code).not.toBe('PRICE_CONFIG_UNAVAILABLE');
    expect(mockSinks).toEqual([]);
  });
});
