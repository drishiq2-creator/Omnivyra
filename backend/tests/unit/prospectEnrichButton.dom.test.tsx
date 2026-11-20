/**
 * @jest-environment jsdom
 *
 * PI (c6 2026-11-20): the prospect page's Enrichment card gets an "Enrich" button per planned field.
 * Real panel, apiFetch mocked. Load-bearing: the POST names the field and its subject, the answer is shown in plain
 * words, the panel is re-read afterwards, and a refusal / no-answer is never shown as a success.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SWRConfig } from 'swr';

const mockApiFetch = jest.fn();
jest.mock('@/lib/apiFetch', () => ({ apiFetch: (u: string, init?: RequestInit) => mockApiFetch(u, init) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Panel = require('../../../components/prospects/ProspectIntelligencePanel').default;

const section = (data: unknown, state = 'available') => ({ state, reason: 'r', data });
const DETAIL = {
  version: 'v', prospectId: 'p-1', personId: 'person-1', accountId: null,
  engagement: section(null, 'empty'), account: section(null, 'empty'),
  enrichment: section({ counts: { missing: 1 }, toEnrich: [{ attribute: 'job_title', subject: 'person', reason: 'missing' }] }),
  scoring: section(null, 'not_evaluated'), recommendation: section(null, 'not_evaluated'),
  readiness: section(null, 'not_evaluated'), outcomes: section(null, 'empty'),
};
const resp = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body });

const withSwr = (ui: React.ReactElement) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>
);

let postAnswer: () => Promise<unknown>;
beforeEach(() => {
  mockApiFetch.mockReset();
  postAnswer = async () => resp(200, { status: 'executed', execution: { outcome: 'enriched', refusal: null } });
  mockApiFetch.mockImplementation((u: string, init?: RequestInit) =>
    (init?.method === 'POST' ? postAnswer() : Promise.resolve(resp(200, DETAIL))));
});

const gets = () => mockApiFetch.mock.calls.filter(([, i]) => !i || i.method !== 'POST').length;

describe('Enrich button', () => {
  it('POSTs the named field + subject for this company, shows the result, and re-reads the panel', async () => {
    render(withSwr(<Panel companyId="co-1" prospectId="p-1" />));
    const btn = await screen.findByRole('button', { name: 'Enrich' });
    const before = gets();
    fireEvent.click(btn);
    expect(await screen.findByRole('status')).toHaveTextContent('Found and saved.');
    const post = mockApiFetch.mock.calls.find(([, i]) => i?.method === 'POST')!;
    expect(post[0]).toBe('/api/prospects/p-1/enrich?companyId=co-1');
    expect(JSON.parse(String(post[1].body))).toEqual({ attribute: 'job_title', subject: 'person' });
    await waitFor(() => expect(gets()).toBeGreaterThan(before)); // re-read after the run
  });

  it('a non-admin (403) is told enrichment is admin-only - not shown as a success', async () => {
    postAnswer = async () => resp(403, { error: 'forbidden' });
    render(withSwr(<Panel companyId="co-1" prospectId="p-1" />));
    fireEvent.click(await screen.findByRole('button', { name: 'Enrich' }));
    const s = await screen.findByRole('status');
    expect(s).toHaveTextContent('Only company admins can run enrichment.');
    expect(s).not.toHaveTextContent('Found and saved.');
  });

  it('no answer (network failure) -> "could not confirm", never success or failure', async () => {
    postAnswer = async () => { throw new TypeError('Failed to fetch'); };
    render(withSwr(<Panel companyId="co-1" prospectId="p-1" />));
    fireEvent.click(await screen.findByRole('button', { name: 'Enrich' }));
    expect(await screen.findByRole('status')).toHaveTextContent('We could not confirm what happened');
  });

  it('CONTROL: no planned fields -> no Enrich button', async () => {
    mockApiFetch.mockImplementation(() => Promise.resolve(resp(200, {
      ...DETAIL, enrichment: section({ counts: {}, toEnrich: [] }),
    })));
    render(withSwr(<Panel companyId="co-1" prospectId="p-1" />));
    await screen.findByText('Enrichment plan');
    expect(screen.queryByRole('button', { name: 'Enrich' })).toBeNull();
  });
});
