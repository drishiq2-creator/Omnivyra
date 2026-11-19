/**
 * @jest-environment jsdom
 *
 * Market Pulse credit notices (55's charging afb199ca9 + 650a0ac8b). A 402 on run start
 * and part-way runs must show plain language plus a top-up link, never a raw code.
 * Region outcomes are keyed on `code`, never on message text.
 */
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import {
  TOP_UP_HREF,
  parseRunStartError,
  MarketPulseCreditNotice,
  MarketPulseRunWarnings,
  type CreditNotice,
} from '../../../components/recommendations/tabs/MarketPulseCreditNotices';

describe('parseRunStartError', () => {
  it('402 insufficient_credits → credit notice with the server message and numbers', () => {
    const r = parseRunStartError(402, {
      error: 'insufficient_credits', message: 'This scan needs more credits than you have.', required: 120, available: 40,
    });
    expect(r).toEqual({ kind: 'credits', code: 'insufficient_credits', message: 'This scan needs more credits than you have.', required: 120, available: 40 });
  });

  it.each(['insufficient_credits', 'no_credit_account', 'pricing_unavailable'])(
    '402 %s without a message → readable fallback, never the raw code',
    (code) => {
      const r = parseRunStartError(402, { error: code });
      expect(r.kind).toBe('credits');
      expect(r.message).not.toBe(code);
      expect(r.message).not.toMatch(/_/);
    },
  );

  it('non-credit errors keep a human message but hide snake_case codes', () => {
    // a 5xx may have started the run: say so, never a bare server message (7c)
    expect(parseRunStartError(500, { error: 'Database is down' })).toEqual({ kind: 'error', message: 'We’re not sure this went through. Please check the result before trying again.' });
    expect(parseRunStartError(403, { error: 'MARKET_PULSE_ADMIN_REQUIRED', message: 'Market Pulse scan console is for company admins' }))
      .toEqual({ kind: 'error', message: 'Market Pulse scan console is for company admins' });
    expect(parseRunStartError(500, { error: 'some_internal_code' })).toEqual({ kind: 'error', message: 'We’re not sure this went through. Please check the result before trying again.' });
    expect(parseRunStartError(400, { error: 'some_internal_code' })).toEqual({ kind: 'error', message: 'Failed to start Market Pulse run' });
  });
});

describe('rendering', () => {
  it('credit notice shows the message, numbers and the top-up link to /company/billing', () => {
    const notice: CreditNotice = { kind: 'credits', code: 'insufficient_credits', message: 'Not enough credits.', required: 120, available: 40 };
    render(<MarketPulseCreditNotice notice={notice} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Not enough credits.');
    expect(screen.getByRole('alert')).toHaveTextContent('This scan needs 120 credits; you have 40.');
    expect(screen.getByRole('link', { name: 'Top up credits' })).toHaveAttribute('href', TOP_UP_HREF);
    expect(TOP_UP_HREF).toBe('/company/billing');
    expect(screen.queryByText(/insufficient_credits/)).not.toBeInTheDocument();
  });

  it('pricing_unavailable: no top-up link (topping up would not help)', () => {
    render(<MarketPulseCreditNotice notice={{ kind: 'credits', code: 'pricing_unavailable', message: 'Pricing is unavailable.' }} />);
    expect(screen.queryByRole('link', { name: 'Top up credits' })).not.toBeInTheDocument();
  });

  it('run warnings: only for completed_with_warnings', () => {
    const { rerender } = render(<MarketPulseRunWarnings status="completed" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<MarketPulseRunWarnings status="COMPLETED_WITH_WARNINGS" />);
    expect(screen.getByRole('status')).toHaveTextContent(/some regions didn’t complete/);
  });

  // b3 2026-11-19: the per-region list was dormant (no producer of run.region_issues on main or the
  // canonical MP billing) and CHARGED_NO_OUTPUT is unreachable there. Nothing may claim a per-region
  // charge outcome, refund or "wasn't charged" that no code produces.
  it('the banner makes no per-region charge, refund or top-up claim', () => {
    render(<MarketPulseRunWarnings status="completed_with_warnings" />);
    const status = screen.getByRole('status');
    expect(status).not.toHaveTextContent(/charged|refund|flagged|no action is needed/i);
    expect(screen.queryByRole('link', { name: 'Top up credits' })).not.toBeInTheDocument();
  });

  it('the removed region codes appear nowhere in the UI source', () => {
    const read = (p: string) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8') as string;
    const files = [
      'components/recommendations/tabs/MarketPulseCreditNotices.tsx',
      'components/recommendations/tabs/MarketPulseTabV2Main.tsx',
      'components/recommendations/tabs/MarketPulseTabV2Model.tsx',
    ];
    for (const f of files) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // comments may narrate the removal
      expect(src.length).toBeGreaterThan(200); // non-vacuous: the file was read
      expect({ f, hit: /CHARGED_NO_OUTPUT|ALREADY_RELEASED|region_issues|describeRegionIssue/.test(src) }).toEqual({ f, hit: false });
    }
  });
});

describe('the V2 console uses the parser for run-start errors', () => {
  it('no raw err.error is thrown for a failed run start', () => {
    const src = require('fs').readFileSync(
      require('path').join(process.cwd(), 'components/recommendations/tabs/MarketPulseTabV2Controller.tsx'), 'utf8') as string;
    expect(src).toMatch(/parseRunStartError\(res\.status, err\)/);
    expect(src).not.toMatch(/throw new Error\(err\?\.error \|\| 'Failed to start Market Pulse run'\)/);
  });
});
