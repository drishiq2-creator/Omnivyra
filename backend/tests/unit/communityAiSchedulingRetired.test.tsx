/**
 * @jest-environment jsdom
 *
 * Community AI scheduling retired (owner ruling 2026-11-20; b3 copy). The scheduler never ran in production.
 * - No "Scheduled" tab and no per-action Schedule control.
 * - Rows the API still returns as scheduled_actions appear under Pending with
 *   "Scheduled for <time> — scheduled sending isn't available, so this reply was not sent." and the normal
 *   execute path (labelled Send now) + Skip; ?status=scheduled lands there, narrowed to those rows.
 * Controls: an ordinary pending row has no notice and keeps "Execute".
 *
 * SECRETS: none. No network (fetchWithAuth is mocked).
 */
import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import * as fs from 'fs';
import * as path from 'path';

let query: Record<string, string> = {};
jest.mock('next/router', () => ({ useRouter: () => ({ query, push: jest.fn(), replace: jest.fn(), pathname: '/community-ai/actions' }) }));
jest.mock('../../../components/CompanyContext', () => ({ useCompanyContext: () => ({ selectedCompanyId: 'co-a' }) }));
const fetchWithAuth = jest.fn();
jest.mock('../../../components/community-ai/fetchWithAuth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
jest.mock('../../../components/community-ai/CommunityAiLayout', () => ({ children }: { children: React.ReactNode }) => <div>{children}</div>);

import { useCommunityActions } from '../../../hooks/useCommunityActions';
import CommunityActionsView from '../../../components/CommunityActionsView';
import { SEND_NOW_LABEL } from '../../../lib/communityAi/scheduledRetiredCopy';

const base = {
  platform: 'linkedin', action_type: 'reply', risk_level: 'low', requires_human_approval: false, execution_mode: 'api', suggested_text: 'Thanks!',
  execution_modes_config: { manual_only: false, api_allowed: true, rpa_allowed: false },
};
// The REAL API shape (a9): scheduled rows come in scheduled_actions with status 'approved' and scheduled_at set.
const SCHEDULED = { ...base, action_id: 'a-sched', target_id: 't1', status: 'approved', scheduled_at: '2026-11-01T10:00:00Z', approved_at: '2026-10-31T09:00:00Z' };
const PENDING = { ...base, action_id: 'a-pend', target_id: 't2', status: 'pending' };

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}
beforeEach(() => {
  query = {};
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(() =>
    okJson({
      pending_actions: [PENDING],
      scheduled_actions: [SCHEDULED],
      completed_actions: [],
      skipped_actions: [],
      permissions: { canApprove: true, canExecute: true, canSchedule: true, canSkip: true, canManageConnectors: false },
    }),
  );
});

function Harness() {
  const d = useCommunityActions();
  return <CommunityActionsView d={d} />;
}

describe('Community AI: scheduling retired', () => {
  it('no Scheduled tab; Pending / Completed / Skipped remain', async () => {
    render(<Harness />);
    await waitFor(() => screen.getByRole('button', { name: 'Pending' }));
    expect(screen.queryByRole('button', { name: 'Scheduled' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Completed' })).toBeTruthy();
  });

  it('an already-scheduled row shows under Pending with the not-sent notice, Send now and Skip; no Schedule control', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByText(/scheduled sending isn't available, so this reply was not sent/)).toBeTruthy());
    expect(screen.getByRole('button', { name: SEND_NOW_LABEL })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Skip' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('button', { name: 'Schedule' })).toBeNull();
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
  });

  it('control: the ordinary pending row keeps "Execute" and has no notice', async () => {
    query = {};
    render(<Harness />);
    await waitFor(() => screen.getByText(/this reply was not sent/));
    expect(screen.getAllByText(/this reply was not sent/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Execute' })).toBeTruthy();
  });

  it('?status=scheduled lands on Pending, narrowed to the scheduled rows', async () => {
    query = { status: 'scheduled' };
    const { result } = renderHook(() => useCommunityActions());
    await waitFor(() => expect(result.current.filteredActions.length).toBe(1));
    expect(result.current.activeTab).toBe('Pending');
    expect(result.current.filteredActions[0].action_id).toBe('a-sched');
  });

  it('Send now uses the existing execute route (no scheduling call is ever made)', async () => {
    render(<Harness />);
    await waitFor(() => screen.getByRole('button', { name: SEND_NOW_LABEL }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: SEND_NOW_LABEL })); });
    const urls = fetchWithAuth.mock.calls.map(([u]) => String(u));
    expect(urls).toContain('/api/community-ai/actions/execute');
    const scheduleCalls = fetchWithAuth.mock.calls.filter(([, init]) => String((init as RequestInit | undefined)?.body ?? '').includes('"status":"scheduled"'));
    expect(scheduleCalls).toHaveLength(0);
  });

  it('auto-rules no longer offers a Schedule action type (source pin, labelled)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../pages/community-ai/auto-rules.tsx'), 'utf8');
    expect(src).not.toMatch(/<option value="schedule">/);
    expect(src).toMatch(/schedule \(retired — this rule never runs\)/);
  });
});

describe('a retired-schedule row that REQUIRES approval was approved when scheduled', () => {
  it('it gets the manual execute path (isApproved includes scheduled), not "no permission"', async () => {
    const MANUAL = {
      ...SCHEDULED,
      action_id: 'a-manual',
      requires_human_approval: true,
      execution_mode: 'manual',
      execution_modes_config: { manual_only: true, api_allowed: false, rpa_allowed: false },
    };
    fetchWithAuth.mockImplementation(() =>
      okJson({
        pending_actions: [],
        scheduled_actions: [MANUAL],
        completed_actions: [],
        skipped_actions: [],
        permissions: { canApprove: true, canExecute: true, canSkip: true, canManageConnectors: false },
      }),
    );
    render(<Harness />);
    await waitFor(() => screen.getByText(/this reply was not sent/));
    expect(screen.getByRole('button', { name: 'Execute Manually' })).toBeTruthy();
  });
});

describe('approved-but-unsent replies are visible (a9 confirmed, 2026-11-20)', () => {
  // approve.ts sets status 'approved' and does NOT send; such rows arrive in pending_actions.
  const APPROVED = { ...base, action_id: 'a-appr', target_id: 't3', status: 'approved', approved_at: '2026-11-19T09:00:00Z' };

  beforeEach(() => {
    fetchWithAuth.mockImplementation(() =>
      okJson({
        pending_actions: [PENDING, APPROVED],
        scheduled_actions: [SCHEDULED],
        completed_actions: [],
        skipped_actions: [],
        permissions: { canApprove: true, canExecute: true, canSkip: true, canManageConnectors: false },
      }),
    );
  });

  it('an approved row shows under Pending, labelled "Approved — not sent yet", with Send now', async () => {
    const { result } = renderHook(() => useCommunityActions());
    await waitFor(() => expect(result.current.filteredActions.map((a: any) => a.action_id).sort()).toEqual(['a-appr', 'a-pend', 'a-sched']));
    render(<Harness />);
    await waitFor(() => expect(screen.getAllByText('Approved — not sent yet')).toHaveLength(1));
    expect(screen.getAllByRole('button', { name: SEND_NOW_LABEL })).toHaveLength(2);
  });

  it('the retired-schedule row (also status approved) is listed ONCE and gets the not-sent notice, not the approved label', async () => {
    render(<Harness />);
    await waitFor(() => screen.getByText(/this reply was not sent/));
    expect(screen.getAllByText(/this reply was not sent/)).toHaveLength(1);
    expect(screen.getAllByText('Approved — not sent yet')).toHaveLength(1);
  });
});

describe('waiting replies show their AGE prominently; no bulk send (7c)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { approvedAgeCopy } = require('../../../lib/communityAi/scheduledRetiredCopy');
  const NOW = Date.parse('2026-11-20T12:00:00Z'); // fixed clock: the date and "now" move together

  it('approvedAgeCopy: days since approval (falls back to created), with a fixed now', () => {
    expect(approvedAgeCopy('2026-11-08T12:00:00Z', null, NOW)).toBe("Approved 12 days ago — check it's still worth sending.");
    expect(approvedAgeCopy('2026-11-19T12:00:00Z', null, NOW)).toBe("Approved 1 day ago — check it's still worth sending.");
    expect(approvedAgeCopy('2026-11-20T08:00:00Z', null, NOW)).toBe("Approved today — check it's still worth sending.");
    expect(approvedAgeCopy(null, '2026-10-21T12:00:00Z', NOW)).toBe("Created 30 days ago — check it's still worth sending.");
    expect(approvedAgeCopy(null, null, NOW)).toBeNull();
  });

  it('both waiting populations render an age line; an ordinary pending row does not', async () => {
    const APPROVED = { ...base, action_id: 'a-appr', target_id: 't3', status: 'approved', approved_at: '2026-11-01T09:00:00Z' };
    fetchWithAuth.mockImplementation(() =>
      okJson({
        pending_actions: [PENDING, APPROVED],
        scheduled_actions: [SCHEDULED],
        completed_actions: [],
        skipped_actions: [],
        permissions: { canApprove: true, canExecute: true, canSkip: true, canManageConnectors: false },
      }),
    );
    render(<Harness />);
    await waitFor(() => expect(screen.getAllByText(/^Approved \d+ days? ago|^Approved today/)).toHaveLength(2));
  });

  it('no bulk-send affordance exists (per-row and deliberate)', async () => {
    render(<Harness />);
    await waitFor(() => screen.getByText(/this reply was not sent/));
    expect(screen.queryByRole('button', { name: /send all|execute all|bulk/i })).toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });
});

describe('execute outcomes: a concurrent press, a lost response, a refusal (never a raw code)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EXECUTE_ALREADY_HANDLED, EXECUTE_UNKNOWN, classifyExecute } = require('../../../lib/communityAi/executeOutcome');

  function routeExecute(answer: { status: number; body?: unknown } | 'throw') {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/api/community-ai/actions/execute') {
        if (answer === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({ ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body ?? {} });
      }
      return okJson({ pending_actions: [], scheduled_actions: [SCHEDULED], completed_actions: [], skipped_actions: [], permissions: { canApprove: true, canExecute: true, canSkip: true, canManageConnectors: false } });
    });
  }
  const loads = () => fetchWithAuth.mock.calls.filter(([u]) => String(u).startsWith('/api/community-ai/actions?')).length;

  it.each<[string, { status: number; body?: unknown } | 'throw', string, boolean]>([
    ['another tab/operator won the claim (409 ACTION_NOT_PENDING)', { status: 409, body: { error: 'ACTION_NOT_PENDING', current_status: 'executing' } }, 'already', true],
    ['a lost connection (apiFetch 503)', { status: 503 }, 'unknown', true],
    ['a thrown fetch', 'throw', 'unknown', true],
    ['a refusal (403 APPROVAL_REQUIRED)', { status: 403, body: { error: 'APPROVAL_REQUIRED', reason: 'NOT_APPROVED' } }, 'refused', false],
  ])('%s', async (_n, answer, kind, rereads) => {
    routeExecute(answer);
    render(<Harness />);
    await waitFor(() => screen.getByRole('button', { name: SEND_NOW_LABEL }));
    const before = loads();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: SEND_NOW_LABEL })); });
    const expected = kind === 'already' ? EXECUTE_ALREADY_HANDLED : kind === 'unknown' ? EXECUTE_UNKNOWN : "This reply wasn't sent: it needs approval first.";
    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
    expect(screen.queryByText('ACTION_NOT_PENDING')).toBeNull();
    expect(screen.queryByText('Execution failed')).toBeNull();
    if (rereads) await waitFor(() => expect(loads()).toBeGreaterThan(before));
  });

  it('classifyExecute table', () => {
    expect(classifyExecute(200, {}).kind).toBe('done');
    expect(classifyExecute(409, { error: 'ACTION_NOT_PENDING' }).kind).toBe('already');
    expect(classifyExecute(409, { error: 'OTHER' }).kind).toBe('refused');
    expect([null, 500, 503, 599].map((s) => classifyExecute(s, {}).kind)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(classifyExecute(400, { error: 'PLAYBOOK_VIOLATION', reason: 'Too long.' })).toEqual({ kind: 'refused', message: "This reply wasn't sent: Too long." });
    expect(classifyExecute(403, { error: 'TENANT_SCOPE_VIOLATION' }).kind === 'refused' && classifyExecute(403, { error: 'TENANT_SCOPE_VIOLATION' })).toEqual({ kind: 'refused', message: "This reply wasn't sent: it doesn't belong to the selected company." });
    expect(classifyExecute(403, { error: 'APPROVAL_REQUIRED', reason: 'NOT_APPROVED' })).toEqual({ kind: 'refused', message: "This reply wasn't sent: it needs approval first." });
    expect(classifyExecute(418, { error: 'SOME_FUTURE_CODE' })).toEqual({ kind: 'refused', message: "This reply wasn't sent." });
  });
});
