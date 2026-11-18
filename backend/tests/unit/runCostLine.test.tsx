/**
 * @jest-environment jsdom
 *
 * Cost before consent (b3, 2026-11-18): Market Pulse shows what a run costs BEFORE Run, from the
 * pricing catalog (never a client literal), as a PRICE, never an affordability check (7c).
 */
import React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

const fetchWithAuth = jest.fn();
jest.mock('../../../components/community-ai/fetchWithAuth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import RunCostLine, { runCostText } from '../../../components/billing/RunCostLine';

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const MP = { actionKey: 'market_pulse', minCredits: 8, maxCredits: 8, expectedCredits: 8, tokenPriced: false, source: 'credit_cost_config' };

beforeEach(() => fetchWithAuth.mockReset());

describe('runCostText (pure)', () => {
  it('fixed price × regions, with the arithmetic shown', () => {
    expect(runCostText({ range: MP, quantity: 2, unit: 'region', unitPlural: 'regions' })).toBe('This run uses 16 credits (8 per region × 2 regions).');
    expect(runCostText({ range: MP, quantity: 1, unit: 'region', unitPlural: 'regions' })).toBe('This run uses 8 credits.');
    expect(runCostText({ range: MP, quantity: 0, unit: 'region', unitPlural: 'regions' })).toBe('This run uses 8 credits.'); // never below 1 unit
  });
  it('a token-priced band says "about" and that the final charge is actual usage', () => {
    expect(runCostText({ range: { minCredits: 5, maxCredits: 12, tokenPriced: true }, quantity: 1, unit: 'item', unitPlural: 'items' }))
      .toBe('This run uses about 5–12 credits; the final charge is what it actually uses.');
  });
  it('no range -> price unavailable (never a guess)', () => {
    expect(runCostText({ range: null, quantity: 3, unit: 'region', unitPlural: 'regions' })).toBe('Price unavailable right now.');
  });
});

describe('RunCostLine', () => {
  it('reads the catalog for the action and shows the price', async () => {
    fetchWithAuth.mockResolvedValueOnce(reply(200, { ranges: [MP], unknown: [] }));
    render(<RunCostLine companyId="c1" actionKey="market_pulse" quantity={3} unit="region" unitPlural="regions" />);
    expect(await screen.findByText('This run uses 24 credits (8 per region × 3 regions).')).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/billing/activity-cost-range?companyId=c1&actions=market_pulse');
  });
  it('an action the catalog doesn’t price yet (in `unknown`) -> price unavailable', async () => {
    fetchWithAuth.mockResolvedValueOnce(reply(200, { ranges: [], unknown: ['market_pulse'] }));
    render(<RunCostLine companyId="c1" actionKey="market_pulse" quantity={2} unit="region" unitPlural="regions" />);
    expect(await screen.findByText('Price unavailable right now.')).toBeInTheDocument();
  });
  it('the catalog can’t be read -> price unavailable', async () => {
    fetchWithAuth.mockResolvedValueOnce(reply(500, {}));
    render(<RunCostLine companyId="c1" actionKey="market_pulse" quantity={2} unit="region" unitPlural="regions" />);
    expect(await screen.findByText('Price unavailable right now.')).toBeInTheDocument();
  });
  it('a free run says so and does not ask the catalog', () => {
    render(<RunCostLine companyId="c1" actionKey="market_pulse" quantity={2} unit="region" unitPlural="regions" free freeText="No credits." />);
    expect(screen.getByTestId('run-cost-market_pulse')).toHaveTextContent('No credits.');
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('Market Pulse V2 wiring', () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
  const M = read('components/recommendations/tabs/MarketPulseTabV2Main.tsx');
  const C = read('components/recommendations/tabs/MarketPulseTabV2Controller.tsx');
  it('both Run buttons and the automation section show the catalog price per region', () => {
    expect(M.split('<RunCostLine').length - 1).toBe(3);
    expect(M.match(/actionKey="market_pulse"/g)).toHaveLength(3);
    expect(M.match(/quantity=\{Math\.max\(1, resolvedRegionPreview\.length\)\}/g)).toHaveLength(3);
    expect(M.match(/free=\{sourceStrategy === 'api'\}/g)).toHaveLength(3);
  });
  it('the price line is NOT an affordability check (no balance comparison anywhere in it)', () => {
    // Strip comments (the header legitimately mentions the 402's `available`), then forbid any
    // balance read or comparison in the CODE.
    const code = read('components/billing/RunCostLine.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bbalance\b|\bavailable\b|useCredits|creditBalance/i);
    // control: the stripped code still contains the price logic (the strip didn't empty it)
    expect(code).toContain('runCostText');
  });
  it('automation cadence defaults to WEEKLY, daily optional, and is saved + read back', () => {
    expect(C).toMatch(/useState<'weekly' \| 'daily'>\('weekly'\)/);
    expect(C).toMatch(/setCadence\(data\.settings\.cadence === 'daily' \? 'daily' : 'weekly'\)/);
    expect(C).toMatch(/\n\s+cadence,\n/);
    expect(C).not.toMatch(/cadence: 'daily'/);
    expect(M).toContain("{cadence === 'daily' ? 'once a day' : 'once a week'}");
    expect(M).not.toMatch(/once per UTC day|Enable daily Market Pulse monitoring/);
  });
});
