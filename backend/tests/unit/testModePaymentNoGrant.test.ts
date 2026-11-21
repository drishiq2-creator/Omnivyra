/**
 * MONEY (b3 / owner 2026-11-20): prod runs on TEST provider keys (mode unset -> 'test'), so a test-card payment
 * verified and completePurchase granted REAL paid credits. Now: in production a purchase stamped provider_mode 'test'
 * is closed as failed and grants nothing. Controls: live mode grants; non-production grants (QA); an unstamped row
 * (pre-column) grants. Every control fails if the guard grows too wide; the refusal fails if it is removed.
 */
const mockState = { isProd: true, row: null as Record<string, unknown> | null, updates: [] as Array<Record<string, unknown>>, credits: [] as unknown[] };

jest.mock('../../services/config/productionFlags', () => ({ isProduction: () => mockState.isProd }));
jest.mock('../../services/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('../../services/requestContext', () => ({ getRequestContext: () => null }));
jest.mock('../../services/creditExecutionService', () => ({
  createCredit: async (opts: unknown) => { mockState.credits.push(opts); },
  makeIdempotencyKey: (...a: string[]) => a.join(':'),
}));
jest.mock('../../db/writeOwner', () => {
  const builder = (op: { kind: 'select' | 'update'; patch?: Record<string, unknown> }) => {
    const b: any = {};
    b.select = () => b; b.eq = () => b; b.neq = () => b; b.is = () => b; b.limit = () => b;
    b.maybeSingle = async () => (op.kind === 'select'
      ? { data: mockState.row, error: null }
      : { data: { id: 'p1' }, error: null });
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: 'p1' }], error: null }).then(ok);
    return b;
  };
  return {
    ownedDbTable: () => ({
      select: () => builder({ kind: 'select' }).select(),
      update: (patch: Record<string, unknown>) => { mockState.updates.push(patch); return builder({ kind: 'update', patch }); },
    }),
  };
});

import { completePurchase } from '../../services/purchaseService';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1', organization_id: 'org-1', credits: 500, status: 'pending', amount_paid: 4620, currency: 'INR',
  fulfillment_status: 'pending', provider_mode: 'test', ...over,
});

beforeEach(() => { mockState.isProd = true; mockState.row = row(); mockState.updates = []; mockState.credits = []; });

describe('a TEST-mode payment in production grants nothing', () => {
  it('production + provider_mode test -> refused, closed as failed, NO credits', async () => {
    const r = await completePurchase('p1', 'pay_1');
    // PL-162: the reason is mode-neutral and carries the STORED mode; 'test' keeps its recorded error.
    expect(r).toMatchObject({ success: false, reason: 'non_live_no_grant', providerMode: 'test' });
    expect(mockState.credits).toEqual([]);
    expect(mockState.updates[0]).toMatchObject({ status: 'failed', fulfillment_status: 'failed', fulfillment_error: 'test_mode_payment_no_grant' });
  });
  it('CONTROL: production + provider_mode live -> credits granted', async () => {
    mockState.row = row({ provider_mode: 'live' });
    await completePurchase('p1', 'pay_1');
    expect(mockState.credits).toHaveLength(1);
  });
  it('CONTROL: NOT production (dev / QA) + test -> credits granted (test keys exist to test the flow)', async () => {
    mockState.isProd = false;
    await completePurchase('p1', 'pay_1');
    expect(mockState.credits).toHaveLength(1);
  });
  // INVERTED (04, 2026-11-20; c6's handover item 1, cb C151): the guard now fails CLOSED. Only 'live' grants in
  // production; this used to pin "a row with no recorded mode is not affected". C151 found 0 completable NULL/unknown
  // rows in prod, so the inversion changes no real purchase.
  it.each<[string, unknown]>([
    ['NULL (created before the column)', null],
    ["'unknown' (checkoutSessionStore's normalisation)", 'unknown'],
    ['an empty string', ''],
    ['an unexpected value', 'sandbox'],
  ])('production + provider_mode %s -> refused, NO credits (only live grants)', async (_n, mode) => {
    mockState.row = row({ provider_mode: mode });
    const r = await completePurchase('p1', 'pay_1');
    expect(r).toMatchObject({ success: false, reason: 'non_live_no_grant', providerMode: mode });
    expect(mockState.credits).toEqual([]);
    // PL-162: recorded as NON-live, never as a test payment.
    expect(mockState.updates[0]).toMatchObject({ fulfillment_error: 'non_live_payment_no_grant' });
  });

  // PL-162 (owner ruling 2026-11-20): an offline sale ('manual', the column DEFAULT) never adds credits automatically,
  // and is recorded as exactly that, not as a test payment.
  it("production + provider_mode 'manual' (offline sale) -> refused, NO credits, recorded as an offline purchase", async () => {
    mockState.row = row({ provider_mode: 'manual' });
    const r = await completePurchase('p1', 'pay_1');
    expect(r).toMatchObject({ success: false, reason: 'non_live_no_grant', providerMode: 'manual' });
    expect(String((r as { detail?: string }).detail)).toMatch(/Usage → Credits → Grant Credits/);
    expect(mockState.credits).toEqual([]);
    expect(mockState.updates[0]).toMatchObject({ fulfillment_error: 'offline_purchase_no_auto_credit' });
  });
  it('CONTROL: NOT production + NULL mode still grants (dev/QA)', async () => {
    mockState.isProd = false;
    mockState.row = row({ provider_mode: null });
    await completePurchase('p1', 'pay_1');
    expect(mockState.credits).toHaveLength(1);
  });
  it('CONTROL: an already-fulfilled test purchase stays an idempotent success (no re-close, no new grant)', async () => {
    mockState.row = row({ status: 'completed', fulfillment_status: 'completed' });
    const r = await completePurchase('p1', 'pay_1');
    expect(r).toMatchObject({ success: true });
    expect(mockState.credits).toEqual([]);
    expect(mockState.updates).toEqual([]);
  });
});

// The verify route states it: no money moved, no credits added - never "paid, credits pending".
describe('POST /api/billing/checkout/verify - a refused test-mode payment', () => {
  const run = async (detail: string, providerMode: unknown = 'test') => {
    jest.resetModules();
    jest.doMock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
    jest.doMock('../../middleware/withOrgAccess', () => ({ withOrgAccess: (h: any) => (req: any, res: any) => { req.orgAccess = { orgId: 'org-1' }; return h(req, res); } }));
    jest.doMock('../../db/supabaseClient', () => ({ supabase: { from: () => {
      const b: any = {}; b.select = () => b; b.eq = () => b;
      b.maybeSingle = async () => ({ data: { id: 'p1', organization_id: 'org-1', status: 'pending', provider: 'razorpay', provider_order_id: 'o1' }, error: null });
      return b;
    } } }));
    jest.doMock('../../services/payments/orchestrator', () => ({ verifyPayment: async () => ({ verified: true }) }));
    jest.doMock('../../services/billing/topupInvoiceService', () => ({ generateTopupInvoice: async () => null }));
    jest.doMock('../../services/billing/purchaseClosureService', () => ({
      closePurchaseFromClient: async () => ({ action: 'closed' }),
      fulfillProviderConfirmedPurchase: async () => ({ ok: false, detail, providerMode }),
    }));
    const verify = require('../../../pages/api/billing/checkout/verify').default;
    const res: any = { statusCode: 0, body: null };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = () => res;
    await verify({ method: 'POST', query: {}, headers: {}, body: { org_id: 'org-1', purchase_id: 'p1', payment_id: 'pay', signature: 's' } }, res);
    return res;
  };
  it('a refused TEST row -> 409 TEST_MODE_PAYMENT_NO_CREDITS (status test_payment, not paid; unchanged for the client)', async () => {
    const r = await run('non_live_no_grant', 'test');
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({ ok: false, status: 'test_payment', code: 'TEST_MODE_PAYMENT_NO_CREDITS' });
  });
  it('PL-162: a refused non-test row is NOT called a test payment (its own code + status)', async () => {
    const r = await run('non_live_no_grant', null);
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({ ok: false, status: 'not_live_payment', code: 'NON_LIVE_PURCHASE_NOT_GRANTABLE' });
  });
  it('CONTROL: any other fulfilment failure keeps the existing 500 "paid, fulfillment failed"', async () => {
    const r = await run('purchase_not_reopenable');
    expect(r.statusCode).toBe(500);
    expect(r.body).toMatchObject({ status: 'paid', fulfillment_status: 'failed' });
  });
});
