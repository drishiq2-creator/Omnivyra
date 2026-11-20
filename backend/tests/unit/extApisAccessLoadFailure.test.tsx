/**
 * @jest-environment jsdom
 *
 * /external-apis-access: a failed read is never shown as an empty list (b3 rule 1, 2026-11-20).
 * Before: loadRequests did `if (!response.ok) { setRequests([]); return; }` and the Approval Queue said
 * "No requests in the queue."; loadApis kept the previous company's APIs on screen after a failed switch.
 * Required shape: honest failure + Retry that re-reads + a genuinely empty success still shows empty.
 *
 * SECRETS: none. No network (fetchWithAuth is mocked).
 */
import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = jest.fn();
jest.mock('../../../components/community-ai/fetchWithAuth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
let companyId: string | null = 'co-1';
jest.mock('../../../components/CompanyContext', () => ({
  useCompanyContext: () => ({ selectedCompanyId: companyId, isLoading: false }),
}));

import { useExtApisAccess } from '../../../hooks/useExtApisAccess';
import ExtApisAccessSectionsA from '../../../components/ExtApisAccessSectionsA';
import ExtApisAccessSectionsB from '../../../components/ExtApisAccessSectionsB';
import { APIS_LOAD_FAILED, REQUESTS_LOAD_FAILED } from '../../../lib/extApis/accessLoadCopy';

type Answer = { status: number; body?: unknown } | 'throw';
function res(a: Answer) {
  if (a === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
  return Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body ?? {} });
}
/** Route by URL: `/access` answers `apis`, `/requests` answers `reqs` (each a queue, last one repeats). */
function route(apis: Answer[], reqs: Answer[]) {
  fetchWithAuth.mockImplementation((url: string) => {
    const q = url.includes('/api/external-apis/requests') ? reqs : apis;
    return res(q.length > 1 ? q.shift()! : q[0]);
  });
}
const API = { id: 'a1', name: 'Trends API', base_url: 'https://x', purpose: 'trends', auth_type: 'none', is_active: true };
const ACCESS_OK = { status: 200, body: { availableApis: [API], companyDefaultApis: ['a1'], permissions: { canManageExternalApis: true } } };
const REQ = { id: 'r1', name: 'News API', base_url: 'https://n', status: 'pending_admin_review', created_at: '2026-11-01T00:00:00Z' };

beforeEach(() => { fetchWithAuth.mockReset(); companyId = 'co-1'; });

describe('useExtApisAccess: request queue read', () => {
  it.each<[string, Answer]>([
    ['a 503', { status: 503, body: { error: 'ROLE_READ_FAILED' } }],
    ['a 500', { status: 500 }],
    ['a lost connection (fetch throws)', 'throw'],
  ])('%s is a failure, not an empty queue', async (_n, answer) => {
    route([ACCESS_OK], [answer]);
    const { result } = renderHook(() => useExtApisAccess());
    await waitFor(() => expect(result.current.requestsLoadError).toBe(REQUESTS_LOAD_FAILED));
    expect(result.current.requests).toEqual([]);
  });

  it('control: an empty success is empty, with no failure', async () => {
    route([ACCESS_OK], [{ status: 200, body: { requests: [] } }]);
    const { result } = renderHook(() => useExtApisAccess());
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.requestsLoadError).toBeNull();
    expect(result.current.requests).toEqual([]);
  });

  it('Retry re-reads: a failure then a success clears the failure and shows the rows', async () => {
    route([ACCESS_OK], [{ status: 503 }, { status: 200, body: { requests: [REQ] } }]);
    const { result } = renderHook(() => useExtApisAccess());
    await waitFor(() => expect(result.current.requestsLoadError).toBe(REQUESTS_LOAD_FAILED));
    const before = fetchWithAuth.mock.calls.filter(([u]) => String(u).includes('/requests')).length;
    await act(async () => { await result.current.loadRequests(); });
    expect(fetchWithAuth.mock.calls.filter(([u]) => String(u).includes('/requests')).length).toBe(before + 1);
    expect(result.current.requestsLoadError).toBeNull();
    expect(result.current.requests).toEqual([REQ]);
  });
});

describe('useExtApisAccess: API list read', () => {
  it.each<[string, Answer]>([
    ['a 503', { status: 503 }],
    ['a lost connection (fetch throws)', 'throw'],
  ])('%s is a failure and clears the PREVIOUS company\'s APIs', async (_n, answer) => {
    route([ACCESS_OK, answer], [{ status: 200, body: { requests: [] } }]);
    const { result, rerender } = renderHook(() => useExtApisAccess());
    await waitFor(() => expect(result.current.apis).toEqual([API]));
    companyId = 'co-2';
    rerender();
    await waitFor(() => expect(result.current.apisLoadError).toBe(APIS_LOAD_FAILED));
    expect(result.current.apis).toEqual([]);
    expect(result.current.globalPresets).toEqual([]);
    expect(result.current.companyDefaultApis).toEqual([]);
  });

  it('control: a successful load has no failure', async () => {
    route([ACCESS_OK], [{ status: 200, body: { requests: [] } }]);
    const { result } = renderHook(() => useExtApisAccess());
    await waitFor(() => expect(result.current.apis).toEqual([API]));
    expect(result.current.apisLoadError).toBeNull();
  });
});

/** The sections only read what they render; a partial `f` is enough. */
function sectionProps(over: Record<string, unknown>) {
  return {
    activeTab: 'approval', requests: [], requestsLoadError: null, apis: [], apisLoadError: null, visibleApis: [],
    globalPresets: [], companyDefaultApis: [], drafts: {}, activeCount: 0, isLoading: false,
    loadRequests: jest.fn(), loadApis: jest.fn(), requestForm: {}, usageTotals: { requestsToday: 0, failuresToday: 0 },
    ...over,
  } as any;
}

describe('sections render the failure, never the empty sentence', () => {
  it('Approval Queue: failure + Retry calls loadRequests; no "No requests in the queue."', () => {
    const f = sectionProps({ requestsLoadError: REQUESTS_LOAD_FAILED });
    render(<ExtApisAccessSectionsB f={f} />);
    expect(screen.getByRole('alert').textContent).toContain(REQUESTS_LOAD_FAILED);
    expect(screen.queryByText('No requests in the queue.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(f.loadRequests).toHaveBeenCalledTimes(1);
  });

  it('control: Approval Queue with an empty success says it is empty', () => {
    render(<ExtApisAccessSectionsB f={sectionProps({})} />);
    expect(screen.getByText('No requests in the queue.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Usage tab: failure + Retry calls loadApis; no "No APIs configured."', () => {
    const f = sectionProps({ activeTab: 'usage', apisLoadError: APIS_LOAD_FAILED });
    render(<ExtApisAccessSectionsB f={f} />);
    expect(screen.queryByText(/No APIs configured/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(f.loadApis).toHaveBeenCalledTimes(1);
  });

  it('Presets tab: failure in both lists, count shows "—", no "none available" sentences', () => {
    render(<ExtApisAccessSectionsA f={sectionProps({ activeTab: 'presets', apisLoadError: APIS_LOAD_FAILED })} />);
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getByText('Enabled: —')).toBeTruthy();
    expect(screen.queryByText('No APIs are currently available.')).toBeNull();
    expect(screen.queryByText('No global presets are available.')).toBeNull();
  });

  it('control: Presets tab with an empty success says both lists are empty', () => {
    render(<ExtApisAccessSectionsA f={sectionProps({ activeTab: 'presets' })} />);
    expect(screen.getByText('No APIs are currently available.')).toBeTruthy();
    expect(screen.getByText('No global presets are available.')).toBeTruthy();
    expect(screen.getByText('Enabled: 0')).toBeTruthy();
  });
});
