/**
 * @jest-environment jsdom
 *
 * The Sales Navigator Extract page (web): the acknowledgement is accepted HERE, with the exact text shown and its
 * version + hash echoed; an unreadable state is "couldn't check", never "not accepted"; a closed gate explains
 * itself; Extract starts the run and the page then follows it, with Cancel; the route refusals read as plain words.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockApiFetch = jest.fn();
jest.mock('@/lib/apiFetch', () => ({ apiFetch: (u: string, init?: unknown) => mockApiFetch(u, init) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: SalesNavExtract, gateMessage, runMessage } = require('../../../components/prospects/salesnav/SalesNavExtract');

const COMPANY = '11111111-2222-4333-8444-555555555555';
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const ACK = { version: 'placeholder-v0', textSha256: 'a'.repeat(64), text: 'PLACEHOLDER - pending legal review. LinkedIn may restrict…', status: 'placeholder' };
const setup = (over: Record<string, unknown> = {}) => ({ transport: 'extension', ack: ACK, acked: true, gate: { allowed: true, reason: 'cleared' }, bound: true, ...over });
const RUN = { runId: 'run-1', transport: 'extension', urlKind: 'lead_list', status: 'running', code: null, pagesRead: 1, leadsRead: 25,
  listTotal: 60, added: 20, updated: 1, heldForReview: 2, skippedAlreadyHave: 2, dropped: 0, notReadOverCap: 0, retryAfterAt: null,
  startedAt: '2026-11-21T10:00:00Z', closedAt: null };

beforeEach(() => mockApiFetch.mockReset());

describe('SalesNavExtract', () => {
  it('shows the EXACT acknowledgement text and records acceptance with the SHOWN version + hash', async () => {
    mockApiFetch
      .mockResolvedValueOnce(json(200, setup({ acked: false, gate: { allowed: false, reason: 'ack_missing' } })))
      .mockResolvedValueOnce(json(200, {}))                                    // POST /ack
      .mockResolvedValueOnce(json(200, setup()));                              // setup again
    render(<SalesNavExtract companyId={COMPANY} />);
    expect(await screen.findByTestId('ack-text')).toHaveTextContent('PLACEHOLDER - pending legal review');
    const accept = screen.getByRole('button', { name: 'Accept' });
    expect(accept).toBeDisabled();                                             // not without the checkbox
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(accept);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(3));
    const [url, init] = mockApiFetch.mock.calls[1];
    expect(url).toBe(`/api/salesnav/ack?companyId=${COMPANY}`);
    expect(JSON.parse(init.body)).toEqual({ transport: 'extension', shownVersion: ACK.version, shownTextSha256: ACK.textSha256 });
    expect(await screen.findByRole('button', { name: 'Extract' })).toBeInTheDocument();
  });

  it('an UNREADABLE ack state says "couldn\'t check" and offers NO accept button - never "not accepted"', async () => {
    mockApiFetch.mockResolvedValueOnce(json(200, setup({ acked: null })));
    render(<SalesNavExtract companyId={COMPANY} />);
    expect(await screen.findByText(/couldn't check whether you've already accepted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('a closed gate (acked) explains itself and offers no Extract', async () => {
    mockApiFetch.mockResolvedValueOnce(json(200, setup({ gate: { allowed: false, reason: 'tenant_flag_off:salesnav_extraction' } })));
    render(<SalesNavExtract companyId={COMPANY} />);
    expect(await screen.findByTestId('gate-closed')).toHaveTextContent('not switched on for your company');
    expect(screen.queryByRole('button', { name: 'Extract' })).toBeNull();
  });

  it('Extract starts the run with the pasted URL, then shows its live status with Cancel', async () => {
    mockApiFetch
      .mockResolvedValueOnce(json(200, setup()))
      .mockResolvedValueOnce(json(201, { runId: 'run-1', kind: 'lead_list', canonicalUrl: 'x' }))
      .mockResolvedValue(json(200, RUN));
    render(<SalesNavExtract companyId={COMPANY} />);
    fireEvent.change(await screen.findByLabelText('Sales Navigator list or search link'), { target: { value: ' https://www.linkedin.com/sales/lists/people/123 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Extract' }));
    expect(await screen.findByTestId('run-message')).toHaveTextContent('Reading your list');
    const [url, init] = mockApiFetch.mock.calls[1];
    expect(url).toBe(`/api/salesnav/runs?companyId=${COMPANY}`);
    expect(JSON.parse(init.body)).toEqual({ transport: 'extension', url: 'https://www.linkedin.com/sales/lists/people/123' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it.each([
    ['URL_REFUSED', 422, 'not a Sales Navigator'],
    ['MEMBER_UNRESOLVED', 409, 'Connect your LinkedIn account first'],
    ['RUN_ALREADY_OPEN', 409, 'already open'],
  ])('a %s refusal reads as plain words', async (code, status, text) => {
    mockApiFetch.mockResolvedValueOnce(json(200, setup())).mockResolvedValueOnce(json(status, { error: code }));
    render(<SalesNavExtract companyId={COMPANY} />);
    fireEvent.change(await screen.findByLabelText('Sales Navigator list or search link'), { target: { value: 'https://x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Extract' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });
});

describe('the messages the page shows', () => {
  it('a paused-for-cap run says it continues after midnight UTC; auth_expired asks to sign in', () => {
    expect(runMessage({ status: 'paused_daily_cap', code: 'daily_cap' })).toMatch(/after midnight \(UTC\)/);
    expect(runMessage({ status: 'auth_expired', code: 'checkpoint' })).toMatch(/Sign in to LinkedIn/);
  });
  it('an outdated reader asks to UPDATE the extension (a9: not "it stalled"); a stale run says it stalled', () => {
    expect(runMessage({ status: 'refused', code: 'reader_version_unsupported' })).toMatch(/update the Omnivyra extension/);
    expect(runMessage({ status: 'unknown', code: 'run_stale' })).toMatch(/Stalled/);
  });
  it('the legal switch and an unreadable flag are told apart', () => {
    expect(gateMessage('legal_not_cleared')).toMatch(/legal review/);
    expect(gateMessage('flag_unreadable:salesnav_extraction')).toMatch(/couldn't check/);
  });
});
