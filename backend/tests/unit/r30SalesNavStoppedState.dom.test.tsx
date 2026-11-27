/**
 * @jest-environment jsdom
 *
 * Round 30 / P0-1 + P0-3 — the Sales Navigator page under the legal stop, and the import results in prospects.
 *
 *   - legal_not_cleared outranks every other state: no acknowledgement, no Accept, no list input, no Extract - even
 *     when nobody has accepted the notice yet (the old page offered Accept in exactly that state);
 *   - the page says extraction is unavailable, never that Omnivyra can extract or sync saved leads;
 *   - the import link appears only when the import page exists in this build; otherwise it says import is not on;
 *   - CONTROL: a gate closed for any OTHER reason still renders the existing states;
 *   - the import results count new prospects / updates / unchanged from the prospect verdict, and report rows the
 *     file check left out.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockApiFetch = jest.fn();
jest.mock('@/lib/apiFetch', () => ({ apiFetch: (u: string, init?: unknown) => mockApiFetch(u, init) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: SalesNavExtract } = require('../../../components/prospects/salesnav/SalesNavExtract');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: SalesNavStoppedState } = require('../../../components/prospects/salesnav/SalesNavStoppedState');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: ResultsTable } = require('../../../components/prospects/import/ResultsTable');

const COMPANY = '11111111-2222-4333-8444-555555555555';
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const ACK = { version: 'placeholder-v0', textSha256: 'a'.repeat(64), text: 'PLACEHOLDER - pending legal review.', status: 'placeholder' };
const setup = (over: Record<string, unknown> = {}) => ({ transport: 'extension', ack: ACK, acked: true, gate: { allowed: true, reason: 'cleared' }, bound: true, ...over });
const LEGAL = { gate: { allowed: false, reason: 'legal_not_cleared' } };

beforeEach(() => mockApiFetch.mockReset());

describe('Sales Navigator page under the legal stop', () => {
  it.each([
    ['not yet acknowledged', { acked: false }],
    ['acknowledged', { acked: true }],
    ['ack unreadable', { acked: null }],
  ])('%s: the stopped state, with NO Accept, list input or Extract', async (_label, over) => {
    mockApiFetch.mockResolvedValueOnce(json(200, setup({ ...over, ...LEGAL })));
    render(<SalesNavExtract companyId={COMPANY} />);
    expect(await screen.findByTestId('salesnav-stopped')).toBeInTheDocument();
    expect(screen.getByText('Direct Sales Navigator extraction is not available')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Extract' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByTestId('ack-text')).toBeNull();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);          // only GET /setup; nothing is written
  });

  it('CONTROL: a gate closed for another reason keeps the existing behaviour (tenant flag message)', async () => {
    mockApiFetch.mockResolvedValueOnce(json(200, setup({ gate: { allowed: false, reason: 'tenant_flag_off:salesnav_extraction' } })));
    render(<SalesNavExtract companyId={COMPANY} />);
    expect(await screen.findByTestId('gate-closed')).toHaveTextContent('not switched on for your company');
    expect(screen.queryByTestId('salesnav-stopped')).toBeNull();
  });

  it('CONTROL: an open gate still renders Extract (the stopped state is not shown)', async () => {
    mockApiFetch.mockResolvedValueOnce(json(200, setup()));
    render(<SalesNavExtract companyId={COMPANY} />);
    expect(await screen.findByRole('button', { name: 'Extract' })).toBeInTheDocument();
    expect(screen.queryByTestId('salesnav-stopped')).toBeNull();
  });

  it('a settings load failure shows an error and no Extract (fails closed)', async () => {
    mockApiFetch.mockResolvedValueOnce(json(503, { error: 'X' }));
    render(<SalesNavExtract companyId={COMPANY} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("couldn't load Sales Navigator settings");
    expect(screen.queryByRole('button', { name: 'Extract' })).toBeNull();
  });
});

describe('SalesNavStoppedState copy', () => {
  it('links to the import wizard when the import page is enabled', () => {
    render(<SalesNavStoppedState importEnabled />);
    expect(screen.getByRole('link', { name: 'Import prospects from a file' })).toHaveAttribute('href', '/prospects/import');
    expect(screen.queryByTestId('salesnav-import-off')).toBeNull();
  });

  it('says import is not switched on (and links nowhere) when the import page is off', () => {
    render(<SalesNavStoppedState importEnabled={false} />);
    expect(screen.queryByRole('link', { name: 'Import prospects from a file' })).toBeNull();
    expect(screen.getByTestId('salesnav-import-off')).toHaveTextContent('not switched on');
  });

  it('defaults to the build switch: NEXT_PUBLIC_PROSPECT_IMPORT_ENABLED unset means no link', () => {
    const saved = process.env.NEXT_PUBLIC_PROSPECT_IMPORT_ENABLED;
    delete process.env.NEXT_PUBLIC_PROSPECT_IMPORT_ENABLED;
    try {
      render(<SalesNavStoppedState />);
      expect(screen.queryByRole('link', { name: 'Import prospects from a file' })).toBeNull();
    } finally {
      if (saved !== undefined) process.env.NEXT_PUBLIC_PROSPECT_IMPORT_ENABLED = saved;
    }
  });

  it('promises no extraction, sync or CRM connection', () => {
    const { container } = render(<SalesNavStoppedState importEnabled />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/does not currently read, extract or sync leads/);
    expect(text).toMatch(/does not connect to your CRM directly yet/);
    expect(text).not.toMatch(/\bwe (will|can) (extract|sync)/i);
    expect(text).not.toMatch(/connect your CRM\b(?! directly yet)/i);
  });
});

describe('Import results count prospects, not evidence', () => {
  const base = {
    retryableCount: 0, retrying: false, transportError: null, aborted: false, profileSaveNote: null,
    onRetry: () => undefined, onStartOver: () => undefined,
  };
  const persisted = { status: 'persisted', leadId: 'l', reason: null, warnings: [], error: null };

  it('one new prospect, one update, one unchanged, one rejected - from the prospect verdict', () => {
    const outcomes = [
      { externalId: 'a', ok: true, prospectId: 'p1', prospectOutcome: 'created', provenanceOutcome: 'created', leadProjection: persisted },
      { externalId: 'b', ok: true, prospectId: 'p2', prospectOutcome: 'matched', provenanceOutcome: 'created', leadProjection: persisted },
      { externalId: 'c', ok: true, prospectId: 'p3', prospectOutcome: 'matched', provenanceOutcome: 'unchanged', leadProjection: persisted },
      { externalId: 'd', ok: false, rejection: 'validation_failed' },
    ];
    render(<ResultsTable {...base} outcomes={outcomes} succeeded={3} failed={1} />);
    expect(screen.getByTestId('tally-new')).toHaveTextContent('1');
    expect(screen.getByTestId('tally-updated')).toHaveTextContent('1');
    expect(screen.getByTestId('tally-unchanged')).toHaveTextContent('1');
    expect(screen.queryByTestId('excluded-rows')).toBeNull();
  });

  it('the same person twice in one file is ONE new prospect', () => {
    const outcomes = [
      { externalId: 'a', ok: true, prospectId: 'p1', prospectOutcome: 'created', provenanceOutcome: 'created', leadProjection: persisted },
      { externalId: 'a', ok: true, prospectId: 'p1', prospectOutcome: 'matched', provenanceOutcome: 'unchanged', leadProjection: persisted },
    ];
    render(<ResultsTable {...base} outcomes={outcomes} succeeded={2} failed={0} />);
    expect(screen.getByTestId('tally-new')).toHaveTextContent('1');
    expect(screen.getByTestId('tally-unchanged')).toHaveTextContent('1');
  });

  it('rows the file check left out are reported, never silently lost', () => {
    render(<ResultsTable {...base} outcomes={[]} succeeded={0} failed={0} excludedRows={2} />);
    expect(screen.getByTestId('excluded-rows')).toHaveTextContent('2 rows were left out before import');
  });
});
