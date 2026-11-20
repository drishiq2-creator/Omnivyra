/**
 * @jest-environment jsdom
 *
 * Top-up is CLOSED until live payments (04, 2026-11-20; b3/owner, after c6's hotfix #73 dc205c3dd). In production on
 * test keys, completePurchase refuses to grant credits for a test-mode purchase, so a purchase started there can
 * never complete. The catalog says `purchases_open`, and the panel shows "Buying credits opens soon" with no live Buy
 * unless it is explicitly true.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

let prod = true;
jest.mock('../../services/config/productionFlags', () => ({ isProduction: () => prod }));

const apiFetch = jest.fn();
jest.mock('@/lib/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { isTopUpPurchaseOpen } from '../../services/billing/topUpAvailability';
import catalogHandler from '../../../pages/api/billing/topup/catalog';
import TopUpPanel, { TOPUP_CLOSED_NOTICE } from '../../../components/billing/TopUpPanel';

const PACK = { id: 'p1', credits: 250, price: 499, currency: 'INR', label: '250 credits' };
const savedMode = process.env.PAYMENT_PROVIDER_MODE;
afterEach(() => { process.env.PAYMENT_PROVIDER_MODE = savedMode; prod = true; });

describe('isTopUpPurchaseOpen: the same condition completePurchase refuses on', () => {
  it.each<[boolean, string | undefined, boolean]>([
    [true, undefined, false], // prod, PAYMENT_PROVIDER_MODE unset → test → CLOSED (today's prod)
    [true, 'test', false],
    [true, 'something-else', false],
    [true, 'live', true],     // the owner's go-live
    [false, undefined, true], // dev/QA: test purchases stay open to test the flow
  ])('production=%s, mode=%s → open=%s', (isProd, mode, open) => {
    prod = isProd;
    if (mode === undefined) delete process.env.PAYMENT_PROVIDER_MODE; else process.env.PAYMENT_PROVIDER_MODE = mode;
    expect(isTopUpPurchaseOpen()).toBe(open);
  });

  it('the catalog route reports it as purchases_open', () => {
    prod = true; delete process.env.PAYMENT_PROVIDER_MODE;
    const res: any = { statusCode: 0, body: undefined, setHeader: () => res, status: (c: number) => { res.statusCode = c; return res; }, json: (b: unknown) => { res.body = b; return res; } };
    (catalogHandler as any)({ method: 'GET' }, res);
    expect(res.body.purchases_open).toBe(false);
  });
});

describe('TopUpPanel', () => {
  const answer = (catalog: unknown) => {
    apiFetch.mockReset();
    apiFetch.mockImplementation((url: string) => Promise.resolve({
      ok: true, status: 200,
      json: async () => (url.includes('/topup/catalog') ? catalog : url.includes('history') ? { purchases: [] } : { buckets: [] }),
    }));
  };

  it.each<[string, unknown]>([
    ['purchases_open: false', { packs: [PACK], purchases_open: false }],
    ['purchases_open MISSING (older server / unreadable): fails CLOSED', { packs: [PACK] }],
  ])('%s → "opens soon" notice, Buy disabled, no checkout can start', async (_n, catalog) => {
    answer(catalog);
    render(<TopUpPanel orgId="org-1" />);
    await waitFor(() => expect(screen.getByText(TOPUP_CLOSED_NOTICE)).toBeTruthy());
    const btn = screen.getByRole('button', { name: 'Opens soon' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await act(async () => { fireEvent.click(btn); });
    expect(apiFetch.mock.calls.some(([u]) => String(u).includes('create-order'))).toBe(false);
  });

  it('control: purchases_open: true → Buy enabled, no notice', async () => {
    answer({ packs: [PACK], purchases_open: true });
    render(<TopUpPanel orgId="org-1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Buy' })).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Buy' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(TOPUP_CLOSED_NOTICE)).toBeNull();
  });

  it('the notice promises nothing about timing or payment', () => {
    expect(TOPUP_CLOSED_NOTICE).not.toMatch(/today|tomorrow|\d+ (day|hour)|pay now|card/i);
  });
});
