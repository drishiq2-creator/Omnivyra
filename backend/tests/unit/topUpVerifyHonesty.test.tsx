/**
 * @jest-environment jsdom
 *
 * Credit top-up (b3 2026-11-20, BLOCKING, money). /api/billing/checkout/verify runs AFTER the user has paid. A lost or
 * 5xx verify used to say "failed" (often a raw code) and re-enable Buy, inviting a second payment.
 * Now (c6's verify outcomes): credited -> success; 400 status:'failed' -> "not charged"; 500 status:'paid' ->
 * "Payment received; credits being applied" (never "failed"); lost / 5xx / 404 -> "couldn't confirm". For paid/unknown,
 * Buy is DISABLED and "Check again" re-verifies the SAME payment. create-order failures (before any payment) map to
 * copy, never raw codes.
 *
 * SECRETS: none. No network (apiFetch is mocked; window.Razorpay is a fake that "pays" immediately).
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiFetch = jest.fn();
jest.mock('@/lib/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import TopUpPanel from '../../../components/billing/TopUpPanel';
import {
  BLOCKS_NEW_PURCHASE, NOT_CHARGED_ACTIONS, TOPUP_NOT_CHARGED, TOPUP_PAID_PENDING, TOPUP_UNCONFIRMED, VERIFY_OUTCOME_KINDS,
  blocksNewPurchase, classifyVerify, createOrderMessage,
} from '../../../lib/billing/topUpOutcome';

type Answer = { status: number; body?: unknown } | 'throw';
const res = (a: Answer) =>
  a === 'throw'
    ? Promise.reject(new TypeError('Failed to fetch'))
    : Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body ?? {} });
const PACK = { id: 'p1', credits: 250, price: 499, currency: 'INR', label: 'Starter' };
const ORDER_OK = { status: 200, body: { ok: true, provider: 'razorpay', purchase_id: 'pu1', provider_order_id: 'o1', key_id: 'k', amount_subunits: 49900, currency: 'INR' } };

let verifyAnswers: Answer[] = [];
let createOrder: Answer = ORDER_OK;
beforeEach(() => {
  apiFetch.mockReset();
  verifyAnswers = [];
  createOrder = ORDER_OK;
  apiFetch.mockImplementation((url: string) => {
    if (url.includes('/api/billing/topup/catalog')) return res({ status: 200, body: { packs: [PACK] } });
    if (url.includes('/api/billing/checkout/create-order')) return res(createOrder);
    if (url.includes('/api/billing/checkout/verify')) return res(verifyAnswers.length > 1 ? verifyAnswers.shift()! : verifyAnswers[0]);
    return res({ status: 200, body: {} });
  });
  // A Razorpay checkout that "pays" as soon as it opens.
  (window as any).Razorpay = class {
    constructor(private opts: any) {}
    on() {}
    open() { void this.opts.handler({ razorpay_order_id: 'o1', razorpay_payment_id: 'pay1', razorpay_signature: 'sig' }); }
  };
});
afterEach(() => { delete (window as any).Razorpay; });

const verifyCalls = () => apiFetch.mock.calls.filter(([u]) => String(u).includes('/api/billing/checkout/verify'));
const buyButton = () => screen.getByRole('button', { name: /Buy|Processing/ }) as HTMLButtonElement;
async function buy() {
  await waitFor(() => screen.getByRole('button', { name: 'Buy' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Buy' })); });
}

let warn: jest.SpyInstance;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

describe('top-up verify after payment', () => {
  it.each<[string, Answer, string]>([
    ['a lost response (thrown)', 'throw', TOPUP_UNCONFIRMED],
    ["apiFetch's lost connection (503)", { status: 503, body: { error: 'Network unreachable' } }, TOPUP_UNCONFIRMED],
    ['a 5xx', { status: 502, body: {} }, TOPUP_UNCONFIRMED],
    ['404 purchase_not_found (a read failure can land here)', { status: 404, body: { error: 'purchase_not_found' } }, TOPUP_UNCONFIRMED],
    ['500 PAID but fulfilment failed', { status: 500, body: { ok: false, status: 'paid', fulfillment_status: 'failed', error: 'already_completed' } }, TOPUP_PAID_PENDING],
  ])('%s: never "failed"; Buy is DISABLED; "Check again" is offered', async (_n, answer, copy) => {
    verifyAnswers = [answer];
    render(<TopUpPanel orgId="co-a" />);
    await buy();
    await waitFor(() => expect(screen.getByText(new RegExp(copy.slice(0, 30).replace(/[.;']/g, '.')))).toBeTruthy());
    expect(screen.queryByText(/Verification failed|already_completed|purchase_not_found/)).toBeNull();
    expect(buyButton().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  it('"Check again" re-verifies the SAME payment (same ids + derived key) and a success re-enables Buy', async () => {
    verifyAnswers = [{ status: 503 }, { status: 200, body: { ok: true, credits_granted: 250 } }];
    render(<TopUpPanel orgId="co-a" />);
    await buy();
    await waitFor(() => screen.getByRole('button', { name: 'Check again' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check again' })); });
    await waitFor(() => expect(screen.getByText('250 credits added')).toBeTruthy());
    const [a, b] = verifyCalls();
    expect(JSON.parse(String((b[1] as RequestInit).body))).toEqual(JSON.parse(String((a[1] as RequestInit).body)));
    expect(((b[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key'])
      .toBe(((a[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key']);
    expect(buyButton().disabled).toBe(false);
  });

  it.each(['closed', 'already_closed'])('a definitive refusal (400 status:failed, action %s) says "not charged" and allows a new purchase', async (action) => {
    verifyAnswers = [{ status: 400, body: { ok: false, status: 'failed', action } }];
    render(<TopUpPanel orgId="co-a" />);
    await buy();
    await waitFor(() => expect(screen.getByText(TOPUP_NOT_CHARGED)).toBeTruthy());
    expect(buyButton().disabled).toBe(false);
  });

  it.each(['deferred_unknown', 'already_completed', 'errored', 'not_found', 'some_future_action', undefined])('400 status:failed with NON-definitive action %s -> unconfirmed, Buy DISABLED (never "not charged")', async (action) => {
    verifyAnswers = [{ status: 400, body: { ok: false, status: 'failed', ...(action ? { action } : {}) } }];
    render(<TopUpPanel orgId="co-a" />);
    await buy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy());
    expect(screen.queryByText(TOPUP_NOT_CHARGED)).toBeNull();
    expect(buyButton().disabled).toBe(true);
  });

  it('control: a success says credits were added', async () => {
    verifyAnswers = [{ status: 200, body: { ok: true, credits_granted: 250 } }];
    render(<TopUpPanel orgId="co-a" />);
    await buy();
    await waitFor(() => expect(screen.getByText('250 credits added')).toBeTruthy());
  });
});

describe('create-order failures (before any payment)', () => {
  it.each<[string, Answer]>([
    ['500 purchase_record_failed', { status: 500, body: { error: 'purchase_record_failed' } }],
    ['502 order_creation_failed', { status: 502, body: { ok: false, error: 'order_creation_failed' } }],
    ['a lost connection', { status: 503, body: { error: 'Network unreachable' } }],
  ])('%s: plain copy, never the raw code', async (_n, answer) => {
    createOrder = answer;
    render(<TopUpPanel orgId="co-a" />);
    await buy();
    await waitFor(() => expect(screen.getByText(/You weren't charged/)).toBeTruthy());
    expect(screen.queryByText(/purchase_record_failed|order_creation_failed|Network unreachable/)).toBeNull();
    expect(verifyCalls()).toHaveLength(0);
  });

  it('outcome union: BLOCKS_NEW_PURCHASE covers VERIFY_OUTCOME_KINDS in both directions', () => {
    expect(Object.keys(BLOCKS_NEW_PURCHASE).sort()).toEqual([...VERIFY_OUTCOME_KINDS].sort());
  });

  it('outcome union: every kind classifyVerify produces is a member, and every member is producible', () => {
    const produced = new Set([
      classifyVerify(200, { ok: true }),
      ...NOT_CHARGED_ACTIONS.map((action) => classifyVerify(400, { ok: false, status: 'failed', action })),
      classifyVerify(500, { ok: false, status: 'paid' }),
      classifyVerify(null, undefined),
    ].map((o) => o.kind));
    expect([...produced].sort()).toEqual([...VERIFY_OUTCOME_KINDS].sort());
  });

  it('unknown member: an outcome kind outside the union BLOCKS a new purchase (safe default)', () => {
    expect(blocksNewPurchase('some_future_kind')).toBe(true);
    // Control: the known non-blocking kinds really are false, so the line above is not vacuous.
    expect(blocksNewPurchase('credited')).toBe(false);
    expect(blocksNewPurchase('not_charged')).toBe(false);
  });

  it('classifier tables', () => {
    expect(classifyVerify(200, { ok: true, recovered: true }).kind).toBe('credited');
    expect(classifyVerify(400, { ok: false, status: 'failed', action: 'closed' }).kind).toBe('not_charged');
    expect(classifyVerify(400, { ok: false, status: 'failed' }).kind).toBe('unconfirmed');
    expect(classifyVerify(400, { ok: false, status: 'failed', action: 'deferred_unknown' }).kind).toBe('unconfirmed');
    expect(classifyVerify(500, { ok: false, status: 'paid' }).kind).toBe('paid_pending');
    expect([null, 404, 400, 503].map((s) => classifyVerify(s, { error: 'x' }).kind)).toEqual(['unconfirmed', 'unconfirmed', 'unconfirmed', 'unconfirmed']);
    expect(createOrderMessage({ error: 'package_lookup_failed:timeout' })).toMatch(/weren't charged/);
    expect(createOrderMessage({ error: 'package_not_available' })).toBe("This credit pack isn't available right now.");
  });
});
