/**
 * @jest-environment jsdom
 *
 * THE canonical client mapping for billed AI responses + one Idempotency-Key per user
 * action (e9 ruling, 2026-11-13; 55's final shape b9de17f62 / f8eb7dd78).
 */
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { classifyBilledResponse, billedOutcomeText, TOP_UP_HREF, KNOWN_UNVERIFIABLE_CODES, UNVERIFIABLE_MESSAGE, SETTLEMENT_PENDING_MESSAGE, UNCERTAIN_MESSAGE, RECLAIM_MESSAGE } from '../../../lib/billing/billedResponse';
import { createBilledActionKeyGate } from '../../../lib/idempotency';

describe('classifyBilledResponse: keyed on status + code only', () => {
  it('final 402 shape: readable `error`, code INSUFFICIENT_CREDITS, `balance`', () => {
    const o = classifyBilledResponse(402, { error: 'Insufficient credits to generate content', code: 'INSUFFICIENT_CREDITS', required: 5, balance: 2 }, 'x');
    expect(o).toEqual({ kind: 'credits', code: 'insufficient_credits', message: 'Insufficient credits to generate content', required: 5, available: 2 });
    // `required` is the HOLD: say it's reserved up front, not the price (7c / b3).
    expect(billedOutcomeText(o)).toBe('Insufficient credits to generate content (5 credits are reserved up front; you’ll only be charged for what’s used. You have 2). Top up credits on the Billing page.');
  });

  it('NO_CREDIT_ACCOUNT and PRICING_UNAVAILABLE (no top-up for pricing)', () => {
    expect(classifyBilledResponse(402, { error: 'No credit account', code: 'NO_CREDIT_ACCOUNT' }, 'x')).toMatchObject({ kind: 'credits', code: 'no_credit_account' });
    const p = classifyBilledResponse(402, { error: 'Pricing unavailable', code: 'PRICING_UNAVAILABLE' }, 'x');
    expect(p).toMatchObject({ kind: 'credits', code: 'pricing_unavailable' });
    expect(billedOutcomeText(p)).not.toMatch(/Top up/);
  });

  it('older body shape still maps (snake_case reason in `error`, sentence in `message`, `available`)', () => {
    expect(classifyBilledResponse(402, { error: 'insufficient_credits', message: 'Not enough.', available: 1 }, 'x'))
      .toEqual({ kind: 'credits', code: 'insufficient_credits', message: 'Not enough.', available: 1 });
  });

  it('409 ALREADY_PROCESSED is success; 500 RECLAIM_CAP_EXHAUSTED is a plain retry', () => {
    expect(classifyBilledResponse(409, { error: 'dup', code: 'ALREADY_PROCESSED' }, 'x').kind).toBe('already_processed');
    const reclaim = classifyBilledResponse(500, { error: 'cap', code: 'RECLAIM_CAP_EXHAUSTED', retryable: false }, 'x');
    expect(reclaim.kind).toBe('retry');
    expect(billedOutcomeText(reclaim)).not.toMatch(/RECLAIM|Top up/);
  });

  it('the known *_UNVERIFIABLE codes are exactly these (update when 6f adds one)', () => {
    expect([...KNOWN_UNVERIFIABLE_CODES].sort()).toEqual(['BUDGET_UNVERIFIABLE', 'DAILY_LIMIT_UNVERIFIABLE', 'ORG_CONTROLS_UNVERIFIABLE']);
  });

  it.each([...KNOWN_UNVERIFIABLE_CODES, 'SOME_FUTURE_UNVERIFIABLE'])(
    '503 %s: plain retry, nothing charged, never top-up, never the code',
    (code) => {
      const out = classifyBilledResponse(503, { error: 'internal detail', code }, 'fallback');
      expect(out).toEqual({ kind: 'retry', message: UNVERIFIABLE_MESSAGE });
      const text = billedOutcomeText(out);
      expect(text).toContain('Nothing was charged');
      expect(text).not.toMatch(/UNVERIFIABLE|Top up|internal detail/);
    },
  );

  it('the suffix rule needs an exact code shape (not just any string containing it)', () => {
    expect(classifyBilledResponse(503, { error: 'x', code: 'unverifiable' }, 'fallback').kind).toBe('uncertain');
    expect(classifyBilledResponse(503, { error: 'x', code: 'unverifiable' }, 'fallback').kind).not.toBe('retry');
    // a near-miss is NOT the 'nothing was charged' retry; as a 5xx it is 'uncertain'
    expect(classifyBilledResponse(503, { error: 'x', code: 'BUDGET_UNVERIFIABLE_SOMETHING' }, 'fallback').kind).toBe('uncertain');
  });

  it('never shows a raw code; 403 org codes use a human detail or the fallback', () => {
    expect(classifyBilledResponse(403, { error: 'ORG_SCOPE_VIOLATION' }, 'Not allowed here.')).toEqual({ kind: 'error', message: 'Not allowed here.' });
    expect(classifyBilledResponse(403, { error: 'ORG_CONTROL_BLOCKED', detail: 'Your admin paused AI generation.' }, 'x'))
      .toEqual({ kind: 'error', message: 'Your admin paused AI generation.' });
    expect(classifyBilledResponse(200, {}, 'x')).toEqual({ kind: 'ok' });
  });

  it('message text never decides the outcome (a 500 mentioning credits is not a credit outcome)', () => {
    expect(classifyBilledResponse(500, { error: 'insufficient credits somewhere' }, 'x').kind).toBe('uncertain');
    expect(classifyBilledResponse(400, { error: 'insufficient credits somewhere' }, 'x').kind).toBe('error');
  });

  it('2xx + settlementPending CREDIT_SETTLE_AMBIGUOUS: done, charge unresolved, never an error, never re-run', () => {
    const out = classifyBilledResponse(200, { status: 'executed', result: { id: 'r1' }, settlementPending: { code: 'CREDIT_SETTLE_AMBIGUOUS', holdId: 'h-secret', detail: 'internal' } }, 'x');
    expect(out).toEqual({ kind: 'settlement_pending', message: SETTLEMENT_PENDING_MESSAGE });
    expect(billedOutcomeText(out)).toBe('Done. Billing for this is still being finalised. You won’t be charged twice, so there’s no need to run it again.');
    expect(billedOutcomeText(out)).not.toMatch(/h-secret|internal|CREDIT_SETTLE/);
    // a plain 2xx stays plain ok
    expect(classifyBilledResponse(200, { status: 'executed', result: {} }, 'x').kind).toBe('ok');
    expect(classifyBilledResponse(200, { settlementPending: { code: 'SOMETHING_ELSE' } }, 'x').kind).toBe('ok');
  });

  it('an unclassified SERVER failure is "uncertain" (it may have run and been charged), a 4xx refusal is a plain error', () => {
    const out = classifyBilledResponse(502, { error: 'upstream' }, 'Failed');
    expect(out).toEqual({ kind: 'uncertain', message: UNCERTAIN_MESSAGE });
    expect(billedOutcomeText(out)).toBe('We’re not sure this went through. Please check the result before trying again.');
    expect(classifyBilledResponse(422, { error: 'Bad input' }, 'Failed')).toEqual({ kind: 'error', message: 'Bad input' });
  });

  it('RECLAIM_CAP_EXHAUSTED: a full refund, so "not charged" (owner ruling; c6 releases the entry fee on failure)', () => {
    const out = classifyBilledResponse(500, { code: 'RECLAIM_CAP_EXHAUSTED', retryable: false }, 'x');
    expect(out).toEqual({ kind: 'retry', message: RECLAIM_MESSAGE });
    expect(billedOutcomeText(out)).toBe('That didn’t finish on our side and you weren’t charged. Please try again.');
  });

  it('a failure that SAYS what was charged states it (blog billing object), instead of "uncertain"', () => {
    expect(classifyBilledResponse(500, { error: 'Failed to generate blog', billing: { charged: 12, released: 28, reason: 'partial' } }, 'x'))
      .toEqual({ kind: 'error', message: 'You were charged 12 of 40 credits; 28 were returned.' });
    expect(classifyBilledResponse(500, { error: 'Failed to generate blog', billing: { charged: 0, released: 40, reason: 'not_started' } }, 'x'))
      .toEqual({ kind: 'error', message: 'Failed to generate blog. You weren’t charged.' });
    expect(classifyBilledResponse(422, { error: 'Quality gate', quality_passed: false, billing: { charged: 0, released: 40, reason: 'quality_refund' } }, 'x'))
      .toEqual({ kind: 'error', message: 'This didn’t pass our quality check, so you weren’t charged.' });
    // without a billing object a 500 stays "uncertain"
    expect(classifyBilledResponse(500, { error: 'Failed to generate blog' }, 'x').kind).toBe('uncertain');
  });

  it('BILLING_UNAVAILABLE (refused hold, nothing created) is a retry, not "uncertain"', () => {
    expect(classifyBilledResponse(503, { code: 'BILLING_UNAVAILABLE', retryable: true }, 'x').kind).toBe('retry');
  });

  it('top-up target is /company/billing (same page as the credit-alert emails)', () => {
    expect(TOP_UP_HREF).toBe('/company/billing');
  });
});

describe('createBilledActionKeyGate: one key per user action', () => {
  it('a double-click (second begin while in flight) sends the SAME key', () => {
    const gate = createBilledActionKeyGate('t');
    const first = gate.begin('a');
    const second = gate.begin('a');
    expect(second.key).toBe(first.key);
    expect(second.headers).toEqual({ 'Idempotency-Key': first.key });
  });

  it('a deliberate second request (after the first ended) sends a NEW key', () => {
    const gate = createBilledActionKeyGate('t');
    const first = gate.begin('a').key;
    gate.end('a');
    expect(gate.begin('a').key).not.toBe(first);
  });

  it('independent items (scopes) never share a key', () => {
    const gate = createBilledActionKeyGate('t');
    expect(gate.begin('asset-1').key).not.toBe(gate.begin('asset-2').key);
  });
});

describe('a real billed caller: SuggestWithAIPanel', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    (global as any).fetch = fetchMock;
  });
  afterEach(() => { delete (global as any).fetch; });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SuggestWithAIPanel = require('../../../components/content/SuggestWithAIPanel').default;
  const keyOf = (i: number) => (fetchMock.mock.calls[i][1] as { headers: Record<string, string> }).headers['Idempotency-Key'];
  const ok = { ok: true, status: 200, json: async () => ({ suggestion: { title: 'Idea', body: 'B' } }) };

  it('sends an Idempotency-Key, and a deliberate "Suggest another" sends a NEW one', async () => {
    fetchMock.mockResolvedValue(ok);
    render(<SuggestWithAIPanel companyId="co-1" contentType="post" onAccept={() => {}} />);
    fireEvent.click(screen.getByTestId('suggest-with-ai-trigger'));
    await waitFor(() => expect(screen.getByTestId('suggest-with-ai-another')).toBeEnabled());
    fireEvent.click(screen.getByTestId('suggest-with-ai-another'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(keyOf(0)).toMatch(/^content-suggest-/);
    expect(keyOf(1)).toMatch(/^content-suggest-/);
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it('a 402 shows plain language with the top-up hint, never the raw code', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 402, json: async () => ({ error: 'Insufficient credits to generate content', code: 'INSUFFICIENT_CREDITS', required: 3, balance: 0 }) });
    render(<SuggestWithAIPanel companyId="co-1" contentType="post" onAccept={() => {}} />);
    fireEvent.click(screen.getByTestId('suggest-with-ai-trigger'));
    expect(await screen.findByText(/Insufficient credits to generate content \(3 credits are reserved up front; you’ll only be charged for what’s used\. You have 0\)\. Top up credits on the Billing page\./)).toBeInTheDocument();
    expect(screen.queryByText(/INSUFFICIENT_CREDITS/)).not.toBeInTheDocument();
  });
});

describe('every wired billed caller sends a per-action key and classifies errors', () => {
  const read = (p: string) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8') as string;
  it.each([
    ['components/recommendations/tabs/MarketPulseTabV2Controller.tsx', 'mpRunKeys', 'runOp'],
    ['components/blog/AIBlogCardModal.tsx', 'blogChatKeys', 'chatOp'],
    ['components/campaign-ai/useCampaignAiOps.ts', 'regenerateKeys', 'regenOp'],
    ['hooks/useActivityWorkspaceRefinementOps.ts', 'refineKeys', 'refineOp'],
    ['components/content/SuggestWithAIPanel.tsx', 'suggestKeys', 'suggestOp'],
  ])('%s', (file, gate, op) => {
    const src = read(file);
    expect(src).toMatch(new RegExp(String.raw`const ${gate} = createBilledActionKeyGate\(`));
    expect(src).toMatch(new RegExp(String.raw`const ${op} = ${gate}\.begin\(`));
    expect(src).toMatch(new RegExp(String.raw`\.\.\.${op}\.headers`));
    expect(src).toMatch(new RegExp(String.raw`finally \{\s*${gate}\.end\(`));
    expect(src).toMatch(/classifyBilledResponse|parseRunStartError/);
  });
});
