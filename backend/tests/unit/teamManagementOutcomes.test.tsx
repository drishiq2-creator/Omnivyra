/**
 * @jest-environment jsdom
 *
 * /team-management (audit F23-F25, 2026-11-20).
 * F23: a failed roster read rendered "Team Members (0)" + "No users yet" after a 4 s toast.
 * F24: a fresh Idempotency-Key per click, so withIdempotency (pages/api/company/users.ts) never replayed anything,
 *      while the comment said each mutation was "safely retryable without duplicating it".
 * F25: a lost response on invite/reinvite said "Failed to invite user", inviting a re-send.
 *
 * SECRETS: none. No network (fetchWithAuth is mocked).
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as fs from 'fs';
import * as path from 'path';

const fetchWithAuth = jest.fn();
jest.mock('../../../components/community-ai/fetchWithAuth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
jest.mock('../../../components/CompanyContext', () => ({
  useCompanyContext: () => ({
    selectedCompanyId: 'co-1', selectedCompanyName: 'Acme', userRole: 'COMPANY_ADMIN',
    isAuthenticated: true, refreshCompanies: jest.fn(),
  }),
}));
jest.mock('next/router', () => ({ useRouter: () => ({ push: jest.fn(), query: {}, pathname: '/team-management' }) }));
jest.mock('../../../lib/setup/setupEvents', () => ({ emitSetupChanged: jest.fn() }));

import TeamManagement from '../../../pages/team-management';
import {
  HeldIdempotencyKeys,
  TEAM_IN_PROGRESS_COPY,
  TEAM_LOAD_FAILED,
  TEAM_UNKNOWN_COPY,
  classifyTeamMutation,
  submissionSignature,
  teamLoadFailureMessage,
} from '../../../lib/team/teamMutationOutcome';

type Answer = { status: number; body?: unknown } | 'throw';
const asResponse = (a: Answer) =>
  a === 'throw'
    ? Promise.reject(new TypeError('Failed to fetch'))
    : Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body ?? {} });

const MEMBER = { user_id: 'u1', name: 'Ana', email: 'ana@acme.test', role: 'CONTENT_CREATOR', status: 'invited', created_at: '2026-11-01T00:00:00Z' };

/** GET roster answers come from `reads`, mutations from `writes` (each a queue; the last answer repeats). */
function route(reads: Answer[], writes: Answer[] = []) {
  fetchWithAuth.mockImplementation((_url: string, init?: RequestInit) => {
    const q = init?.method && init.method !== 'GET' ? writes : reads;
    return asResponse(q.length > 1 ? q.shift()! : q[0]);
  });
}
const writeCalls = () => fetchWithAuth.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');
const readCalls = () => fetchWithAuth.mock.calls.filter(([, init]) => !init?.method || init.method === 'GET');
const keyOf = (call: unknown[]) => ((call[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key'];

beforeEach(() => fetchWithAuth.mockReset());

describe('classifyTeamMutation', () => {
  it.each<[string, number | null, unknown, string]>([
    ['2xx', 200, { message: 'ok' }, 'done'],
    ['thrown / unreadable', null, null, 'unknown'],
    ["apiFetch's lost connection today (503)", 503, { error: 'Network unreachable' }, 'unknown'],
    ['lost connection after #17 (599)', 599, { code: 'NETWORK_UNREACHABLE' }, 'unknown'],
    ['500', 500, {}, 'unknown'],
    ['409 in progress', 409, { code: 'IDEMPOTENCY_IN_PROGRESS' }, 'unknown'],
    ['409 key conflict (nothing ran)', 409, { code: 'IDEMPOTENCY_CONFLICT', error: 'Idempotency key reused' }, 'refused'],
    ['400 validation', 400, { error: 'Invalid email' }, 'refused'],
    ['403', 403, { error: 'FORBIDDEN_ROLE' }, 'refused'],
  ])('%s', (_n, status, body, kind) => {
    expect(classifyTeamMutation('invite', status, body).kind).toBe(kind);
  });

  it('a refusal shows the server sentence, else a fallback', () => {
    expect(classifyTeamMutation('invite', 400, { error: 'Invalid email' })).toEqual({ kind: 'refused', message: 'Invalid email' });
    expect(classifyTeamMutation('remove', 400, {})).toEqual({ kind: 'refused', message: 'Failed to remove user' });
  });

  it('unknown-outcome copy claims nothing and promises no safe retry', () => {
    for (const copy of [...Object.values(TEAM_UNKNOWN_COPY), TEAM_IN_PROGRESS_COPY]) {
      expect(copy).not.toMatch(/fail|safe|won't|will not|nothing was|try again/i);
      expect(copy).toMatch(/not sure|still being processed/i);
    }
  });
});

describe('HeldIdempotencyKeys (F24)', () => {
  let n = 0;
  const keys = () => new HeldIdempotencyKeys(() => `k${++n}`);
  const sig = submissionSignature('POST', { email: 'a@b.c' });

  it('same submission, same key until settled; another body gets its own key', () => {
    const h = keys();
    const first = h.keyFor(sig);
    expect(h.keyFor(sig)).toBe(first);
    expect(h.keyFor(submissionSignature('POST', { email: 'x@y.z' }))).not.toBe(first);
    h.settle(sig);
    expect(h.keyFor(sig)).not.toBe(first);
  });

  it('record keeps the key only while the outcome is unknown', () => {
    const h = keys();
    const k = h.keyFor(sig);
    h.record(sig, { kind: 'unknown', reason: 'no_answer' });
    expect(h.keyFor(sig)).toBe(k);
    h.record(sig, { kind: 'refused', message: 'x' });
    expect(h.keyFor(sig)).not.toBe(k);
  });

  it('the page comment no longer claims a fresh key per action is safely retryable', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../pages/team-management.tsx'), 'utf8');
    expect(src).not.toMatch(/fresh key per user action makes each mutation safely/);
    expect(src).not.toMatch(/'Idempotency-Key': newIdempotencyKey\(\)/);
  });
});

describe('teamLoadFailureMessage (F23)', () => {
  it('known refusals keep their sentence; everything else is the honest generic failure, never a raw code', () => {
    expect(teamLoadFailureMessage(403, { error: 'FORBIDDEN_ROLE' })).toMatch(/permission to view this company's team/);
    expect(teamLoadFailureMessage(503, { error: 'FORBIDDEN_ROLE' })).toBe(TEAM_LOAD_FAILED);
    expect(teamLoadFailureMessage(500, { error: 'FAILED_TO_LIST_USERS' })).toBe(TEAM_LOAD_FAILED);
    expect(teamLoadFailureMessage(400, { error: 'SOME_CODE' })).toBe(TEAM_LOAD_FAILED);
    expect(teamLoadFailureMessage(null, null)).toBe(TEAM_LOAD_FAILED);
  });
});

describe('/team-management roster read (F23)', () => {
  it.each<[string, Answer]>([
    ['a 503', { status: 503, body: { error: 'Network unreachable' } }],
    ['a thrown fetch', 'throw'],
  ])('%s shows the failure with Retry, never "No users yet" or a 0 count', async (_n, answer) => {
    route([answer]);
    render(<TeamManagement />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(TEAM_LOAD_FAILED));
    expect(screen.queryByText(/No users yet/)).toBeNull();
    expect(screen.getByText('Team Members (—)')).toBeTruthy();
  });

  it('Retry re-reads and shows the roster', async () => {
    route([{ status: 503 }, { status: 200, body: { users: [MEMBER] } }]);
    render(<TeamManagement />);
    await waitFor(() => screen.getByRole('alert'));
    const before = readCalls().length;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    await waitFor(() => expect(screen.getByText('Team Members (1)')).toBeTruthy());
    expect(readCalls().length).toBe(before + 1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('control: an empty success says "No users yet" with a 0 count', async () => {
    route([{ status: 200, body: { users: [] } }]);
    render(<TeamManagement />);
    await waitFor(() => expect(screen.getByText(/No users yet/)).toBeTruthy());
    expect(screen.getByText('Team Members (0)')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

async function openAndSendInvite(email = 'new@acme.test') {
  fireEvent.click(screen.getByRole('button', { name: /Invite Member/ }));
  fireEvent.change(screen.getByPlaceholderText('colleague@omnivyra.com'), { target: { value: email } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send Invitation' })); });
}
const emailInput = () => screen.getByPlaceholderText('colleague@omnivyra.com') as HTMLInputElement;
const checkAndSend = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check and send' })); });
};

describe('/team-management invite lock after an unknown outcome (F24/F25, b3 design)', () => {
  it('unknown: "not sure" in the modal, roster re-read, form READ-ONLY, and edits are impossible', async () => {
    route([{ status: 200, body: { users: [] } }], [{ status: 503, body: { error: 'Network unreachable' } }]);
    render(<TeamManagement />);
    await waitFor(() => screen.getByText(/No users yet/));
    const readsBefore = readCalls().length;
    await openAndSendInvite();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(TEAM_UNKNOWN_COPY.invite));
    expect(screen.queryByText(/Failed to invite user/)).toBeNull();
    await waitFor(() => expect(readCalls().length).toBe(readsBefore + 1));
    expect(emailInput().readOnly).toBe(true);
    fireEvent.change(emailInput(), { target: { value: 'someone-else@acme.test' } });
    expect(emailInput().value).toBe('new@acme.test');
    expect(screen.queryByRole('button', { name: 'Send Invitation' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check and send' })).toBeTruthy();
  });

  it('unknown -> Check and send answers 2xx: SAME key and body, "Invitation sent", modal closed, form reset', async () => {
    route([{ status: 200, body: { users: [] } }], [{ status: 503 }, { status: 201, body: { success: true } }]);
    render(<TeamManagement />);
    await waitFor(() => screen.getByText(/No users yet/));
    await openAndSendInvite();
    await waitFor(() => screen.getByRole('button', { name: 'Check and send' }));
    await checkAndSend();
    await waitFor(() => expect(screen.getByText('Invitation sent')).toBeTruthy());
    expect(screen.queryByPlaceholderText('colleague@omnivyra.com')).toBeNull();
    const [first, second] = writeCalls();
    expect(keyOf(second)).toBe(keyOf(first));
    expect(JSON.parse(String((second[1] as RequestInit).body))).toEqual(JSON.parse(String((first[1] as RequestInit).body)));
    fireEvent.click(screen.getByRole('button', { name: /Invite Member/ }));
    expect(emailInput().value).toBe('');
    expect(emailInput().readOnly).toBe(false);
  });

  it('unknown -> Check and send answers 4xx: refusal shown, form editable again', async () => {
    route([{ status: 200, body: { users: [] } }], [{ status: 503 }, { status: 400, body: { error: 'Invalid email' } }]);
    render(<TeamManagement />);
    await waitFor(() => screen.getByText(/No users yet/));
    await openAndSendInvite();
    await waitFor(() => screen.getByRole('button', { name: 'Check and send' }));
    await checkAndSend();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Invalid email'));
    expect(emailInput().readOnly).toBe(false);
    fireEvent.change(emailInput(), { target: { value: 'fixed@acme.test' } });
    expect(emailInput().value).toBe('fixed@acme.test');
  });

  it.each<[string, Answer]>([
    ['lost again', 'throw'],
    ['5xx again', { status: 500 }],
    ['still in progress', { status: 409, body: { code: 'IDEMPOTENCY_IN_PROGRESS' } }],
  ])('unknown -> Check and send %s: STILL locked, same key', async (_n, again) => {
    route([{ status: 200, body: { users: [] } }], [{ status: 503 }, again]);
    render(<TeamManagement />);
    await waitFor(() => screen.getByText(/No users yet/));
    await openAndSendInvite();
    await waitFor(() => screen.getByRole('button', { name: 'Check and send' }));
    await checkAndSend();
    await waitFor(() => expect(writeCalls().length).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check and send' })).toBeTruthy());
    expect(emailInput().readOnly).toBe(true);
    const [first, second] = writeCalls();
    expect(keyOf(second)).toBe(keyOf(first));
  });

  it('Cancel keeps the lock: reopening is still read-only with the notice', async () => {
    route([{ status: 200, body: { users: [] } }], [{ status: 503 }]);
    render(<TeamManagement />);
    await waitFor(() => screen.getByText(/No users yet/));
    await openAndSendInvite();
    await waitFor(() => screen.getByRole('button', { name: 'Check and send' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /Invite Member/ }));
    expect(emailInput().readOnly).toBe(true);
    expect(screen.getByRole('status').textContent).toContain(TEAM_UNKNOWN_COPY.invite);
  });

  it('409 IDEMPOTENCY_IN_PROGRESS on the first send says still being processed, and locks', async () => {
    route([{ status: 200, body: { users: [] } }], [{ status: 409, body: { code: 'IDEMPOTENCY_IN_PROGRESS' } }]);
    render(<TeamManagement />);
    await waitFor(() => screen.getByText(/No users yet/));
    await openAndSendInvite();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(TEAM_IN_PROGRESS_COPY));
    expect(emailInput().readOnly).toBe(true);
  });

  it('after a confirmed send, the next invite gets a NEW key', async () => {
    route([{ status: 200, body: { users: [] } }], [{ status: 200, body: { message: 'Invitation sent' } }]);
    render(<TeamManagement />);
    await waitFor(() => screen.getByText(/No users yet/));
    await openAndSendInvite('a@acme.test');
    await waitFor(() => expect(screen.getByText('Invitation sent')).toBeTruthy());
    await openAndSendInvite('a@acme.test');
    const [first, second] = writeCalls();
    expect(keyOf(second)).not.toBe(keyOf(first));
  });

  it('control: a 400 refusal on the first send shows the sentence, never locks, and drops the key', async () => {
    route([{ status: 200, body: { users: [] } }], [{ status: 400, body: { error: 'Invalid email' } }]);
    render(<TeamManagement />);
    await waitFor(() => screen.getByText(/No users yet/));
    await openAndSendInvite();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Invalid email'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(emailInput().readOnly).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send Invitation' })); });
    const [first, second] = writeCalls();
    expect(keyOf(second)).not.toBe(keyOf(first));
  });

  it('reinvite: a lost response is "not sure", with the reinvite copy', async () => {
    route([{ status: 200, body: { users: [MEMBER] } }], [{ status: 503 }]);
    render(<TeamManagement />);
    await waitFor(() => screen.getByText('Team Members (1)'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reinvite' })); });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(TEAM_UNKNOWN_COPY.reinvite));
    expect(screen.queryByText(/Failed to reinvite/)).toBeNull();
  });
});

describe("7c F1/F2: signature mirrors the server's stableStringify; middleware sentences are not user copy", () => {
  it('field order does not change the signature (server hashes key-sorted); undefined fields drop like the wire', () => {
    expect(submissionSignature('POST', { email: 'a@b.c', role: 'X' })).toBe(submissionSignature('POST', { role: 'X', email: 'a@b.c' }));
    expect(submissionSignature('POST', { email: 'a@b.c', name: undefined })).toBe(submissionSignature('POST', { email: 'a@b.c' }));
    expect(submissionSignature('POST', { email: 'a@b.c' })).not.toBe(submissionSignature('PUT', { email: 'a@b.c' }));
  });

  it.each([
    ['IDEMPOTENCY_CONFLICT', 'Idempotency key reused with different payload'],
    ['IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header required'],
    ['IDEMPOTENCY_PRINCIPAL_REQUIRED', 'Unauthorized'],
  ])('%s never shows its developer sentence', (code, devText) => {
    const status = code === 'IDEMPOTENCY_PRINCIPAL_REQUIRED' ? 401 : code === 'IDEMPOTENCY_CONFLICT' ? 409 : 400;
    const out = classifyTeamMutation('invite', status, { code, error: devText });
    expect(out.kind).toBe('refused');
    expect(out.kind === 'refused' && out.message).not.toBe(devText);
  });

  it('middleware 5xx sentences stay the unknown notice (5xx branch is above the message extraction)', () => {
    expect(classifyTeamMutation('invite', 500, { error: 'Failed to initialize idempotency state' }).kind).toBe('unknown');
  });
});
