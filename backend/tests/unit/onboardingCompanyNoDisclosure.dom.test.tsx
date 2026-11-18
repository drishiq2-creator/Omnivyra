/**
 * @jest-environment jsdom
 *
 * CI-309 (2026-11-19): /onboarding/company rendered another company's name and its administrator's name
 * from /api/onboarding/company-domain-check (:184-186) and from POST /api/onboarding/setup-company
 * (:254-259). The page now shows only a neutral line about "your organization's administrator" (or the
 * server's neutral `message`) and reads no company / admin field - even if a server still sent them.
 * REAL: the page. FAKED: router, Supabase session, auth token, apiFetch (route -> canned response),
 * company context.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockReplace = jest.fn();
// One stable router object, as in Next.js (the page's load effect depends on it).
const mockRouter = { replace: (...a: unknown[]) => mockReplace(...a), push: jest.fn(), query: {}, pathname: '/onboarding/company' };
jest.mock('next/router', () => ({ useRouter: () => mockRouter }));
jest.mock('next/head', () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
jest.mock('../../../lib/supabaseBrowser', () => ({
  getSupabaseBrowser: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
      getUser: async () => ({ data: { user: { id: 'u-1' } } }),
    },
  }),
}));
jest.mock('../../../utils/getAuthToken', () => ({ getAuthToken: async () => 'tok' }));
jest.mock('../../../components/CompanyContext', () => ({ useCompanyContext: () => ({ refreshCompanies: async () => undefined }) }));
type Canned = { status: number; body: unknown };
const mockRoutes: Record<string, Canned> = {};
const mockCalls: string[] = [];
jest.mock('../../../lib/apiFetch', () => ({
  apiFetch: async (url: string) => {
    mockCalls.push(url);
    const key = Object.keys(mockRoutes).find((k) => url.startsWith(k));
    const c = key ? mockRoutes[key] : { status: 404, body: {} };
    return { ok: c.status >= 200 && c.status < 300, status: c.status, json: async () => c.body } as unknown as Response;
  },
}));

import CompanyOnboardingPage from '../../../pages/onboarding/company';

const VICTIM_NAME = 'Victim Corp';
const ADMIN_NAME = 'Vera Victimadmin';

beforeEach(() => {
  for (const k of Object.keys(mockRoutes)) delete mockRoutes[k];
  mockCalls.length = 0;
  mockRoutes['/api/onboarding/validated-identity'] = { status: 200, body: { websiteUrl: null } };
  mockRoutes['/api/company-profile?mode=list'] = { status: 200, body: { companies: [] } };
  mockRoutes['/api/onboarding/company-domain-check'] = { status: 200, body: { matched: false } };
  try { localStorage.clear(); } catch { /* ignore */ }
});

const pageText = () => document.body.textContent ?? '';
/** The page's on-load checks finish before the form is used (they end by settling the step). */
async function formReady() {
  const name = await screen.findByPlaceholderText('Acme Inc.');
  await waitFor(() => expect(mockCalls).toContain('/api/onboarding/company-domain-check'));
  await new Promise((r) => setTimeout(r, 0));
  return name;
}

it('domain check matched: a neutral administrator line only - no company or admin name, even if the server sent them', async () => {
  mockRoutes['/api/onboarding/company-domain-check'] = { status: 200, body: { matched: true, companyId: 'co-v', companyName: VICTIM_NAME, adminName: ADMIN_NAME } };
  render(<CompanyOnboardingPage />);
  await screen.findByText(/already on Omnivyra/i);
  expect(pageText()).toMatch(/your organization's administrator/i);
  expect(pageText()).not.toContain(VICTIM_NAME);
  expect(pageText()).not.toContain('Vera');
});

it("setup-company join request: renders the server's neutral message, never a company or admin name", async () => {
  const MESSAGE = "Your organization already uses Omnivyra. Your request to join was sent to your organization's administrator.";
  mockRoutes['/api/onboarding/setup-company'] = { status: 200, body: { companyExists: true, joinRequested: true, message: MESSAGE, matchedCompanyName: VICTIM_NAME, adminName: ADMIN_NAME } };
  render(<CompanyOnboardingPage />);
  const name = await formReady();
  fireEvent.change(name, { target: { value: 'Typed Name Ltd' } });
  fireEvent.submit(name.closest('form') as HTMLFormElement);
  await waitFor(() => expect(pageText()).toContain(MESSAGE));
  expect(pageText()).not.toContain(VICTIM_NAME);
  expect(pageText()).not.toContain('Vera');
  expect(pageText()).not.toContain('Typed Name Ltd already has a workspace');
});

it('control: a 409 COMPANY_DOMAIN_AMBIGUOUS shows the server error and stays on the form', async () => {
  mockRoutes['/api/onboarding/setup-company'] = { status: 409, body: { code: 'COMPANY_DOMAIN_AMBIGUOUS', error: 'Your company could not be resolved. Please contact support.' } };
  render(<CompanyOnboardingPage />);
  const name = await formReady();
  fireEvent.change(name, { target: { value: 'Typed Name Ltd' } });
  fireEvent.submit(name.closest('form') as HTMLFormElement);
  await waitFor(() => expect(pageText()).toContain('Your company could not be resolved. Please contact support.'));
});
