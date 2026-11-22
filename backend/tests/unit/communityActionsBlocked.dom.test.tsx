/**
 * @jest-environment jsdom
 *
 * Owner decision 2026-11-22: a plan-limit restriction is its own status, 'blocked', shown with its reason.
 * The actions view renders a blocked row with "Blocked: <reason>" and offers no execute / schedule / skip / approve
 * buttons for it. CONTROL: an ordinary pending row in the same view still gets its buttons.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../../components/community-ai/CommunityAiLayout', () => ({ __esModule: true, default: ({ children }: any) => <div>{children}</div> }));
jest.mock('../../../components/community-ai/SectionCard', () => ({ __esModule: true, default: ({ children }: any) => <section>{children}</section> }));
jest.mock('../../../components/CompanyContext', () => ({ useCompanyContext: () => ({ selectedCompanyId: 'org-1' }) }));
jest.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: jest.fn() }) }));

import CommunityActionsView from '../../../components/CommunityActionsView';
import { blockedReasonText } from '../../../lib/communityAi/blockedReason';

const base = {
  platform: 'linkedin', target_id: 'urn:li:share:1', risk_level: 'low', suggested_text: 'thanks', execution_mode: 'api',
  execution_modes_config: { manual_only: false, api_allowed: true, rpa_allowed: false }, requires_human_approval: false,
  requires_approval: false, playbook_name: 'PB', tone_used: 'professional',
};
const blockedRow = { ...base, action_id: 'blocked-1', action_type: 'reply', status: 'blocked',
  execution_result: { ok: false, status: 'blocked', error: { code: 'PLAN_LIMIT_EXCEEDED', limit: 100, used: 100 } } };
const pendingRow = { ...base, action_id: 'pending-1', action_type: 'like', status: 'pending', execution_result: null };

function viewProps(rows: any[], activeTab: string) {
  const fixture: Record<string, any> = {
    actions: rows, filteredActions: rows, activeTab, tabs: [],
    permissions: { canApprove: true, canExecute: true, canSchedule: true, canSkip: true, canManageConnectors: false },
    scheduleDrafts: {}, historyCache: {}, historyEvents: [], historyActionId: null, manualAction: null, platformViewAction: null,
    errorMessage: null, executingActionId: null, isLoading: false, statusFilter: null, riskFilter: null, tenantId: 'org-1',
    selectedCompanyId: 'org-1', router: { query: {} }, context: {},
    formatExecutionResult: (v: any) => (v ? JSON.stringify(v).slice(0, 40) : '-'), formatIntent: () => '-',
    buildPlaybookSnapshot: () => null, normalizeStatus: (a: any) => a.status, validatePlaybookReply: () => null,
  };
  return new Proxy(fixture, { get: (t, k: string) => (k in t ? t[k] : jest.fn()) }) as any;
}

describe("actions view: 'blocked' status and reason (owner 2026-11-22)", () => {
  it('shows the Blocked tab; a blocked row shows its reason and no action buttons', () => {
    render(<CommunityActionsView d={viewProps([blockedRow], 'Blocked')} />);
    expect(screen.getByRole('button', { name: 'Blocked' })).toBeInTheDocument();
    expect(screen.getByTestId('action-blocked-reason')).toHaveTextContent('Blocked: Plan limit reached - this action was not executed.');
    const row = screen.getByTestId('action-blocked-reason').closest('tr') as HTMLElement;
    for (const name of [/^Execute$/, /^Schedule$/, /^Skip$/, /^Approve/, /^Send$/]) {
      expect(within(row).queryByRole('button', { name })).toBeNull();
    }
  });

  it('CONTROL: an ordinary pending row (same view, same permissions) gets Execute and Skip', () => {
    render(<CommunityActionsView d={viewProps([pendingRow], 'Pending')} />);
    expect(screen.queryByTestId('action-blocked-reason')).toBeNull();
    expect(screen.getByRole('button', { name: /^Execute$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Skip$/ })).toBeInTheDocument();
  });
});

describe('blockedReasonText', () => {
  it.each([
    [{ error: { code: 'PLAN_LIMIT_EXCEEDED' } }, 'Plan limit reached - this action was not executed.'],
    [{ error: 'SOME_RULE' }, 'Blocked (SOME_RULE) - this action was not executed.'],
    [{ reason: 'OTHER' }, 'Blocked (OTHER) - this action was not executed.'],
    [null, 'Blocked - this action was not executed.'],
  ])('%p -> %p', (input, text) => { expect(blockedReasonText(input)).toBe(text); });
});

describe('review #6: the hook keeps blocked actions and reports a blocked Execute as blocked', () => {
  const { combineActionLists, executeErrorText } = jest.requireActual('../../../hooks/useCommunityActions');

  it('combineActionLists keeps the blocked list (CONTROL: and every other list)', () => {
    const merged = combineActionLists({
      pending_actions: [{ action_id: 'p', status: 'pending' }], scheduled_actions: [{ action_id: 's', status: 'approved' }],
      completed_actions: [{ action_id: 'c', status: 'executed' }], skipped_actions: [{ action_id: 'k', status: 'skipped' }],
      blocked_actions: [{ action_id: 'b', status: 'blocked' }],
    });
    expect(merged.map((a: any) => `${a.action_id}:${a.status}`)).toEqual(['p:pending', 's:approved', 'c:executed', 'k:skipped', 'b:blocked']);
  });

  it('executeErrorText: blocked -> "Blocked: <reason>"; CONTROL: other errors unchanged', () => {
    expect(executeErrorText({ status: 'blocked', execution: { error: { code: 'PLAN_LIMIT_EXCEEDED' } } }))
      .toBe('Blocked: Plan limit reached - this action was not executed.');
    expect(executeErrorText({ status: 'failed', error: 'CONNECTOR_ERROR' })).toBe('CONNECTOR_ERROR');
    expect(executeErrorText(null)).toBe('Execution failed');
  });
});
