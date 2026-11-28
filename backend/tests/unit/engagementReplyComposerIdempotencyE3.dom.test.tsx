/**
 * @jest-environment jsdom
 */
/**
 * E3 (register row T-2) — the reply composer keeps ONE client key per composed
 * reply and never invites a blind resend.
 *
 * Real: ReplyComposer, lib/engagement/replySendOutcome, the capability map.
 * Mocked: fetch (a route double recording every POST body), the voice button
 * and telemetry. Each "same key" assertion first proves the key is a non-empty
 * string (undefined === undefined must not pass), and is paired with a control
 * where the key MUST change.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('../../../components/ChatVoiceButton', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/engagementTelemetry', () => ({ recordEngagementEvent: jest.fn(async () => undefined) }));

import { ReplyComposer } from '../../../components/engagement/ReplyComposer';

type Answer = { status: number; body: unknown } | 'network-error';
const answers: Answer[] = [];
const bodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  answers.length = 0;
  bodies.length = 0;
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    const a = answers.shift() ?? { status: 500, body: { error: 'no answer scripted' } };
    if (a === 'network-error') throw new TypeError('Failed to fetch');
    return { ok: a.status >= 200 && a.status < 300, status: a.status, statusText: '', json: async () => a.body } as unknown as Response;
  });
});

const EXECUTED = { status: 200, body: { success: true, status: 'executed', confirmed: true, platform_id: 'urn:li:comment:9' } };
const UNKNOWN_409 = {
  status: 409,
  body: { success: false, code: 'REPLY_OUTCOME_UNKNOWN', outcome: 'unknown', retryable: false, error: 'Sending status unknown — this reply may already have reached the platform. Check the conversation before resending; it was not sent again.' },
};

function mount(extra: Partial<React.ComponentProps<typeof ReplyComposer>> = {}) {
  return render(
    <ReplyComposer threadId="t1" messageId="m1" platform="linkedin" organizationId="org1" messageType="comment" {...extra} />,
  );
}
const type = (text: string) => fireEvent.change(screen.getByPlaceholderText('Write a reply...'), { target: { value: text } });
const send = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: /send/i })); }); };
const alertText = () => screen.queryByRole('alert')?.textContent ?? '';
const keyOf = (i: number) => bodies[i]?.client_reply_key;

describe('E3 composer — network error / timeout keeps the key and reports "status unknown"', () => {
  it('a network error shows "sending status unknown — check before resending" (not "failed, try again"), and the resend reuses the key', async () => {
    mount();
    type('Thanks for the comment!');
    answers.push('network-error');
    await send();
    expect(alertText()).toMatch(/Sending status unknown — check the conversation before resending/);
    expect(alertText()).not.toMatch(/try again|failed/i);
    answers.push(EXECUTED);
    await send();
    expect(typeof keyOf(0)).toBe('string');
    expect(String(keyOf(0)).length).toBeGreaterThanOrEqual(16);
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('CONTROL: editing the reply after the unknown outcome makes a new logical reply (new key)', async () => {
    mount();
    type('Thanks for the comment!');
    answers.push('network-error');
    await send();
    type('Thanks for the thoughtful comment!');
    answers.push(EXECUTED);
    await send();
    expect(typeof keyOf(0)).toBe('string');
    expect(typeof keyOf(1)).toBe('string');
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it('a server "outcome unknown" answer is shown as unknown and the key is kept', async () => {
    mount();
    type('Hello');
    answers.push(UNKNOWN_409);
    await send();
    expect(alertText()).toMatch(/^Sending status unknown/);
    expect(alertText()).not.toMatch(/try again/i);
    expect(screen.getByRole('alert').getAttribute('data-status-unknown')).toBe('true');
    answers.push(UNKNOWN_409);
    await send();
    expect(typeof keyOf(0)).toBe('string');
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('a gateway 504 with no JSON body is unknown, never "failed"', async () => {
    mount();
    type('Hello');
    answers.push({ status: 504, body: undefined });
    (globalThis as { fetch: jest.Mock }).fetch.mockImplementationOnce(async (_u: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return { ok: false, status: 504, statusText: 'Gateway Timeout', json: async () => { throw new SyntaxError('Unexpected token <'); } } as unknown as Response;
    });
    await send();
    expect(alertText()).toMatch(/^Sending status unknown/);
  });

  it('CONTROL: a definite pre-send refusal (400) shows the server reason, not the unknown message', async () => {
    mount();
    type('Hello');
    answers.push({ status: 400, body: { error: 'Reply is not supported on this account.', code: 'ACTION_NOT_SUPPORTED' } });
    await send();
    expect(alertText()).toBe('Reply is not supported on this account.');
    expect(screen.getByRole('alert').getAttribute('data-status-unknown')).toBeNull();
  });
});

describe('E3 composer — success ends the logical reply', () => {
  it('after a confirmed send the next reply (even with the same words) gets a new key; the success message is shown', async () => {
    mount();
    type('Same words');
    answers.push(EXECUTED);
    await send();
    expect(screen.getByRole('status').textContent).toMatch(/confirmed by linkedin/i);
    type('Same words');
    answers.push(EXECUTED);
    await send();
    expect(typeof keyOf(0)).toBe('string');
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it('an "already sent" dedup answer is a success, not an error', async () => {
    mount();
    type('Hello');
    answers.push({ status: 200, body: { success: true, status: 'executed', already_sent: true, deduplicated: true, confirmed: true, platform_id: 'urn:li:comment:9' } });
    await send();
    expect(screen.getByRole('status').textContent).toMatch(/already sent/i);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('E3 composer — injected executor (inbox path)', () => {
  it('passes the stable clientReplyKey to onExecuteReply and reports a thrown network error as unknown, reusing the key', async () => {
    const seen: string[] = [];
    let attempt = 0;
    const onExecuteReply = jest.fn(async (input: { clientReplyKey?: string }) => {
      seen.push(String(input.clientReplyKey));
      attempt += 1;
      if (attempt === 1) throw new TypeError('Failed to fetch');
      return { mode: 'api', message: 'Reply confirmed.' };
    });
    mount({ onExecuteReply });
    type('Hello there');
    await send();
    expect(alertText()).toBe('Sending status unknown — check the conversation before resending.');
    await send();
    expect(seen[0]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(seen[1]).toBe(seen[0]);
  });

  it('CONTROL: an ordinary executor error is shown verbatim (not converted to unknown)', async () => {
    const onExecuteReply = jest.fn(async () => { throw new Error('ai_draft not found'); });
    mount({ onExecuteReply });
    type('Hello there');
    await send();
    expect(alertText()).toBe('ai_draft not found');
  });
});
