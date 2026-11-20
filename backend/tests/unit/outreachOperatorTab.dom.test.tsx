/**
 * @jest-environment jsdom
 *
 * Super-admin Outreach operator screen (a9, 2026-11-20). What it may and may not do:
 *   - EMAIL IS NEVER OFFERED unless the server said emailEnabled === true (LEAD_OUTREACH_EMAIL_ENABLED, default OFF):
 *     before any response the switch reads UNKNOWN and the email box is disabled; 'off' keeps it disabled and the
 *     request carries channels ['internal'] only.
 *   - Preview posts previewOnly:true; Activate posts previewOnly:false.
 *   - Approve requires a reason and posts { companyId, taskId, reason } - never an approver identity.
 *   - Every task state the route can return renders; an unexpected one renders as "Unknown state", not blank.
 *   - Step-up: the existing helper runs on every POST; a failed challenge shows guidance and nothing proceeds.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = jest.fn();
const runStepUpFlowIfNeeded = jest.fn();
jest.mock('../../../components/community-ai/fetchWithAuth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
jest.mock('@/lib/security/superAdminStepUp', () => ({
  runStepUpFlowIfNeeded: (...a: unknown[]) => runStepUpFlowIfNeeded(...a),
  describeStepUpOutcome: () => 'Step-up was cancelled. Try again to confirm with a passkey.',
}));
jest.mock('@/lib/security/superAdminAuthFailure', () => ({ describeAuthFailure: () => 'session expired' }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: OutreachOperatorTab, emailSwitchFrom } = require('../../../components/super-admin/tabs/OutreachOperatorTab');

const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const report = (tasks: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  planPresent: true, planGeneratedAt: '2026-11-20T00:00:00Z', permittedChannels: ['internal'], registeredChannels: ['internal', 'email'],
  materialization: null, tasks, dispatched: 0, ...extra,
});
/** The step-up helper passes the response through (already elevated) unless a test says otherwise. */
const passThrough = () => runStepUpFlowIfNeeded.mockImplementation(async (initial: unknown) => ({ kind: 'success', response: initial }));
const bodies = () => fetchWithAuth.mock.calls.map((c) => JSON.parse(String((c[1] as { body: string }).body)));

beforeEach(() => { fetchWithAuth.mockReset(); runStepUpFlowIfNeeded.mockReset(); passThrough(); });

function fill() {
  fireEvent.change(screen.getByLabelText('Company id'), { target: { value: 'co-1' } });
  fireEvent.change(screen.getByLabelText('Lead id'), { target: { value: 'lead-1' } });
}

it('emailSwitchFrom: only a literal true is ON; false is OFF; anything else is UNKNOWN', () => {
  expect(emailSwitchFrom({ emailEnabled: true })).toBe('on');
  expect(emailSwitchFrom({ emailEnabled: false })).toBe('off');
  expect(emailSwitchFrom({ emailEnabled: 'true' })).toBe('unknown');
  expect(emailSwitchFrom({})).toBe('unknown');
  expect(emailSwitchFrom(null)).toBe('unknown');
});

it('before any response the switch is UNKNOWN and email cannot be selected', () => {
  render(<OutreachOperatorTab />);
  expect(screen.getByTestId('email-switch').textContent).toContain('not known yet');
  expect((screen.getByLabelText('Include email') as HTMLInputElement).disabled).toBe(true);
});

it('DEFAULT OFF: with emailEnabled false the email box stays disabled and the request carries internal only', async () => {
  fetchWithAuth.mockResolvedValue(response({ ok: true, report: report(), emailEnabled: false }));
  render(<OutreachOperatorTab />);
  fill();
  fireEvent.click(screen.getByText('Preview'));
  await waitFor(() => expect(screen.getByTestId('email-switch').textContent).toContain('OFF'));
  expect((screen.getByLabelText('Include email') as HTMLInputElement).disabled).toBe(true);
  expect(bodies()[0]).toEqual({ companyId: 'co-1', leadId: 'lead-1', channels: ['internal'], previewOnly: true });
});

it('CONTROL: with emailEnabled true the box enables and a checked box sends internal + email', async () => {
  fetchWithAuth.mockResolvedValue(response({ ok: true, report: report(), emailEnabled: true }));
  render(<OutreachOperatorTab />);
  fill();
  fireEvent.click(screen.getByText('Preview'));
  await waitFor(() => expect(screen.getByTestId('email-switch').textContent).toContain('ON'));
  const box = screen.getByLabelText('Include email') as HTMLInputElement;
  expect(box.disabled).toBe(false);
  fireEvent.click(box);
  fireEvent.click(screen.getByText('Activate'));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
  expect(bodies()[1]).toEqual({ companyId: 'co-1', leadId: 'lead-1', channels: ['internal', 'email'], previewOnly: false });
});

it('email is OPT-IN per run: switch ON but the box left unchecked -> internal only', async () => {
  fetchWithAuth.mockResolvedValue(response({ ok: true, report: report(), emailEnabled: true }));
  render(<OutreachOperatorTab />);
  fill();
  fireEvent.click(screen.getByText('Preview'));
  await waitFor(() => expect(screen.getByTestId('email-switch').textContent).toContain('ON'));
  fireEvent.click(screen.getByText('Activate'));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
  expect(bodies()[1]).toEqual({ companyId: 'co-1', leadId: 'lead-1', channels: ['internal'], previewOnly: false });
});

it('tasks render with every route state; an unexpected state shows as Unknown, never blank', async () => {
  fetchWithAuth.mockResolvedValue(response({ ok: true, emailEnabled: false, report: report([
    { taskId: 't1', channel: 'internal', status: 'pending', action: 'not_approved' },
    { taskId: 't2', channel: 'email', status: 'sent', action: 'dispatched' },
    { taskId: 't3', channel: null, status: 'x', action: 'something_new' },
  ]) }));
  render(<OutreachOperatorTab />);
  fill();
  fireEvent.click(screen.getByText('Activate'));
  await waitFor(() => expect(screen.getByTestId('task-t1')).toBeTruthy());
  expect(screen.getByTestId('task-t1').textContent).toContain('Waiting for approval');
  expect(screen.getByTestId('task-t2').textContent).toContain('Sent / handed to its channel');
  expect(screen.getByTestId('task-t3').textContent).toContain('Unknown state (something_new)');
  expect(screen.getByTestId('task-t3').textContent).toContain('unknown'); // channel null
});

it('approve REQUIRES a reason, and posts only { companyId, taskId, reason } (no approver identity)', async () => {
  fetchWithAuth.mockResolvedValueOnce(response({ ok: true, emailEnabled: false, report: report([
    { taskId: 't1', channel: 'internal', status: 'pending', action: 'not_approved' },
  ]) }));
  render(<OutreachOperatorTab />);
  fill();
  fireEvent.click(screen.getByText('Activate'));
  await waitFor(() => expect(screen.getByText('Approve')).toBeTruthy());
  fireEvent.click(screen.getByText('Approve'));
  expect(screen.getByRole('alert').textContent).toContain('A reason is required');
  expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  fetchWithAuth.mockResolvedValueOnce(response({ ok: true }));
  fireEvent.change(screen.getByLabelText('Reason for t1'), { target: { value: 'reviewed the plan' } });
  fireEvent.click(screen.getByText('Approve'));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
  expect(fetchWithAuth.mock.calls[1][0]).toBe('/api/super-admin/outreach/approve');
  expect(bodies()[1]).toEqual({ companyId: 'co-1', taskId: 't1', reason: 'reviewed the plan' });
});

it('a failed step-up challenge shows guidance and nothing proceeds', async () => {
  runStepUpFlowIfNeeded.mockResolvedValue({ kind: 'step_up_user_cancelled' });
  fetchWithAuth.mockResolvedValue(response({ error: 'STEP_UP_REQUIRED' }, 401));
  render(<OutreachOperatorTab />);
  fill();
  fireEvent.click(screen.getByText('Preview'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('cancelled'));
  expect(screen.queryByTestId('outreach-report')).toBeNull();
});

it('a route error shows its code, not a report', async () => {
  fetchWithAuth.mockResolvedValue(response({ error: 'recipient may not be supplied', code: 'RECIPIENT_OVERRIDE_NOT_PERMITTED' }, 400));
  render(<OutreachOperatorTab />);
  fill();
  fireEvent.click(screen.getByText('Activate'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('RECIPIENT_OVERRIDE_NOT_PERMITTED'));
  expect(screen.queryByTestId('outreach-report')).toBeNull();
});
