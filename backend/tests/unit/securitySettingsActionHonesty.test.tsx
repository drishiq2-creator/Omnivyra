/**
 * @jest-environment jsdom
 *
 * Settings → Security (04, 2026-11-20; b3 ruling (ii), security). Same outcome mapping as S1.
 * - A 5xx / lost / thrown revoke is "couldn't confirm", NEVER "failed"; a 4xx is "couldn't"; 2xx (and 409 for a
 *   revoke: "Already revoked") is done. Every attempt RE-READS the list.
 * - No raw status codes or response bodies on screen (the old copy was `Revoke failed: ${r.status}` and
 *   `Request failed: <status> <body>`).
 * - A failed load is an honest error with Retry; a failed FIRST load is not "You must be signed in".
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const SESSION = {
  userId: 'u1', email: 'a@b.test', legacyCookieSuperAdmin: false,
  mfa: { factors: ['totp'], enrolledAt: null }, device: { trusted: false }, stepUp: { active: false },
} as any;
let sessionMode: 'ok' | 'throw' = 'ok';
jest.mock('@/lib/security/sessionClient', () => ({
  fetchSessionSnapshot: jest.fn(async () => { if (sessionMode === 'throw') throw new Error('Request failed: 503 <html>upstream</html>'); return SESSION; }),
  fetchCapabilities: jest.fn(async () => ({ capabilities: [] })),
  logoutCurrentSession: jest.fn(async () => undefined),
}));
jest.mock('@/lib/security/stepUpClient', () => ({
  withStepUp: (fn: () => Promise<Response>) => fn(),
  triggerWebAuthnStepUp: jest.fn(),
  STEP_UP_ELEVATED_EVENT: 'stepup',
}));
jest.mock('@simplewebauthn/browser', () => ({ startRegistration: jest.fn() }));
jest.mock('next/head', () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
jest.mock('../../../lib/client/dataKit', () => ({ useVisibilityPolling: () => undefined }));

import SecuritySettingsPage from '../../../pages/settings/security';
import {
  SECURITY_ACTION_COPY, SECURITY_ACTION_KINDS, SECURITY_ACTION_OUTCOMES, classifySecurityAction,
} from '../../../lib/security/securityActionOutcome';

type Answer = { status: number; body?: unknown } | 'throw';
const json = (a: { status: number; body?: unknown }) => ({
  ok: a.status >= 200 && a.status < 300, status: a.status,
  headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => a.body ?? {}, text: async () => JSON.stringify(a.body ?? {}),
});
let revokeAnswer: Answer = { status: 200, body: { revoked: 1 } };
let listMode: 'ok' | 'fail' = 'ok';
let beginReg: { status: number; body?: unknown; html?: boolean } = { status: 200, body: {} };
const calls: string[] = [];
const SESSIONS = { sessions: [
  { id: 's-cur', isCurrent: true, createdAt: '2026-11-01T00:00:00Z', lastSeenAt: null, expiresAt: '2026-12-01T00:00:00Z', ip: null, userAgent: 'this' },
  { id: 's-other', isCurrent: false, createdAt: '2026-11-01T00:00:00Z', lastSeenAt: null, expiresAt: '2026-12-01T00:00:00Z', ip: null, userAgent: 'other' },
] };

beforeEach(() => {
  sessionMode = 'ok'; listMode = 'ok'; beginReg = { status: 200, body: {} }; revokeAnswer = { status: 200, body: { revoked: 1 } }; calls.length = 0;
  (global as any).fetch = jest.fn(async (url: string) => {
    calls.push(url);
    if (url === '/api/auth/sessions/list') return listMode === 'fail' ? json({ status: 503, body: { error: 'db down: relation auth_sessions' } }) : json({ status: 200, body: SESSIONS });
    if (url === '/api/auth/passkeys/begin-registration') {
      if (beginReg.html) return { ok: false, status: beginReg.status, headers: { get: () => 'text/html' }, json: async () => ({}), text: async () => '<html>502 Bad Gateway upstream</html>' };
      return json(beginReg);
    }
    if (url === '/api/auth/passkeys') return json({ status: 200, body: { credentials: [] } });
    if (url === '/api/auth/devices') return json({ status: 200, body: { devices: [] } });
    if (url === '/api/auth/sessions/revoke') {
      if (revokeAnswer === 'throw') throw new TypeError('Failed to fetch');
      return json(revokeAnswer);
    }
    return json({ status: 200, body: {} });
  });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { (console.warn as jest.Mock).mockRestore?.(); delete (global as any).fetch; });

const listCalls = () => calls.filter((u) => u === '/api/auth/sessions/list').length;
async function revokeOthers() {
  render(<SecuritySettingsPage />);
  const btn = await screen.findByRole('button', { name: /Sign out of all other sessions/ });
  const before = listCalls();
  await act(async () => { fireEvent.click(btn); });
  return before;
}

describe('revoke outcomes (sessions: "sign out other sessions")', () => {
  it.each<[string, Answer, string]>([
    ['503', { status: 503, body: { error: 'x' } }, SECURITY_ACTION_COPY.sessions_revoke_others.unknown],
    ['a lost connection (thrown)', 'throw', SECURITY_ACTION_COPY.sessions_revoke_others.unknown],
    ['403', { status: 403, body: { error: 'nope' } }, SECURITY_ACTION_COPY.sessions_revoke_others.refused],
  ])('%s → honest copy, never "Revoke failed: <status>", and the list is RE-READ', async (_n, answer, copy) => {
    revokeAnswer = answer;
    const before = await revokeOthers();
    await waitFor(() => expect(screen.getByText(copy)).toBeTruthy());
    expect(screen.queryByText(/Revoke failed|503|403/)).toBeNull();
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
  });

  it('control: 200 → no error, list re-read', async () => {
    const before = await revokeOthers();
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    expect(screen.queryByText(SECURITY_ACTION_COPY.sessions_revoke_others.unknown)).toBeNull();
    expect(screen.queryByText(SECURITY_ACTION_COPY.sessions_revoke_others.refused)).toBeNull();
  });
});

describe('loads', () => {
  it('a failed list load: honest copy + Retry that re-reads; no raw status or server body', async () => {
    listMode = 'fail';
    render(<SecuritySettingsPage />);
    await waitFor(() => expect(screen.getByText("We couldn't load your sessions. Please try again.")).toBeTruthy());
    expect(screen.queryByText(/503|db down|auth_sessions/)).toBeNull();
    listMode = 'ok';
    const before = listCalls();
    const retry = screen.getAllByRole('button', { name: 'Retry' })[0];
    await act(async () => { fireEvent.click(retry); });
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByText("We couldn't load your sessions. Please try again.")).toBeNull());
  });

  it('a failed FIRST auth-state load is an error with Retry, NOT "You must be signed in"', async () => {
    sessionMode = 'throw';
    render(<SecuritySettingsPage />);
    await waitFor(() => expect(screen.getByText(/We couldn't load your security settings/)).toBeTruthy());
    expect(screen.queryByText(/You must be signed in/)).toBeNull();
    expect(screen.queryByText(/503|upstream/)).toBeNull();
    sessionMode = 'ok';
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    await waitFor(() => expect(screen.getByText('Active sessions')).toBeTruthy());
  });
});

describe('request errors never show raw status or body (jsonOrThrow)', () => {
  it.each<[string, { status: number; body?: unknown; html?: boolean }, string]>([
    ['an HTML 502', { status: 502, html: true }, 'Something went wrong. Please try again.'],
    ['a JSON 500 with a code-like error', { status: 500, body: { error: 'INTERNAL_ERROR' } }, 'Something went wrong. Please try again.'],
    ['a JSON 400 with a human error (kept: the user needs it)', { status: 400, body: { error: 'Passkeys are limited to 5 per account.' } }, 'Passkeys are limited to 5 per account.'],
  ])('%s', async (_n, answer, copy) => {
    beginReg = answer;
    render(<SecuritySettingsPage />);
    const btn = await screen.findByRole('button', { name: 'Enroll new passkey' });
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(screen.getByText(copy)).toBeTruthy());
    expect(screen.queryByText(/Request failed|Expected JSON|502|500|400|Bad Gateway|INTERNAL_ERROR/)).toBeNull();
  });
});

describe('outcome tables (union-coverage pattern)', () => {
  it('classify: 2xx done; 409 done for revokes only; other 4xx refused; everything else unknown', () => {
    expect(classifySecurityAction('session_revoke', 200)).toBe('done');
    expect(classifySecurityAction('session_revoke', 409)).toBe('done');
    expect(classifySecurityAction('device_trust', 409)).toBe('refused');
    expect(classifySecurityAction('recovery_regenerate', 409)).toBe('refused');
    expect(classifySecurityAction('passkey_revoke', 403)).toBe('refused');
    for (const s of [null, 0, 100, 302, 500, 503, 599]) expect(classifySecurityAction('passkey_revoke', s as any)).toBe('unknown');
  });

  it('SECURITY_ACTION_COPY covers every kind, and each kind covers every non-done outcome (both directions)', () => {
    expect(Object.keys(SECURITY_ACTION_COPY).sort()).toEqual([...SECURITY_ACTION_KINDS].sort());
    const nonDone = SECURITY_ACTION_OUTCOMES.filter((o) => o !== 'done').sort();
    for (const k of SECURITY_ACTION_KINDS) expect(Object.keys(SECURITY_ACTION_COPY[k]).sort()).toEqual(nonDone);
  });

  it('every outcome is producible', () => {
    const produced = new Set([200, 403, 503].map((s) => classifySecurityAction('session_revoke', s)));
    expect([...produced].sort()).toEqual([...SECURITY_ACTION_OUTCOMES].sort());
  });

  it('no copy claims failure for an unknown outcome', () => {
    for (const k of SECURITY_ACTION_KINDS) expect(SECURITY_ACTION_COPY[k].unknown).toMatch(/couldn't confirm/i);
  });
});
