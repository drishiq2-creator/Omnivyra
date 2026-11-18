/**
 * @jest-environment jsdom
 *
 * Pre-launch consent pass (b3, 2026-11-18): every control that SENDS, POSTS or SPENDS says so.
 * Behaviour changes are tested by rendering (B2 WhatsApp broadcast confirm + dedupe, B7 Execute
 * confirm); copy-only changes (C1-C6) are pinned by their exact text in the source, with the old
 * text asserted absent so it can't creep back.
 */
import React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next/head', () => ({ __esModule: true, default: () => null }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
jest.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: jest.fn(), isReady: true, pathname: '/' }) }));
jest.mock('../../../components/CompanyContext', () => ({
  useCompanyContext: () => ({ selectedCompanyId: 'c1', user: { userId: 'u1' }, isLoading: false }),
}));
jest.mock('../../../components/community-ai/CommunityAiLayout', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import BroadcastsPage, { broadcastConfirmText } from '../../../pages/whatsapp/broadcasts';
import CommunityActionsView, { EXECUTE_CONFIRM_TEXT, EXECUTE_TOOLTIP } from '../../../components/CommunityActionsView';

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let confirmSpy: jest.SpyInstance;
beforeEach(() => {
  confirmSpy = jest.spyOn(window, 'confirm');
});
afterEach(() => confirmSpy.mockRestore());

// ── B2: WhatsApp broadcast ───────────────────────────────────────────────────
describe('B2 WhatsApp "Send Broadcast": confirm the count and the charges; dedupe first', () => {
  it('confirm text', () => {
    expect(broadcastConfirmText(3, 0)).toBe('Send this message to 3 contacts now? It goes out straight away, and WhatsApp may charge per message.');
    expect(broadcastConfirmText(1, 2)).toBe('Send this message to 1 contact (2 duplicate numbers removed) now? It goes out straight away, and WhatsApp may charge per message.');
  });

  async function openFormWith(recipients: string) {
    const posts: Array<{ url: string; body: { contacts: Array<{ phone_number: string }> } }> = [];
    (global as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.startsWith('/api/social-accounts/status')) {
        return reply(200, { accounts: [{ platform_key: 'whatsapp', connected: true, expired: false, social_account_id: 'wa1', account_name: 'WA' }] });
      }
      if (url === '/api/whatsapp/broadcasts' && init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(init.body ?? '{}') });
        return reply(200, { id: 'b1' });
      }
      return reply(200, { broadcasts: [], templates: [], data: [] });
    });
    const { container } = render(<BroadcastsPage />);
    const newButton = await screen.findByRole('button', { name: /New Broadcast/ });
    await waitFor(() => expect(newButton).not.toBeDisabled());
    fireEvent.click(newButton);
    const textarea = container.querySelector('textarea[placeholder^="+14155552671"]') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: recipients } });
    return { form: container.querySelector('form') as HTMLFormElement, posts };
  }

  it('cancelling the confirm sends NOTHING', async () => {
    confirmSpy.mockReturnValue(false);
    const { form, posts } = await openFormWith('+14155552671\n+447911123456');
    fireEvent.submit(form);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy).toHaveBeenCalledWith(broadcastConfirmText(2, 0));
    expect(posts).toHaveLength(0);
  });

  it('confirming sends once, to the DEDUPED list, and the count shown matches what is sent', async () => {
    confirmSpy.mockReturnValue(true);
    const { form, posts } = await openFormWith('+14155552671\n+14155552671\n+447911123456');
    fireEvent.submit(form);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(confirmSpy).toHaveBeenCalledWith(broadcastConfirmText(2, 1));
    expect(posts[0].body.contacts.map((c) => c.phone_number)).toEqual(['+14155552671', '+447911123456']);
  });
});

// ── B7: Community AI "Execute" ───────────────────────────────────────────────
describe('B7 Community AI "Execute": says it posts publicly now, and confirms first', () => {
  function renderView(handleExecute: jest.Mock) {
    const action = {
      action_id: 'a1', status: 'pending', requires_human_approval: false, action_type: 'reply',
      risk_level: 'low', execution_mode: 'api', execution_modes_config: { api_allowed: true },
      suggested_text: 'hi', platform: 'linkedin', target_url: 'https://x', target_id: 't1',
    };
    const base: Record<string, unknown> = {
      actions: [action], filteredActions: [action], activeTab: 'Pending', errorMessage: '', isLoading: false,
      executingActionId: null, permissions: { canExecute: true, canApprove: false, canSchedule: false, canSkip: false },
      manualAction: null, platformViewAction: null, historyActionId: null, historyEvents: [], historyCache: {},
      historyLoading: false, historyError: null, riskFilter: 'all', scheduleDrafts: {}, selectedCompanyId: 'c1',
      buildPlaybookSnapshot: () => null, formatExecutionResult: () => '', formatIntent: () => '',
      normalizeStatus: (s: string) => s, handleExecute,
    };
    const d = new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
    render(<CommunityActionsView d={d as never} />);
    return screen.getByRole('button', { name: 'Execute' });
  }

  it('tooltip says it posts publicly now', () => {
    expect(renderView(jest.fn())).toHaveAttribute('title', EXECUTE_TOOLTIP);
    expect(EXECUTE_TOOLTIP).toBe('Posts this action publicly now');
  });
  it('cancel -> nothing executes; confirm -> executes once', () => {
    const handleExecute = jest.fn();
    const button = renderView(handleExecute);
    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(button);
    expect(confirmSpy).toHaveBeenCalledWith(EXECUTE_CONFIRM_TEXT);
    expect(handleExecute).not.toHaveBeenCalled();
    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(button);
    expect(handleExecute).toHaveBeenCalledTimes(1);
  });
});

// ── C1-C6: copy only ─────────────────────────────────────────────────────────
describe('C1-C6 copy says what the control does', () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
  it.each([
    ['C1 playbook auto-execute', 'components/community-ai/PlaybookEditor.tsx',
      'Send low-risk replies automatically: they post publicly without your review', 'Auto-execute low risk'],
    ['C2 auto-rule toggle', 'pages/community-ai/auto-rules.tsx',
      "rule.is_active ? 'On: runs automatically' : 'Off'", "rule.is_active ? 'Enabled' : 'Disabled'"],
    ['C2 auto-rules page line', 'pages/community-ai/auto-rules.tsx',
      'What they do is posted publicly, without your review.', null],
    ['C3 BOLT progress', 'hooks/useBoltStrategy.tsx', 'posts scheduled</span>', 'posts live</span>'],
    ['C4 repurpose & schedule', 'pages/campaign-daily-plan/[id].tsx',
      'Posts publish automatically at their scheduled times.', null],
    ['C5 schedule plan', 'components/campaign-ai/SchedulePlanConfirmModal.tsx',
      'They publish automatically at those times.', null],
    ['C6 autonomous optimization', 'components/governance/GovernanceAnalyticsCard.tsx',
      'may change this campaign’s length (number of weeks) by itself, without asking you first', 'Fully auditable and reversible'],
  ])('%s', (_n, file, now, old) => {
    const src = read(file as string);
    expect(src).toContain(now);
    if (old) expect(src).not.toContain(old);
  });
});
