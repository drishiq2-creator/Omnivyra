/**
 * @jest-environment jsdom
 *
 * /reports "Your Reports" (audit U1, 2026-11-20).
 * F1: no res.ok check; any failed read set [] and the whole block disappeared ("no reports").
 * F2: delete ignored the response; apiFetch never throws on a lost connection, so the catch (and its comment
 *     "list is reloaded") never ran and a failed delete was silent.
 *
 * SECRETS: none. No network (apiFetch is mocked).
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiFetch = jest.fn();
jest.mock('@/lib/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('@/components/CompanyContext', () => ({
  useCompanyContext: () => ({ selectedCompanyId: 'co-a', userRole: 'COMPANY_ADMIN', isLoading: false }),
}));
jest.mock('@/components/ReportJourneyGuide', () => () => null);
jest.mock('next/router', () => ({ useRouter: () => ({ push: jest.fn(), query: {}, pathname: '/reports' }) }));
jest.mock('next/head', () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import ReportsPage from '../../../pages/reports';
import { REPORTS_LOAD_FAILED, REPORT_DELETE_REFUSED, REPORT_DELETE_UNKNOWN } from '../../../lib/reports/reportsListCopy';

type Answer = { status: number; body?: unknown };
const res = (a: Answer) => Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body ?? {} });
let reads: Answer[] = [];
let deletes: Answer[] = [];
const REPORT = { id: 'r1', report_type: 'snapshot', status: 'completed', domain: 'a.test', created_at: '2026-11-01T00:00:00Z' };

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string, init?: RequestInit) => {
    const q = init?.method === 'DELETE' ? deletes : reads;
    return res(q.length > 1 ? q.shift()! : q[0]);
  });
});
const getCalls = () => apiFetch.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method !== 'DELETE').length;

let warn: jest.SpyInstance;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

describe('F1 list read', () => {
  it.each<[string, Answer]>([
    ['a 503 (incl. apiFetch lost connection)', { status: 503 }],
    ['a 200 without a reports array', { status: 200, body: { nope: true } }],
    ['a 500 whose body still carries an empty reports array (status decides, not shape)', { status: 500, body: { reports: [] } }],
  ])('%s shows the failure with Retry (the block no longer just disappears)', async (_n, a) => {
    reads = [a];
    render(<ReportsPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(REPORTS_LOAD_FAILED));
  });

  it('Retry re-reads and shows the list', async () => {
    reads = [{ status: 503 }, { status: 200, body: { reports: [REPORT] } }];
    render(<ReportsPage />);
    await waitFor(() => screen.getByRole('alert'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    await waitFor(() => expect(screen.getByText('1 report')).toBeTruthy());
    expect(getCalls()).toBe(2);
  });

  it('control: a genuinely empty list shows no failure and no list block', async () => {
    reads = [{ status: 200, body: { reports: [] } }];
    render(<ReportsPage />);
    await waitFor(() => expect(screen.queryByText('Loading your reports…')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Your Reports')).toBeNull();
  });
});

describe('F2 delete outcome', () => {
  const clickDelete = async () => {
    await waitFor(() => screen.getByText('1 report'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })); });
  };

  it('a 503 (lost connection) is "not sure" and re-reads', async () => {
    reads = [{ status: 200, body: { reports: [REPORT] } }];
    deletes = [{ status: 503 }];
    render(<ReportsPage />);
    await clickDelete();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(REPORT_DELETE_UNKNOWN));
    expect(getCalls()).toBe(2);
  });

  it('a 403 is a refusal with the server sentence, and no re-read', async () => {
    reads = [{ status: 200, body: { reports: [REPORT] } }];
    deletes = [{ status: 403, body: { error: 'Not allowed.' } }];
    render(<ReportsPage />);
    await clickDelete();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(`${REPORT_DELETE_REFUSED} Not allowed.`));
    expect(getCalls()).toBe(1);
  });

  it('control: a successful delete re-reads with no message', async () => {
    reads = [{ status: 200, body: { reports: [REPORT] } }, { status: 200, body: { reports: [] } }];
    deletes = [{ status: 200, body: {} }];
    render(<ReportsPage />);
    await clickDelete();
    await waitFor(() => expect(getCalls()).toBe(2));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
