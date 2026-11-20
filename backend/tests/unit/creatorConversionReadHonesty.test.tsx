/**
 * @jest-environment jsdom
 *
 * U2 (audit F3, 2026-11-20): CreatorConversionSummary on /command-center/engagement. A failed read set
 * `failed`, which made `ready` false, so the card said "Set up creator attribution…" to people who already had it.
 * Now a failure says so, with a Retry that re-reads; "set up" is only shown when the read ANSWERED "not live".
 *
 * SECRETS: none. No network (global fetch is mocked).
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('@/components/CompanyContext', () => ({ useCompanyContext: () => ({ selectedCompanyId: 'co-a' }) }));

import CreatorConversionSummary, { CREATOR_CONVERSION_LOAD_FAILED } from '../../../components/engagement/CreatorConversionSummary';

type Answer = { status: number; body?: unknown } | 'throw';
let answers: Answer[] = [];
const fetchMock = jest.fn(() => {
  const a = answers.length > 1 ? answers.shift()! : answers[0];
  if (a === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
  return Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, statusText: 'x', json: async () => a.body ?? {} });
});
const cat = (n: number, id = 'S1') => ({ available: true, total_conversions: n, items: n ? [{ id, conversions: n }] : [] });
const LIVE = { attribution_available: true, strategies: cat(4, 'Thought leadership'), variants: cat(2), assets: cat(1, 'Asset A') };
const NOT_LIVE = { attribution_available: false, strategies: cat(0), variants: cat(0), assets: cat(0) };

let warn: jest.SpyInstance;
beforeEach(() => {
  fetchMock.mockClear();
  (global as any).fetch = fetchMock;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('CreatorConversionSummary read', () => {
  it.each<[string, Answer]>([
    ['a 503', { status: 503 }],
    ['a thrown fetch', 'throw'],
    ['a 200 with an error body', { status: 200, body: { error: 'boom' } }],
    ['a 200 with an unrecognised shape', { status: 200, body: { hello: 1 } }],
  ])('%s is a failure, never "Set up creator attribution"', async (_n, a) => {
    answers = [a];
    render(<CreatorConversionSummary />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(CREATOR_CONVERSION_LOAD_FAILED));
    expect(screen.queryByText(/Set up creator attribution/)).toBeNull();
  });

  it('Retry re-reads (it does not navigate) and then shows the data', async () => {
    answers = [{ status: 503 }, { status: 200, body: LIVE }];
    render(<CreatorConversionSummary />);
    await waitFor(() => screen.getByRole('alert'));
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry.closest('a')).toBeNull();
    await act(async () => { fireEvent.click(retry); });
    await waitFor(() => expect(screen.getByText('attributed leads · 30d')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('control: attribution genuinely not live still invites setup', async () => {
    answers = [{ status: 200, body: NOT_LIVE }];
    render(<CreatorConversionSummary />);
    await waitFor(() => expect(screen.getByText(/Set up creator attribution/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('control: live with zero leads says so', async () => {
    answers = [{ status: 200, body: { ...LIVE, strategies: cat(0), variants: cat(0), assets: cat(0) } }];
    render(<CreatorConversionSummary />);
    await waitFor(() => expect(screen.getByText(/No creator-attributed leads yet/)).toBeTruthy());
  });
});
