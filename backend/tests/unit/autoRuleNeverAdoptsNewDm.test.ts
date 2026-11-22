/**
 * Third review N-d: the auto-rule engine looks up an existing community_ai_actions row by
 * (org, platform, action_type, target_id) in ANY status and executes it with requires_human_approval:false.
 * A LinkedIn new DM (dm_lead_id set) shares that key with an AI-suggested LinkedIn dm to the same /in/ URL,
 * so without a filter the engine would adopt the new DM and send it without approval and without its sender
 * binding. The CONTROL proves this test reaches execution at all.
 */

type Row = Record<string, any>;
const rows: Row[] = [];
let failActionReads = false;   // final review #2: a failed read of community_ai_actions

function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let inserted: Row | null = null;
  const result = () => {
    if (inserted) return { data: [inserted], error: null };
    if (name !== 'community_ai_actions') return { data: [], error: null };
    if (failActionReads) return { data: null, error: { code: '42703', message: 'column does not exist' } };
    return { data: rows.filter((r) => filters.every((f) => f(r))), error: null };
  };
  const chain: any = {
    select: () => chain,
    order: () => chain,
    limit: () => chain,
    gte: () => chain,
    lt: () => chain,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return chain; },
    is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return chain; },
    in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return chain; },
    insert: (row: Row) => { inserted = { ...row }; if (name === 'community_ai_actions') rows.push(inserted); return chain; },
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
  };
  return chain;
}

jest.mock('../../db/writeOwner', () => ({ ownedDbTable: jest.fn((t: string) => table(t)) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: jest.fn((t: string) => table(t)) } }));

const PLAYBOOK = { id: 'pb-1', name: 'PB', status: 'active', execution_modes: { browser: true } };
jest.mock('../../services/communityAiPlatformPolicyService', () => ({
  getCommunityAiPlatformPolicy: jest.fn(async () => ({
    execution_enabled: true, auto_rules_enabled: true, require_human_approval: false,
  })),
}));
jest.mock('../../services/playbooks/playbookService', () => ({
  listPlaybooks: jest.fn(async () => [PLAYBOOK]),
  getPlaybookById: jest.fn(async () => PLAYBOOK),
}));
jest.mock('../../services/playbooks/playbookEvaluator', () => ({
  evaluatePlaybookForEvent: jest.fn(() => ({
    primary_playbook: PLAYBOOK, decision: { execution_mode: 'browser', tone: { style: 'warm' } },
  })),
}));
jest.mock('../../services/playbooks/playbookValidator', () => ({
  validateActionAgainstPlaybook: jest.fn(() => ({ allowed: true })),
}));
jest.mock('../../services/executionGuardrailService', () => ({
  canExecuteAction: jest.fn(async () => ({ allowed: true })),
}));
jest.mock('../../services/communityAiActionExecutor', () => ({
  executeAction: jest.fn(async () => ({ ok: true, status: 'executed' })),
  persistExecutionResult: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../../services/communityAiActionLogService', () => ({
  logCommunityAiActionEvent: jest.fn(async () => undefined),
}));

import { evaluateAutoRules } from '../../services/communityAiAutoRuleService';
import { executeAction } from '../../services/communityAiActionExecutor';

const PROFILE = 'https://www.linkedin.com/in/alice-example/';
const RULE_ROWS = [{
  id: 'rule-1', tenant_id: 'org-1', organization_id: 'org-1', rule_name: 'dm', condition: { platform: 'linkedin' },
  action_type: 'dm', max_risk_level: 'medium', is_active: true,
}];

function seed(extra: Row) {
  rows.length = 0;
  rows.push({
    id: 'existing-1', tenant_id: 'org-1', organization_id: 'org-1', platform: 'linkedin', action_type: 'dm',
    target_id: PROFILE, suggested_text: 'Approved text', status: 'approved', playbook_id: 'pb-1',
    execution_mode: 'browser', risk_level: 'low', dm_lead_id: null, ...extra,
  });
}

async function run() {
  const { ownedDbTable } = jest.requireMock('../../db/writeOwner');
  (ownedDbTable as jest.Mock).mockImplementation((t: string) => {
    if (t === 'community_ai_auto_rules') {
      const c: any = { select: () => c, eq: () => c, then: (ok: any) => Promise.resolve({ data: RULE_ROWS, error: null }).then(ok) };
      return c;
    }
    return table(t);
  });
  return evaluateAutoRules({
    tenant_id: 'org-1', organization_id: 'org-1', platform: 'linkedin', autoExecute: true,
    suggested_actions: [{
      platform: 'linkedin', action_type: 'dm', target_id: PROFILE, suggested_text: 'Hello from AI',
      risk_level: 'low', requires_human_approval: false, intent_scores: { x: 1 },
    }],
  });
}

describe('auto rules never adopt a LinkedIn new DM (third review N-d)', () => {
  beforeEach(() => { (executeAction as jest.Mock).mockClear(); failActionReads = false; });

  it('final review #2: a FAILED lookup is never "no record" - nothing is inserted and nothing is executed', async () => {
    seed({ dm_lead_id: null });
    failActionReads = true;
    await run();
    expect(executeAction).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);   // no second record for the same action
  });

  it('CONTROL: an ordinary existing row with the same key IS auto-executed (the test reaches execution)', async () => {
    seed({ dm_lead_id: null });
    await run();
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect((executeAction as jest.Mock).mock.calls[0][0].id).toBe('existing-1');
  });

  it('an approved new DM with the same key is never executed by auto rules', async () => {
    seed({ dm_lead_id: 'lead-1', dm_sender_member_id: 'ACoAAA', acting_user_id: 'user-1' });
    await run();
    const executedIds = (executeAction as jest.Mock).mock.calls.map((c) => c[0].id);
    expect(executedIds).not.toContain('existing-1');
  });

  it('a pending (unapproved) new DM with the same key is never executed by auto rules', async () => {
    seed({ status: 'pending', dm_lead_id: 'lead-1', dm_sender_member_id: 'ACoAAA', acting_user_id: 'user-1' });
    await run();
    const executedIds = (executeAction as jest.Mock).mock.calls.map((c) => c[0].id);
    expect(executedIds).not.toContain('existing-1');
  });
});

describe("owner 2026-11-22: auto rules never put a 'blocked' action back into execution", () => {
  beforeEach(() => { (executeAction as jest.Mock).mockClear(); failActionReads = false; });

  it('an existing BLOCKED action with the same key is not executed (the CONTROL above shows the same row approved is)', async () => {
    seed({ status: 'blocked', dm_lead_id: null });
    await run();
    expect((executeAction as jest.Mock).mock.calls.map((c) => c[0].id)).not.toContain('existing-1');
  });
});
