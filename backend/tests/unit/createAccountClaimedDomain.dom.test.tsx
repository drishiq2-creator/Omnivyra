/**
 * @jest-environment jsdom
 *
 * CI-309 (2026-11-19): /create-account rendered the admin's masked email from the signup gate's
 * CLAIMED_DOMAIN reply and said "We've emailed <you> with your administrator's contact details". The
 * page now shows one neutral line about the organization's administrator and reads no admin field,
 * even if a server still sent one. REAL: the page. FAKED: router, Supabase browser client, captcha,
 * analytics, fetch.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockRouter = { replace: jest.fn(), push: jest.fn(), query: {}, pathname: '/create-account' };
jest.mock('next/router', () => ({ useRouter: () => mockRouter }));
jest.mock('next/head', () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
jest.mock('../../../lib/supabaseBrowser', () => ({ getSupabaseBrowser: () => ({ auth: { signOut: async () => undefined, signUp: jest.fn() } }) }));
jest.mock('../../../lib/security/sessionClient', () => ({ logoutCurrentSession: async () => undefined }));
jest.mock('../../../lib/websiteAnalytics', () => ({ trackWebsiteEvent: () => undefined }));
jest.mock('../../../components/auth/CaptchaWidget', () => ({ __esModule: true, default: () => null }));

import CreateAccountPage from '../../../pages/create-account';

const pageText = () => document.body.textContent ?? '';

async function submitClaimed(body: Record<string, unknown>) {
  (global as any).fetch = jest.fn(async () => ({ ok: false, status: 409, json: async () => body }));
  render(<CreateAccountPage />);
  fireEvent.change(screen.getByPlaceholderText('you@company.com'), { target: { value: 'sam@victim-co.com' } });
  fireEvent.change(screen.getByPlaceholderText('Your company'), { target: { value: 'Victim Co' } });
  fireEvent.change(screen.getByPlaceholderText('Choose a strong password'), { target: { value: 'Str0ng!Passw0rd#2026' } });
  fireEvent.change(screen.getByPlaceholderText('Repeat your password'), { target: { value: 'Str0ng!Passw0rd#2026' } });
  fireEvent.submit(screen.getByPlaceholderText('you@company.com').closest('form') as HTMLFormElement);
  await waitFor(() => expect(pageText()).toMatch(/already (on|has an) Omnivyra/i));
}

it('CLAIMED_DOMAIN: a neutral administrator line only - no masked admin email, no "contact details" claim', async () => {
  await submitClaimed({
    code: 'CLAIMED_DOMAIN', error: 'An account for your organization already exists.',
    alreadyReferred: false, adminEmailMasked: 've••••@victim-co.com',
  });
  expect(pageText()).toMatch(/your organization's administrator/i);
  expect(pageText()).not.toContain('ve••••');
  expect(pageText()).not.toMatch(/contact details/i);
});

it('CLAIMED_DOMAIN with alreadyReferred=true renders the SAME neutral line (no "already shared with you")', async () => {
  await submitClaimed({ code: 'CLAIMED_DOMAIN', error: 'x', alreadyReferred: true, adminEmailMasked: null });
  expect(pageText()).toMatch(/your organization's administrator/i);
  expect(pageText()).not.toMatch(/already shared/i);
});
