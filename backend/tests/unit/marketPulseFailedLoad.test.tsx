/**
 * @jest-environment jsdom
 *
 * b3 standing rule 2026-11-19: a read failure must never render as absence. /market-pulse
 * (ExecutiveMarketPulseExperience) used to clear the payload on a failed context load and then show
 * "No digest items for this view yet." / "No material MarketPulse executive digest is available yet.",
 * telling the user there was nothing when we simply could not read it. A failed owners read rendered
 * an owner picker with no one in it.
 */
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ExecutiveMarketPulseExperience from '../../../components/market-pulse/ExecutiveMarketPulseExperience';

type Reply = 'ok' | 'http500' | 'reject';
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const http500 = () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }) as unknown as Response;

function makeFetch(plan: { context: Reply[]; people: Reply[] }) {
  const calls: string[] = [];
  const next = (list: Reply[]) => (list.length > 1 ? list.shift()! : list[0]);
  const fn = jest.fn(async (input: RequestInfo) => {
    const url = String(input);
    calls.push(url);
    const reply = url.includes('/api/market-pulse/context') ? next(plan.context)
      : url.includes('/api/market-pulse/people') ? next(plan.people)
      : 'ok';
    if (reply === 'reject') throw new TypeError('Failed to fetch');
    if (reply === 'http500') return http500();
    if (url.includes('/api/market-pulse/people')) return ok({ people: [{ id: 'p1', label: 'Ana', display_name: 'Ana', department: 'leadership' }] });
    return ok({ executiveExperience: { digestItems: [] } });
  });
  return { fn, calls };
}

const LOAD_FAILED = "We couldn't load this just now. Try again.";
const ABSENCE = [/No digest items for this view yet/, /No material MarketPulse executive digest/, /protected fallback state/];

function renderPage(fetchWithAuth: jest.Mock) {
  return render(<ExecutiveMarketPulseExperience companyId="c1" routeMode fetchWithAuth={fetchWithAuth as never} />);
}

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('context read failure is not absence', () => {
  it.each<Reply>(['http500', 'reject'])('%s: says it could not load, never "no items yet"', async (reply) => {
    const { fn } = makeFetch({ context: [reply], people: ['ok'] });
    renderPage(fn);
    expect(await screen.findByText(LOAD_FAILED)).toBeInTheDocument();
    for (const absence of ABSENCE) expect(screen.queryByText(absence)).not.toBeInTheDocument();
  });

  it('Try again re-reads, and a real empty answer then shows the empty state', async () => {
    const { fn, calls } = makeFetch({ context: ['http500', 'ok'], people: ['ok'] });
    renderPage(fn);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    // Control: a SUCCESSFUL empty read is genuine absence and may say so.
    expect(await screen.findByText(/No digest items for this view yet/)).toBeInTheDocument();
    expect(screen.queryByText(LOAD_FAILED)).not.toBeInTheDocument();
    expect(calls.filter((u) => u.includes('/api/market-pulse/context'))).toHaveLength(2);
  });

  it('control: a successful read shows no load-failure message', async () => {
    const { fn } = makeFetch({ context: ['ok'], people: ['ok'] });
    renderPage(fn);
    expect(await screen.findByText(/No digest items for this view yet/)).toBeInTheDocument();
    expect(screen.queryByText(LOAD_FAILED)).not.toBeInTheDocument();
  });
});

describe('owners read failure is not "no one to assign"', () => {
  const OWNERS_FAILED = /We couldn't load the list of owners just now/;

  it.each<Reply>(['http500', 'reject'])('%s: the owner picker says the list could not load, with a retry', async (reply) => {
    const { fn, calls } = makeFetch({ context: ['ok'], people: [reply, 'ok'] });
    renderPage(fn);
    const notice = await screen.findByText(OWNERS_FAILED);
    const before = calls.filter((u) => u.includes('/api/market-pulse/people')).length;
    fireEvent.click(notice.querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByText(OWNERS_FAILED)).not.toBeInTheDocument());
    expect(calls.filter((u) => u.includes('/api/market-pulse/people')).length).toBe(before + 1);
    expect(screen.getByRole('option', { name: /Ana/ })).toBeInTheDocument();
  });

  it('control: a successful owners read shows no notice', async () => {
    const { fn } = makeFetch({ context: ['ok'], people: ['ok'] });
    renderPage(fn);
    expect(await screen.findByRole('option', { name: /Ana/ })).toBeInTheDocument();
    expect(screen.queryByText(OWNERS_FAILED)).not.toBeInTheDocument();
  });
});
