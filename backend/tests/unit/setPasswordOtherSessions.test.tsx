/**
 * @jest-environment jsdom
 *
 * S1 (2026-11-20; server contract from 89): POST /api/auth/set-password may answer 200 with
 * code OTHER_SESSIONS_NOT_SIGNED_OUT. Then (b3):
 * - the 1.2 s success auto-redirect does NOT fire; the user continues explicitly;
 * - a prominent notice (role=alert, not a toast) says the other devices weren't signed out;
 * - its button calls POST /api/auth/sessions/revoke { revokeAll: true } and reports done / refused / unknown.
 * Control: a plain success still auto-redirects.
 *
 * SECRETS: none. No network (apiFetch and the Supabase browser client are mocked).
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const replace = jest.fn();
jest.mock('next/router', () => ({ useRouter: () => ({ replace, push: jest.fn(), query: {}, pathname: '/auth/set-password' }) }));
jest.mock('next/head', () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
jest.mock('../../../lib/supabaseBrowser', () => ({
  getSupabaseBrowser: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'at', user: { id: 'u1', email: 'a@b.test' } } } }) },
  }),
}));
const clearBrowserAuthState = jest.fn();
jest.mock('../../../utils/authStorage', () => ({ clearBrowserAuthState: (...a: unknown[]) => clearBrowserAuthState(...a) }));
const apiFetch = jest.fn();
jest.mock('../../../lib/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import SetPasswordPage from '../../../pages/auth/set-password';
import fs from 'fs';
import path from 'path';
import {
  OTHER_SESSIONS_NOT_SIGNED_OUT,
  OTHER_SESSIONS_NOTICE,
  SIGN_OUT_OTHERS_COPY,
  SIGN_OUT_OTHERS_OUTCOMES,
  SIGN_OUT_OTHERS_TIMEOUT_MS,
  SIGN_OUT_OTHERS_DONE,
  SIGN_OUT_OTHERS_LABEL,
  SIGN_OUT_OTHERS_REFUSED,
  SIGN_OUT_OTHERS_UNKNOWN,
  classifySignOutOthers,
  otherSessionsNotSignedOut,
} from '../../../lib/auth/setPasswordOutcome';

const ok = (body: unknown, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const PW = 'Correct-horse-battery-9';

async function submitPassword() {
  await waitFor(() => screen.getByPlaceholderText('Choose a strong password'));
  fireEvent.change(screen.getByPlaceholderText('Choose a strong password'), { target: { value: PW } });
  fireEvent.change(screen.getByPlaceholderText('Repeat your password'), { target: { value: PW } });
  await act(async () => { fireEvent.submit(screen.getByPlaceholderText('Choose a strong password').closest('form')!); });
}

let warn: jest.SpyInstance;
beforeEach(() => {
  replace.mockReset();
  apiFetch.mockReset();
  clearBrowserAuthState.mockReset();
  window.sessionStorage.setItem('auth_flow_session_established_v1', '1');
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); jest.useRealTimers(); });

describe('set-password: OTHER_SESSIONS_NOT_SIGNED_OUT', () => {
  it('keys on the code, not on the missing flag', () => {
    expect(otherSessionsNotSignedOut({ success: true, code: 'OTHER_SESSIONS_NOT_SIGNED_OUT' })).toBe(true);
    expect(otherSessionsNotSignedOut({ success: true, otherSessionsSignedOut: false })).toBe(false);
    expect(otherSessionsNotSignedOut({ success: true })).toBe(false);
  });

  it('the auto-redirect does NOT fire; a prominent notice and an explicit Continue are shown', async () => {
    apiFetch.mockImplementation((url: string) =>
      url === '/api/auth/set-password' ? ok({ success: true, route: '/dashboard', otherSessionsSignedOut: false, code: 'OTHER_SESSIONS_NOT_SIGNED_OUT' }) : ok({}),
    );
    render(<SetPasswordPage />);
    await submitPassword();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(OTHER_SESSIONS_NOTICE));
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });

  it('control: a plain success still auto-redirects after 1.2 s', async () => {
    apiFetch.mockImplementation(() => ok({ success: true, route: '/dashboard' }));
    render(<SetPasswordPage />);
    await submitPassword();
    await waitFor(() => screen.getByText('Password set!'));
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'), { timeout: 2500 });
  });

  it.each<[string, number | 'throw', string, string]>([
    ['done (200)', 200, SIGN_OUT_OTHERS_DONE, '/login'],
    ['refused (403)', 403, SIGN_OUT_OTHERS_REFUSED, '/dashboard'],
    ['unknown (503, lost connection)', 503, SIGN_OUT_OTHERS_UNKNOWN, '/dashboard'],
    ['unknown (thrown)', 'throw', SIGN_OUT_OTHERS_UNKNOWN, '/dashboard'],
  ])('the button calls revokeAll and reports %s', async (_n, revokeAnswer, copy, continueTo) => {
    apiFetch.mockImplementation((url: string) => {
      if (url === '/api/auth/set-password') return ok({ success: true, route: '/dashboard', code: 'OTHER_SESSIONS_NOT_SIGNED_OUT' });
      if (revokeAnswer === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
      return ok({}, revokeAnswer);
    });
    render(<SetPasswordPage />);
    await submitPassword();
    await waitFor(() => screen.getByRole('button', { name: SIGN_OUT_OTHERS_LABEL }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: SIGN_OUT_OTHERS_LABEL })); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(copy));
    const revoke = apiFetch.mock.calls.find(([u]) => u === '/api/auth/sessions/revoke');
    expect(JSON.parse(String((revoke![1] as RequestInit).body))).toEqual({ revokeAll: true });
    expect(screen.queryByRole('button', { name: SIGN_OUT_OTHERS_LABEL })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(replace).toHaveBeenCalledWith(continueTo);
  });

  it.each<[string, number | 'throw', boolean]>([
    ['done', 200, true],
    ['refused', 403, false],
    ['unknown', 503, false],
  ])('%s: browser auth state is cleared ONLY when revokeAll succeeded (it ends this session too)', async (_n, revokeAnswer, cleared) => {
    apiFetch.mockImplementation((url: string) =>
      url === '/api/auth/set-password' ? ok({ success: true, route: '/dashboard', code: 'OTHER_SESSIONS_NOT_SIGNED_OUT' }) : ok({}, revokeAnswer as number),
    );
    render(<SetPasswordPage />);
    await submitPassword();
    await waitFor(() => screen.getByRole('button', { name: SIGN_OUT_OTHERS_LABEL }));
    const before = clearBrowserAuthState.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: SIGN_OUT_OTHERS_LABEL })); });
    await waitFor(() => expect(screen.queryByRole('button', { name: SIGN_OUT_OTHERS_LABEL })).toBeNull());
    expect(clearBrowserAuthState.mock.calls.length - before).toBe(cleared ? 1 : 0);
  });

  it('a revoke that never answers: still "Signing out…" before the timeout, "not sure" after it', async () => {
    apiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/auth/set-password') return ok({ success: true, route: '/dashboard', code: 'OTHER_SESSIONS_NOT_SIGNED_OUT' });
      // Like real fetch: rejects only when the caller's signal aborts.
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    render(<SetPasswordPage />);
    await submitPassword();
    await waitFor(() => screen.getByRole('button', { name: SIGN_OUT_OTHERS_LABEL }));
    jest.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: SIGN_OUT_OTHERS_LABEL })); });
    await act(async () => { jest.advanceTimersByTime(SIGN_OUT_OTHERS_TIMEOUT_MS - 1); });
    expect(screen.getByRole('button', { name: 'Signing out…' })).toBeTruthy(); // control: genuinely waiting
    await act(async () => { jest.advanceTimersByTime(1); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(SIGN_OUT_OTHERS_UNKNOWN));
    expect(clearBrowserAuthState).not.toHaveBeenCalled();
  });

  it('outcome union: SIGN_OUT_OTHERS_COPY covers SIGN_OUT_OTHERS_OUTCOMES in both directions', () => {
    expect(Object.keys(SIGN_OUT_OTHERS_COPY).sort()).toEqual([...SIGN_OUT_OTHERS_OUTCOMES].sort());
  });

  it('outcome union: every outcome classifySignOutOthers produces is a member, and every member is producible', () => {
    const produced = new Set([200, 403, 503, null].map(classifySignOutOthers));
    expect([...produced].sort()).toEqual([...SIGN_OUT_OTHERS_OUTCOMES].sort());
  });

  it('unknown member: an unexpected status is "unknown" (never done, never refused)', () => {
    expect([0, 100, 302, 304, 600, 999].map(classifySignOutOthers)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    // Controls: the definitive ranges really classify, so the line above is not vacuous.
    expect(classifySignOutOthers(204)).toBe('done');
    expect(classifySignOutOthers(401)).toBe('refused');
  });

  it("the client's code constant equals the server's export (pages/api/auth/set-password.ts)", () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../pages/api/auth/set-password.ts'), 'utf8');
    const m = src.match(/export const OTHER_SESSIONS_NOT_SIGNED_OUT = '([A-Z_]+)' as const;/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(OTHER_SESSIONS_NOT_SIGNED_OUT);
  });

  it('classifySignOutOthers: 2xx done, 4xx refused, 5xx/thrown unknown', () => {
    expect([200, 204, 400, 401, 403, 500, 503, 599, null].map(classifySignOutOthers)).toEqual([
      'done', 'done', 'refused', 'refused', 'refused', 'unknown', 'unknown', 'unknown', 'unknown',
    ]);
  });
});
