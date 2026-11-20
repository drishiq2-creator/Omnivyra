/**
 * @jest-environment jsdom
 *
 * Billing shell — org-context → provider-endpoint propagation tests.
 *
 * Covers: the shell fetches /api/billing/context, then RELAYS the resolved
 * country+currency verbatim as query params to /api/billing/payment-providers;
 * geography-filtered rendering; unsupported-region empty state; the frontend
 * does NO filtering of its own; hidden-pricing preservation.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// next/head — render children inline so jsdom is happy.
jest.mock('next/head', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import BillingShellPage from '../../../pages/billing/index';

interface FetchCall { url: string; method?: string }
let __calls: FetchCall[] = [];

/** Install a fetch mock: context responds first, providers second. */
type ContextAnswer = { country: string | null; currency: string | null; region?: string | null } | { __status: number } | 'throw';
function installFetch(opts: {
  context: ContextAnswer | (() => ContextAnswer);
  profile?: { __status: number; body: unknown };
  providers: (url: string) => { visible: any[]; supported_methods: string[]; recommended: string | null } | { __status: number };
}) {
  __calls = [];
  (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    __calls.push({ url, method: init?.method });
    if (url.startsWith('/api/billing/profile')) {
      const pr = opts.profile ?? { __status: 200, body: { captured: true } };
      return { ok: pr.__status >= 200 && pr.__status < 300, status: pr.__status, json: async () => pr.body };
    }
    if (url.startsWith('/api/billing/context')) {
      const c = typeof opts.context === 'function' ? opts.context() : opts.context;
      if (c === 'throw') throw new TypeError('Failed to fetch');
      if ('__status' in c) {
        return { ok: false, status: c.__status, json: async () => ({ error: 'billing_context_unreadable', code: 'BILLING_CONTEXT_UNREADABLE' }) };
      }
      return { ok: true, status: 200, json: async () => c };
    }
    if (url.startsWith('/api/billing/payment-providers')) {
      const r = opts.providers(url);
      if ('__status' in r) return { ok: false, status: r.__status, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => r };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

afterEach(() => { delete (global as any).fetch; });

describe('billing shell — context → provider propagation', () => {
  test('relays resolved country + currency verbatim as query params', async () => {
    installFetch({
      context: { country: 'IN', currency: 'INR' },
      providers: () => ({
        visible: [{ provider: 'razorpay', supported_payment_methods: ['upi'] }],
        supported_methods: ['upi'], recommended: null,
      }),
    });
    render(<BillingShellPage />);
    await waitFor(() => expect(screen.getByTestId('billing-shell').getAttribute('data-state')).toBe('ready'));

    const providerCall = __calls.find((c) => c.url.startsWith('/api/billing/payment-providers'))!;
    expect(providerCall.url).toContain('country=IN');
    expect(providerCall.url).toContain('currency=INR');
    // context fetched BEFORE providers.
    expect(__calls[0].url).toContain('/api/billing/context');
  });

  test('null context → no query params relayed (backend returns unrestricted list)', async () => {
    installFetch({
      context: { country: null, currency: null },
      providers: (url) => {
        expect(url).toBe('/api/billing/payment-providers'); // no '?'
        return { visible: [{ provider: 'razorpay' }], supported_methods: [], recommended: null };
      },
    });
    render(<BillingShellPage />);
    await waitFor(() => expect(screen.getByTestId('billing-shell').getAttribute('data-state')).toBe('ready'));
    const providerCall = __calls.find((c) => c.url.startsWith('/api/billing/payment-providers'))!;
    expect(providerCall.url).not.toContain('?');
  });

  // INVERTED (Rule 1, c6 2026-11-20). This test used to pin "context fetch failure is non-fatal: shell still queries
  // providers unrestricted", i.e. an unreadable context rendered as "no billing profile".
  test.each<[string, ContextAnswer]>([
    ['503 BILLING_CONTEXT_UNREADABLE', { __status: 503 }],
    ['500', { __status: 500 }],
    ['a lost connection (thrown)', 'throw'],
  ])('context %s: honest error + Retry; NO empty form, NO provider query on unread geography', async (_n, answer) => {
    installFetch({ context: answer, providers: () => ({ visible: [{ provider: 'razorpay' }], supported_methods: [], recommended: null }) });
    render(<BillingShellPage />);
    await waitFor(() => expect(screen.getByTestId('billing-context-failed')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain("We couldn't load your billing details.");
    expect(screen.queryByLabelText(/country/i)).toBeNull();
    expect(screen.queryByTestId('billing-shell')).toBeNull();
    expect(__calls.some((c) => c.url.startsWith('/api/billing/payment-providers'))).toBe(false);
  });

  test('Retry re-reads the context; success then prefills the form and queries providers with it', async () => {
    let n = 0;
    installFetch({
      context: () => (++n === 1 ? { __status: 503 } : { country: 'IN', currency: 'INR', region: null }),
      providers: () => ({ visible: [{ provider: 'razorpay' }], supported_methods: [], recommended: null }),
    });
    render(<BillingShellPage />);
    await waitFor(() => screen.getByTestId('billing-context-failed'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    await waitFor(() => expect(screen.getByTestId('billing-shell').getAttribute('data-state')).toBe('ready'));
    expect(__calls.filter((c) => c.url.startsWith('/api/billing/context'))).toHaveLength(2);
    expect((screen.getByDisplayValue('IN') as HTMLInputElement).value).toBe('IN');
    expect(__calls.find((c) => c.url.startsWith('/api/billing/payment-providers'))!.url).toContain('country=IN');
  });

  test('empty-success control: a readable context with no geography shows the EMPTY form, no error', async () => {
    installFetch({
      context: { country: null, currency: null, region: null },
      providers: () => ({ visible: [{ provider: 'razorpay' }], supported_methods: [], recommended: null }),
    });
    render(<BillingShellPage />);
    await waitFor(() => expect(screen.getByTestId('billing-shell').getAttribute('data-state')).toBe('ready'));
    expect(screen.queryByTestId('billing-context-failed')).toBeNull();
    expect(screen.getByTestId('bpf-submit')).toBeTruthy();
  });

  test('saved geography PREFILLS the form (it used to mount before the read and never prefill)', async () => {
    installFetch({
      context: { country: 'IN', currency: 'INR', region: 'south' },
      providers: () => ({ visible: [{ provider: 'razorpay' }], supported_methods: [], recommended: null }),
    });
    render(<BillingShellPage />);
    await waitFor(() => expect(screen.getByTestId('billing-shell').getAttribute('data-state')).toBe('ready'));
    expect(screen.getByDisplayValue('IN')).toBeTruthy();
    expect(screen.getByDisplayValue('INR')).toBeTruthy();
    expect(screen.getByDisplayValue('south')).toBeTruthy();
  });

  test('PUT saved but the re-read failed (200 reread: billing_context_unreadable): "couldn\'t load" + "Your changes were saved."', async () => {
    let n = 0;
    installFetch({
      context: () => (++n === 1 ? { country: 'IN', currency: 'INR', region: null } : { __status: 503 }),
      profile: { __status: 200, body: { captured: true, organization_id: 'o1', reread: 'billing_context_unreadable' } },
      providers: () => ({ visible: [{ provider: 'razorpay' }], supported_methods: [], recommended: null }),
    });
    render(<BillingShellPage />);
    await waitFor(() => screen.getByTestId('bpf-submit'));
    await act(async () => { fireEvent.click(screen.getByTestId('bpf-submit')); });
    await waitFor(() => screen.getByTestId('billing-context-failed'));
    expect(screen.getByRole('alert').textContent).toContain('Your changes were saved.');
    expect(__calls.some((c) => c.url.startsWith('/api/billing/profile') && c.method === 'PUT')).toBe(true);
  });

  test('providers 503 (server could not read context): provider error + a Retry that re-reads', async () => {
    let n = 0;
    installFetch({
      context: { country: 'IN', currency: 'INR', region: null },
      providers: () => (++n === 1 ? { __status: 503 } : { visible: [{ provider: 'razorpay' }], supported_methods: [], recommended: null }),
    });
    render(<BillingShellPage />);
    await waitFor(() => expect(screen.getByTestId('billing-shell').getAttribute('data-state')).toBe('error'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    await waitFor(() => expect(screen.getByTestId('billing-shell').getAttribute('data-state')).toBe('ready'));
    expect(__calls.filter((c) => c.url.startsWith('/api/billing/payment-providers'))).toHaveLength(2);
  });
});

describe('billing shell — geography-filtered rendering', () => {
  test('renders exactly the geography-filtered providers the backend returned', async () => {
    installFetch({
      context: { country: 'IN', currency: 'INR' },
      providers: () => ({
        visible: [{ provider: 'razorpay', supported_payment_methods: ['upi', 'card'] }],
        supported_methods: ['card', 'upi'], recommended: null,
      }),
    });
    render(<BillingShellPage />);
    await waitFor(() => expect(screen.getByTestId('billing-shell').getAttribute('data-state')).toBe('ready'));
    const cards = screen.getAllByTestId('provider-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('data-provider')).toBe('razorpay');
  });

  test('unsupported region → backend returns empty list → graceful empty state', async () => {
    installFetch({
      context: { country: 'AQ', currency: 'XYZ' }, // unsupported region/currency
      providers: () => ({ visible: [], supported_methods: [], recommended: null }),
    });
    render(<BillingShellPage />);
    await waitFor(() => expect(screen.getByTestId('billing-shell').getAttribute('data-state')).toBe('empty'));
    expect(screen.queryAllByTestId('provider-card')).toHaveLength(0);
    expect(screen.getByText(/no payment providers/i)).toBeTruthy();
  });

  test('frontend does NO filtering — renders backend list verbatim even if larger', async () => {
    installFetch({
      context: { country: 'IN', currency: 'INR' },
      providers: () => ({
        visible: [{ provider: 'p1' }, { provider: 'p2' }, { provider: 'p3' }],
        supported_methods: [], recommended: null,
      }),
    });
    render(<BillingShellPage />);
    await waitFor(() => expect(screen.getByTestId('billing-shell').getAttribute('data-state')).toBe('ready'));
    expect(screen.getAllByTestId('provider-card')).toHaveLength(3);
  });
});

describe('billing shell — hidden-pricing preservation', () => {
  test('no price/amount/currency-symbol text rendered after geography fetch', async () => {
    installFetch({
      context: { country: 'IN', currency: 'INR' },
      providers: () => ({
        visible: [{ provider: 'razorpay', supported_payment_methods: ['upi'], topups_enabled: true }],
        supported_methods: ['upi'], recommended: null,
      }),
    });
    const { container } = render(<BillingShellPage />);
    await waitFor(() => expect(screen.getByTestId('billing-shell').getAttribute('data-state')).toBe('ready'));
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toMatch(/[$₹€£]/);
    for (const w of ['price', 'pricing', 'amount', 'plan', 'per month', 'subtotal', 'invoice total']) {
      expect(text).not.toContain(w);
    }
  });
});
