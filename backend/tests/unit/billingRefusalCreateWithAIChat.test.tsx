/**
 * @jest-environment jsdom
 *
 * Creator "Create with AI" chat (04, 2026-11-20). A billing refusal used to show the server's internal text
 * ("[runBilledAiCompletion] orchestrator did not execute: status=insufficient_credits"). Now: client copy keyed on
 * the code, and a non-billing failure shows a fixed message, never the server's text.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import CreateWithAIChat from '../../../components/creator/CreateWithAIChat';
import { BILLING_REFUSAL_COPY } from '../../../lib/billing/billingRefusalCopy';

let answer: { status: number; body: unknown } = { status: 402, body: { error: 'Billing refused', code: 'INSUFFICIENT_CREDITS' } };
beforeEach(() => {
  (Element.prototype as any).scrollTo = () => {}; // jsdom has no scrollTo
  (global as any).fetch = jest.fn(async () => ({
    ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body,
  }));
});
afterEach(() => { delete (global as any).fetch; });

async function sendHi() {
  render(<CreateWithAIChat assetFamily="poster" assetLabel="poster" companyId="co" onApply={() => {}} onClose={() => {}} />);
  const input = screen.getByPlaceholderText(/Type or speak/);
  fireEvent.change(input, { target: { value: 'a poster for our sale' } });
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
}

it.each<[string, { status: number; body: unknown }, string]>([
  ['402 INSUFFICIENT_CREDITS', { status: 402, body: { error: 'Billing refused', code: 'INSUFFICIENT_CREDITS' } }, BILLING_REFUSAL_COPY.INSUFFICIENT_CREDITS],
  ['403 ORG_CONTROL_BLOCKED', { status: 403, body: { error: 'Billing refused', code: 'ORG_CONTROL_BLOCKED' } }, BILLING_REFUSAL_COPY.ORG_CONTROL_BLOCKED],
  ['a 500 carrying internal text', { status: 500, body: { error: '[runBilledAiCompletion] orchestrator did not execute: status=error' } }, 'The assistant could not answer right now. Please try again.'],
])('%s → client copy, never the server text', async (_n, a, copy) => {
  answer = a;
  await sendHi();
  await waitFor(() => expect(screen.getByText(copy)).toBeTruthy());
  expect(screen.queryByText(/runBilledAiCompletion|orchestrator|Billing refused/)).toBeNull();
});
