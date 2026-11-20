/**
 * MONEY unread-error sites (2026-11-12): the settlement chokepoint and the
 * top-up tax invoice.
 *
 *  - fulfillProviderConfirmedPurchase:102 - a failed read is code UNAVAILABLE
 *    (retryable), never 'purchase_not_found'; nothing is completed.
 *  - closePurchaseFromClient:295 - a failed read throws, never 'not_found'
 *    (which the routes answer 404 to a payer).
 *  - generateTopupInvoice - every step checked: an invoice is NEVER issued
 *    without its line item, a failure leaves a DRAFT, and the next call RESUMES
 *    the draft instead of returning it as if issued.
 */
export {};
type Res = { data?: unknown; error: { message: string } | null };
let mockScript: Record<string, (n: number) => Res> = {};
const mockCalls: Record<string, number> = {};
const mockWrites: Array<{ table: string; op: string; payload?: unknown }> = [];
const mockCompleted: string[] = [];

function mockBuilder(table: string) {
  let op = 'select';
  const b: any = {};
  const result = () => {
    const k = table + ':' + op;
    mockCalls[k] = (mockCalls[k] ?? 0) + 1;
    return (mockScript[k] ?? (() => ({ data: null, error: null })))(mockCalls[k]);
  };
  for (const m of ['select', 'eq', 'in', 'limit', 'order']) b[m] = () => b;
  b.insert = (p: unknown) => { op = 'insert'; mockWrites.push({ table, op, payload: p }); return b; };
  b.update = (p: unknown) => { op = 'update'; mockWrites.push({ table, op, payload: p }); return b; };
  b.maybeSingle = async () => result();
  b.single = async () => result();
  b.then = (ok: (v: Res) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, ko);
  return b;
}
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => mockBuilder(t) } }));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => mockBuilder(t) }));
jest.mock('../../services/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.mock('../../services/purchaseService', () => ({
  completePurchase: async (id: string) => { mockCompleted.push(id); return { success: true, creditsGranted: 10 }; },
  reopenSystemClosedPurchase: async () => ({ ok: true }),
}));
jest.mock('../../services/payments/orchestrator', () => ({ resolveProviderOrderOutcome: async () => ({ outcome: 'paid' }) }));

import { fulfillProviderConfirmedPurchase, closePurchaseFromClient } from '../../services/billing/purchaseClosureService';
import { generateTopupInvoice } from '../../services/billing/topupInvoiceService';

const DOWN = () => ({ data: null, error: { message: 'down' } });
const PAID_PURCHASE = { id: 'p1', organization_id: 'o1', credits: 100, amount_paid: 500, currency: 'INR', provider: 'razorpay', reference_id: null, status: 'completed', created_at: '2026-11-01T00:00:00Z' };

beforeEach(() => {
  mockScript = {};
  for (const k of Object.keys(mockCalls)) delete mockCalls[k];
  mockWrites.length = 0; mockCompleted.length = 0;
});

describe('settlement chokepoint', () => {
  it('fulfil: purchase read error -> code UNAVAILABLE (retryable), NOT purchase_not_found; nothing completed', async () => {
    mockScript['credit_purchases:select'] = DOWN;
    const r = await fulfillProviderConfirmedPurchase('p1', 'pay_1', { amountSubunits: 50000, currency: 'INR' });
    expect(r).toMatchObject({ ok: false, code: 'UNAVAILABLE', detail: 'purchase_read_failed' });
    expect(mockCompleted).toEqual([]);
  });

  it('control: a genuinely absent purchase is still purchase_not_found (UNKNOWN)', async () => {
    const r = await fulfillProviderConfirmedPurchase('p1', 'pay_1', { amountSubunits: 50000, currency: 'INR' });
    expect(r).toMatchObject({ ok: false, code: 'UNKNOWN', detail: 'purchase_not_found' });
  });

  it('client close: purchase read error THROWS, never not_found', async () => {
    mockScript['credit_purchases:select'] = DOWN;
    await expect(closePurchaseFromClient({ purchaseId: 'p1', organizationId: 'o1', reason: 'client_cancelled' }))
      .rejects.toThrow(/purchase read failed/);
  });
});

describe('top-up invoice', () => {
  const issuedUpdates = () => mockWrites.filter((w) => w.table === 'invoices' && w.op === 'update');

  it('purchase read error -> throws (caller logs "invoice deferred"), nothing written', async () => {
    mockScript['credit_purchases:select'] = DOWN;
    await expect(generateTopupInvoice('p1')).rejects.toThrow(/purchase read failed/);
    expect(mockWrites).toEqual([]);
  });

  it('line-item insert fails -> throws and the invoice is NOT issued (stays draft)', async () => {
    mockScript['credit_purchases:select'] = () => ({ data: PAID_PURCHASE, error: null });
    mockScript['invoices:insert'] = () => ({ data: { id: 'inv1' }, error: null });
    mockScript['invoice_line_items:select'] = () => ({ data: [], error: null });
    mockScript['invoice_line_items:insert'] = DOWN;
    await expect(generateTopupInvoice('p1')).rejects.toThrow(/line-item insert failed/);
    expect(issuedUpdates()).toEqual([]);
  });

  it('an existing DRAFT is RESUMED (line item added, then issued), never returned as if issued', async () => {
    mockScript['credit_purchases:select'] = () => ({ data: PAID_PURCHASE, error: null });
    mockScript['invoices:select'] = () => ({ data: { id: 'inv1', invoice_number: 'x', status: 'draft' }, error: null });
    mockScript['invoice_line_items:select'] = () => ({ data: [], error: null });
    mockScript['invoices:update'] = () => ({ data: [{ id: 'inv1' }], error: null });
    const r = await generateTopupInvoice('p1');
    expect(r).toMatchObject({ invoiceId: 'inv1', created: false });
    const order = mockWrites.map((w) => `${w.table}:${w.op}`);
    expect(order).toEqual(['invoice_line_items:insert', 'invoices:update']);
  });

  it('an existing ISSUED invoice is returned untouched', async () => {
    mockScript['credit_purchases:select'] = () => ({ data: PAID_PURCHASE, error: null });
    mockScript['invoices:select'] = () => ({ data: { id: 'inv1', invoice_number: 'x', status: 'paid' }, error: null });
    const r = await generateTopupInvoice('p1');
    expect(r).toMatchObject({ invoiceId: 'inv1', created: false });
    expect(mockWrites).toEqual([]);
  });

  it('issue update error -> throws (draft left for the next call), never "created"', async () => {
    mockScript['credit_purchases:select'] = () => ({ data: PAID_PURCHASE, error: null });
    mockScript['invoices:insert'] = () => ({ data: { id: 'inv1' }, error: null });
    mockScript['invoice_line_items:select'] = () => ({ data: [], error: null });
    mockScript['invoices:update'] = DOWN;
    await expect(generateTopupInvoice('p1')).rejects.toThrow(/issue failed/);
  });

  it('control: the happy path inserts the line item BEFORE issuing', async () => {
    mockScript['credit_purchases:select'] = () => ({ data: PAID_PURCHASE, error: null });
    mockScript['invoices:insert'] = () => ({ data: { id: 'inv1' }, error: null });
    mockScript['invoice_line_items:select'] = () => ({ data: [], error: null });
    mockScript['invoices:update'] = () => ({ data: [{ id: 'inv1' }], error: null });
    const r = await generateTopupInvoice('p1');
    expect(r).toMatchObject({ invoiceId: 'inv1', created: true });
    expect(mockWrites.map((w) => `${w.table}:${w.op}`)).toEqual(['invoices:insert', 'invoice_line_items:insert', 'invoices:update']);
  });
});

// 04/7c 2026-11-20: a lost close-CAS means "no longer pending" - a concurrent completion OR a concurrent close. It used
// to answer already_completed unconditionally; the row is now re-read and reported as what it is.
describe('client close - CAS lost: re-read the row, never assume completion', () => {
  const PENDING = { ...PAID_PURCHASE, status: 'pending', provider_order_id: 'order_1', provider_payload: {} };
  const lostCas = (reread: Res) => {
    mockScript['credit_purchases:select'] = (n) => (n === 1 ? { data: PENDING, error: null } : reread);
    mockScript['credit_purchases:update'] = () => ({ data: null, error: null }); // CAS matched 0 rows
    jest.requireMock('../../services/payments/orchestrator').resolveProviderOrderOutcome = async () => ({ outcome: 'unpaid' });
  };
  afterEach(() => {
    jest.requireMock('../../services/payments/orchestrator').resolveProviderOrderOutcome = async () => ({ outcome: 'paid' });
  });
  it.each([
    ['completed', 'completed', 'already_completed'],
    ['completed', 'event_recorded', 'deferred_unknown'], // completed but credits not yet granted: NOT paid
    ['failed', 'failed', 'already_closed'],
    ['pending', 'pending', 'deferred_unknown'],
  ])('re-read status %s / fulfillment %s -> %s', async (status, fulfillment_status, action) => {
    lostCas({ data: { status, fulfillment_status }, error: null });
    const r = await closePurchaseFromClient({ purchaseId: 'p1', organizationId: 'o1', reason: 'client_reported_failure' });
    expect(r.action).toBe(action);
    expect(mockCalls['credit_purchases:select']).toBe(2); // PREMISE: the re-read happened
  });
  it('re-read ERROR -> deferred_unknown (never already_completed)', async () => {
    lostCas(DOWN());
    const r = await closePurchaseFromClient({ purchaseId: 'p1', organizationId: 'o1', reason: 'client_reported_failure' });
    expect(r).toMatchObject({ action: 'deferred_unknown', detail: 'reread_failed' });
  });
  it('CONTROL: CAS won -> closed, no re-read', async () => {
    lostCas({ data: { status: 'completed' }, error: null });
    mockScript['credit_purchases:update'] = () => ({ data: { id: 'p1' }, error: null });
    const r = await closePurchaseFromClient({ purchaseId: 'p1', organizationId: 'o1', reason: 'client_reported_failure' });
    expect(r.action).toBe('closed');
    expect(mockCalls['credit_purchases:select']).toBe(1);
  });
});

describe('client close - a row read as completed is "already_completed" only once the credits are granted', () => {
  const close = () => closePurchaseFromClient({ purchaseId: 'p1', organizationId: 'o1', reason: 'client_reported_failure' });
  it('status completed + fulfillment event_recorded -> deferred_unknown (credits not proven)', async () => {
    mockScript['credit_purchases:select'] = () => ({ data: { ...PAID_PURCHASE, fulfillment_status: 'event_recorded' }, error: null });
    expect((await close()).action).toBe('deferred_unknown');
  });
  it('CONTROL: status completed + fulfillment completed -> already_completed', async () => {
    mockScript['credit_purchases:select'] = () => ({ data: { ...PAID_PURCHASE, fulfillment_status: 'completed' }, error: null });
    expect((await close()).action).toBe('already_completed');
  });
});
