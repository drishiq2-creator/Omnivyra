/**
 * @jest-environment jsdom
 */
/**
 * E3 review follow-up 3 — client_reply_key reaches POST /api/engagement/reply
 * from every reply surface and is reused on a retry of the same reply:
 *   - ReplyComposer → hooks/useReply (the main inbox path),
 *   - pages/engagement-inbox.tsx,
 *   - pages/whatsapp/inbox.tsx.
 * Every "same key" assertion first proves the key is a real string; each is
 * paired with a control where the key MUST change (edited reply / after success).
 */
import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

jest.mock('../../../components/ChatVoiceButton', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/engagementTelemetry', () => ({ recordEngagementEvent: jest.fn(async () => undefined) }));
jest.mock('@/components/CompanyContext', () => ({ useCompanyContext: () => ({ selectedCompanyId: 'org1' }) }));
jest.mock('@/components/ui/PlatformIcon', () => ({ __esModule: true, default: () => null }));
jest.mock('next/head', () => ({ __esModule: true, default: () => null }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
jest.mock('@/components/engagement/inbox/helpers', () => ({
  cancelUnclaimedQueuedAction: jest.fn(async () => undefined),
  waitForBrowserActionTerminalStatus: jest.fn(async () => null),
}));

import { ReplyComposer } from '../../../components/engagement/ReplyComposer';
import { useReply } from '../../../hooks/useReply';
import EngagementInboxPage from '../../../pages/engagement-inbox';
import WhatsAppInboxPage from '../../../pages/whatsapp/inbox';

type Answer = { status: number; body: unknown } | 'network-error';
const replyAnswers: Array<Answer | 'lost-response'> = [];
const replyBodies: Array<Record<string, any>> = [];
/** Server double: a logical reply executes once per (message_id, client_reply_key, text) — the E3 identity. */
const executedIdentities = new Set<string>();
let waMessages: Array<Record<string, unknown>> = [];
const OK = { status: 200, body: { success: true, status: 'executed', confirmed: true, platform_id: 'p1' } };

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => { if (body === '__not_json__') throw new SyntaxError('Unexpected token <'); return body; } } as unknown as Response;
}

beforeEach(() => {
  replyAnswers.length = 0;
  replyBodies.length = 0;
  executedIdentities.clear();
  waMessages = [{ id: 'in1', thread_id: 'wt1', platform_message_id: 'wamid.1', direction: 'inbound', content: 'Hi', created_at: '2026-11-27T10:00:00Z' }];
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.startsWith('/api/engagement/reply')) {
      const b = JSON.parse(String(init?.body ?? '{}'));
      replyBodies.push(b);
      const a = replyAnswers.shift() ?? OK;
      if (a === 'network-error') throw new TypeError('Failed to fetch');
      executedIdentities.add(JSON.stringify([b.message_id ?? b.signal_id, b.client_reply_key ?? null, b.reply_text]));
      if (a === 'lost-response') throw new TypeError('Failed to fetch'); // executed, response lost
      return respond(a.status, a.body);
    }
    if (u.startsWith('/api/engagement/campaign-signals')) {
      return respond(200, { signals: [{ id: 'sig1', campaign_id: 'c1', activity_id: 'a1', platform: 'linkedin', author: 'Ana', content: 'Great post', signal_type: 'comment', engagement_score: 0.5, detected_at: '2026-11-27T10:00:00Z' }] });
    }
    if (u.startsWith('/api/engagement/threads')) {
      return respond(200, { threads: [{ id: 'wt1', platform: 'whatsapp', platform_thread_id: 'WA-THREAD-1', created_at: '2026-11-27T10:00:00Z', updated_at: '2026-11-27T10:00:00Z', window_open: true, window_expires_at: null }] });
    }
    if (u.startsWith('/api/engagement/messages')) {
      return respond(200, { messages: waMessages });
    }
    return respond(200, {});
  });
});

const keyAt = (i: number) => replyBodies[i]?.client_reply_key;
const expectRealKey = (k: unknown) => { expect(typeof k).toBe('string'); expect(String(k)).toMatch(/^[A-Za-z0-9_-]{16,128}$/); };

// ─────────────────────────────────────────────────────────────────────────────
describe('ReplyComposer → useReply (main inbox path)', () => {
  const deps = {
    organizationId: 'org1',
    getBrowserPlatformState: () => ({ browserEnabled: true }),
    hideThreadAfterResponse: () => undefined,
    bootstrapExtensionAuth: async () => undefined,
    pollExtensionCommandsNow: async () => ({}),
    refresh: () => undefined,
    refreshMessages: () => undefined,
    refreshCounts: () => undefined,
    refreshWorkQueue: () => undefined,
  };
  function Wired() {
    const { executeReply } = useReply(deps);
    return <ReplyComposer threadId="t1" messageId="m1" platform="linkedin" organizationId="org1" messageType="comment" onExecuteReply={executeReply} />;
  }
  const type = (t: string) => fireEvent.change(screen.getByPlaceholderText('Write a reply...'), { target: { value: t } });
  const send = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^send$/i })); }); };

  it('the composer key reaches the request body and a retry after a network error reuses it', async () => {
    render(<Wired />);
    type('Thanks!');
    replyAnswers.push('network-error');
    await send();
    expect(screen.getByRole('alert').textContent).toMatch(/^Sending status unknown/);
    await send();
    expectRealKey(keyAt(0));
    expect(keyAt(1)).toBe(keyAt(0));
  });

  it('CONTROL: an edited reply sends a different key', async () => {
    render(<Wired />);
    type('Thanks!');
    replyAnswers.push('network-error');
    await send();
    type('Thanks a lot!');
    await send();
    expectRealKey(keyAt(0));
    expectRealKey(keyAt(1));
    expect(keyAt(1)).not.toBe(keyAt(0));
  });

  it('useReply sends no client_reply_key when none is given (server-derived fallback stays)', async () => {
    const { result } = renderHook(() => useReply(deps));
    await act(async () => { await result.current.executeReply({ threadId: 't1', messageId: 'm1', platform: 'linkedin', replyText: 'x', messageType: 'comment' }); });
    expect(replyBodies[0]).not.toHaveProperty('client_reply_key');
  });
});

describe('pages/engagement-inbox.tsx', () => {
  async function openSignal() {
    render(<EngagementInboxPage />);
    await waitFor(() => expect(screen.getByText('Great post')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText('Great post')); });
  }
  const type = (t: string) => fireEvent.change(screen.getByPlaceholderText('Type your reply...'), { target: { value: t } });
  const send = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: /send reply/i })); }); };

  it('sends client_reply_key and reuses it on a retry after a network error', async () => {
    await openSignal();
    type('Happy to help');
    replyAnswers.push('network-error');
    await send();
    await send();
    expectRealKey(keyAt(0));
    expect(keyAt(1)).toBe(keyAt(0));
  });

  it('CONTROL: after a successful send, the same words are a new reply (new key); an edit is a new key', async () => {
    await openSignal();
    type('Happy to help');
    await send(); // success → key reset
    type('Happy to help');
    replyAnswers.push('network-error');
    await send();
    type('Happy to help!');
    await send();
    expectRealKey(keyAt(0));
    expect(keyAt(1)).not.toBe(keyAt(0));
    expect(keyAt(2)).not.toBe(keyAt(1));
  });
});

describe('pages/whatsapp/inbox.tsx', () => {
  async function openThread() {
    render(<WhatsAppInboxPage />);
    await waitFor(() => expect(screen.getAllByText('WA-THREAD-1').length).toBeGreaterThan(0));
    await act(async () => { fireEvent.click(screen.getAllByText('WA-THREAD-1')[0]); });
    await waitFor(() => expect(screen.getByPlaceholderText(/Type a reply/)).toBeTruthy());
    await act(async () => { await Promise.resolve(); });
  }
  const box = () => screen.getByPlaceholderText(/Type a reply/);
  const type = (t: string) => fireEvent.change(box(), { target: { value: t } });
  const send = async () => { await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); }); };

  it('sends client_reply_key and reuses it on a retry after a network error', async () => {
    await openThread();
    type('On my way');
    replyAnswers.push('network-error');
    await send();
    await send();
    expectRealKey(keyAt(0));
    expect(keyAt(1)).toBe(keyAt(0));
    expect(replyBodies[0].message_id).toBe('in1');
  });

  it('CONTROL: an edited reply sends a different key', async () => {
    await openThread();
    type('On my way');
    replyAnswers.push('network-error');
    await send();
    type('On my way now');
    await send();
    expectRealKey(keyAt(0));
    expect(keyAt(1)).not.toBe(keyAt(0));
  });
});

const UNKNOWN_COPY = 'Sending status unknown — check the conversation before resending.';
const UNKNOWN_409 = { status: 409, body: { success: false, code: 'REPLY_OUTCOME_UNKNOWN', outcome: 'unknown', retryable: false, error: 'Sending status unknown — this reply may already have reached the platform. Check the conversation before resending; it was not sent again.' } };
const REFUSAL_400 = { status: 400, body: { error: 'Reply is not supported on this account.', code: 'ACTION_NOT_SUPPORTED' } };

describe('E3 LOW-1 whatsapp: the client key survives a new inbound message', () => {
  async function openThread() {
    await act(async () => { fireEvent.click(screen.getAllByText('WA-THREAD-1')[0]); });
    await waitFor(() => expect(screen.getByPlaceholderText(/Type a reply/)).toBeTruthy());
    await act(async () => { await Promise.resolve(); });
  }
  const box = () => screen.getByPlaceholderText(/Type a reply/);
  const type = (t: string) => fireEvent.change(box(), { target: { value: t } });
  const send = async () => { await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); }); };
  const newInboundArrives = () => {
    waMessages = [...waMessages, { id: 'in2', thread_id: 'wt1', platform_message_id: 'wamid.2', direction: 'inbound', content: 'Hello?', created_at: '2026-11-27T10:05:00Z' }];
  };
  async function mountWa() {
    render(<WhatsAppInboxPage />);
    await waitFor(() => expect(screen.getAllByText('WA-THREAD-1').length).toBeGreaterThan(0));
  }

  it('lost response, a new inbound arrives (conversation reloaded), retry of the same reply → same key, same target, one execution', async () => {
    await mountWa();
    await openThread();
    type('On my way');
    replyAnswers.push('lost-response');
    await send();
    newInboundArrives();
    await openThread(); // the reload shows in2 as the latest inbound; the draft box is cleared
    await waitFor(() => expect(screen.getByText('Hello?')).toBeTruthy());
    type('On my way');
    await send();
    expectRealKey(keyAt(0));
    expect(keyAt(1)).toBe(keyAt(0));
    expect(replyBodies[0].message_id).toBe('in1');
    expect(replyBodies[1].message_id).toBe('in1');
    expect(executedIdentities.size).toBe(1);
  });

  it('CONTROL: after the new inbound, an edited reply is a new logical reply (new key, answers the latest inbound)', async () => {
    await mountWa();
    await openThread();
    type('On my way');
    replyAnswers.push('lost-response');
    await send();
    newInboundArrives();
    await openThread();
    await waitFor(() => expect(screen.getByText('Hello?')).toBeTruthy());
    type('On my way — 5 minutes');
    await send();
    expect(keyAt(1)).not.toBe(keyAt(0));
    expect(replyBodies[1].message_id).toBe('in2');
    expect(executedIdentities.size).toBe(2);
  });
});

describe('E3 LOW-2 inbox pages show the shared "status unknown" copy', () => {
  async function waOpen() {
    render(<WhatsAppInboxPage />);
    await waitFor(() => expect(screen.getAllByText('WA-THREAD-1').length).toBeGreaterThan(0));
    await act(async () => { fireEvent.click(screen.getAllByText('WA-THREAD-1')[0]); });
    await waitFor(() => expect(screen.getByPlaceholderText(/Type a reply/)).toBeTruthy());
    await act(async () => { await Promise.resolve(); });
    return {
      type: (t: string) => fireEvent.change(screen.getByPlaceholderText(/Type a reply/), { target: { value: t } }),
      send: async () => { await act(async () => { fireEvent.keyDown(screen.getByPlaceholderText(/Type a reply/), { key: 'Enter' }); }); },
    };
  }
  async function eiOpen() {
    render(<EngagementInboxPage />);
    await waitFor(() => expect(screen.getByText('Great post')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText('Great post')); });
    return {
      type: (t: string) => fireEvent.change(screen.getByPlaceholderText('Type your reply...'), { target: { value: t } }),
      send: async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: /send reply/i })); }); },
    };
  }
  const pages: Array<[string, () => Promise<{ type: (t: string) => void; send: () => Promise<void> }>]> = [
    ['whatsapp/inbox', waOpen],
    ['engagement-inbox', eiOpen],
  ];

  it.each(pages)('%s: a network error / timeout shows the shared unknown copy (not the raw "Failed to fetch")', async (_n, open) => {
    const ui = await open();
    ui.type('Hello');
    replyAnswers.push('network-error');
    await ui.send();
    expect(screen.getByText(UNKNOWN_COPY)).toBeTruthy();
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
  });

  it.each(pages)('%s: a gateway 504 without JSON is shown as status unknown', async (_n, open) => {
    const ui = await open();
    ui.type('Hello');
    replyAnswers.push({ status: 504, body: '__not_json__' });
    await ui.send();
    expect(screen.getByText(UNKNOWN_COPY)).toBeTruthy();
  });

  it.each(pages)('%s: an unknown-outcome code is shown as status unknown', async (_n, open) => {
    const ui = await open();
    ui.type('Hello');
    replyAnswers.push(UNKNOWN_409);
    await ui.send();
    expect(screen.getByText(/^Sending status unknown — this reply may already have reached the platform/)).toBeTruthy();
  });

  it.each(pages)('CONTROL %s: a 400 refusal keeps its explicit error', async (_n, open) => {
    const ui = await open();
    ui.type('Hello');
    replyAnswers.push(REFUSAL_400);
    await ui.send();
    expect(screen.getByText('Reply is not supported on this account.')).toBeTruthy();
    expect(screen.queryByText(/Sending status unknown/)).toBeNull();
  });
});
