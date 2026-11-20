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
import fs from 'fs';
import path from 'path';
import { REVOKE_CODES, ALREADY_REVOKED, REVOKE_UNCONFIRMED } from '../../../shared/security/revokeCodes';
import {
  SECURITY_ACTION_COPY, SECURITY_ACTION_KINDS, SECURITY_ACTION_OUTCOMES, classifySecurityAction,
} from '../../../lib/security/securityActionOutcome';

type Answer = { status: number; body?: unknown } | 'throw';
const json = (a: { status: number; body?: unknown }): any => {
  const r: any = {
    ok: a.status >= 200 && a.status < 300, status: a.status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => a.body ?? {}, text: async () => JSON.stringify(a.body ?? {}),
  };
  r.clone = () => json(a);
  return r;
};
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

  it.each<[string, Answer, string | null]>([
    ['409 ALREADY_REVOKED (the end state)', { status: 409, body: { error: 'Already revoked', code: ALREADY_REVOKED } }, null],
    ['409 REVOKE_UNCONFIRMED (could not confirm)', { status: 409, body: { error: 'x', code: REVOKE_UNCONFIRMED } }, SECURITY_ACTION_COPY.sessions_revoke_others.unknown],
    ['409 with NO code (older server)', { status: 409, body: { error: 'Already revoked' } }, SECURITY_ACTION_COPY.sessions_revoke_others.unknown],
  ])('%s → keyed on the CODE, never the status alone; list re-read', async (_n, answer, copy) => {
    revokeAnswer = answer;
    const before = await revokeOthers();
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    if (copy) expect(screen.getByText(copy)).toBeTruthy();
    else {
      expect(screen.queryByText(SECURITY_ACTION_COPY.sessions_revoke_others.unknown)).toBeNull();
      expect(screen.queryByText(SECURITY_ACTION_COPY.sessions_revoke_others.refused)).toBeNull();
    }
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
    ['a JSON 400 with developer prose (not passed through)', { status: 400, body: { error: 'Provide one of: id, revokeOthers, revokeAll' } }, 'Something went wrong. Please try again.'],
  ])('%s', async (_n, answer, copy) => {
    beginReg = answer;
    render(<SecuritySettingsPage />);
    const btn = await screen.findByRole('button', { name: 'Enroll new passkey' });
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(screen.getByText(copy)).toBeTruthy());
    expect(screen.queryByText(/Request failed|Expected JSON|502|500|400|Bad Gateway|INTERNAL_ERROR|Provide one of/)).toBeNull();
  });
});

describe('outcome tables (union-coverage pattern)', () => {
  it('classify: 2xx done; a revoke 409 is done ONLY with ALREADY_REVOKED, otherwise unknown; other 4xx refused; else unknown', () => {
    expect(classifySecurityAction('session_revoke', 200)).toBe('done');
    expect(classifySecurityAction('passkey_revoke', 409, ALREADY_REVOKED)).toBe('done');
    expect(classifySecurityAction('passkey_revoke', 409, REVOKE_UNCONFIRMED)).toBe('unknown');
    expect(classifySecurityAction('passkey_revoke', 409, null)).toBe('unknown');
    expect(classifySecurityAction('passkey_revoke', 409, 'SOME_FUTURE_CODE')).toBe('unknown');
    expect(classifySecurityAction('device_trust', 409, ALREADY_REVOKED)).toBe('refused');
    expect(classifySecurityAction('device_trust', 409, 'ALREADY_TRUSTED')).toBe('done');
    expect(classifySecurityAction('device_trust', 409, null)).toBe('refused');
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

  it('REVOKE_CODES: every code is decided (ALREADY_REVOKED → done; every other code → unknown), both directions', () => {
    const decided: Record<string, string> = {};
    for (const c of REVOKE_CODES) decided[c] = classifySecurityAction('passkey_revoke', 409, c);
    expect(Object.keys(decided).sort()).toEqual([...REVOKE_CODES].sort());
    expect(decided).toEqual({ ALREADY_REVOKED: 'done', REVOKE_UNCONFIRMED: 'unknown' });
  });

  it('server contract: the trust route still sends ALREADY_TRUSTED on its 409 (the client keys done on it)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../pages/api/auth/devices/trust.ts'), 'utf8');
    const sites = src.split(/\r?\n/).filter((l) => l.includes('status(409)'));
    expect(sites).toHaveLength(1);
    expect(src).toMatch(/result\.reason === 'ALREADY_TRUSTED'\) \{\s*return res\.status\(409\)/);
  });

  it('server contract: every 409 in the three revoke routes carries a code from REVOKE_CODES', () => {
    const ROOT = path.resolve(__dirname, '../../..');
    let total = 0;
    for (const rel of ['pages/api/auth/passkeys/revoke.ts', 'pages/api/auth/sessions/revoke.ts', 'pages/api/auth/totp/revoke.ts']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const sites = src.split(/\r?\n/).filter((l) => l.includes('status(409)'));
      total += sites.length;
      for (const l of sites) expect({ rel, l, coded: /code: (ALREADY_REVOKED|REVOKE_UNCONFIRMED)\b/.test(l) }).toMatchObject({ coded: true });
    }
    expect(total).toBe(5); // control: the scan found the sites it claims to check
  });

  it('every outcome is producible', () => {
    const produced = new Set([200, 403, 503].map((s) => classifySecurityAction('session_revoke', s)));
    expect([...produced].sort()).toEqual([...SECURITY_ACTION_OUTCOMES].sort());
  });

  it('no copy claims failure for an unknown outcome', () => {
    for (const k of SECURITY_ACTION_KINDS) expect(SECURITY_ACTION_COPY[k].unknown).toMatch(/couldn't confirm/i);
  });
});
