/**
 * Review B1 (2026-11-22): the REAL approve -> execute route must hand a "Message on LinkedIn" row to the executor with
 * its lead, sender and LinkedIn account, ALWAYS by browser (whatever the caller asks, including the UI's default
 * 'manual' simulation), with exactly the approved words, under its own idempotency key. The executor is a double that
 * records what it was given; the route's other collaborators are doubles too.
 */
type Row = Record<string, any>;

const ORG = 'org-1';
let actionRow: Row;
const executed: Array<{ action: Row; approved: boolean; options: Row }> = [];
const transitions: Row[] = [];
// What the route's READ returns, when it differs from the row the UPDATE meets (a change between read and write).
let readSnapshot: Row | null = null;
// The filters of each UPDATE, as written by the route ([op, column, value]); an UPDATE matches only if the row passes.
const updateFilters: Array<Array<[string, string, unknown]>> = [];

const supabaseDouble = {
  from: (_t: string) => {
    let patch: Row | null = null;
    const filters: Array<[string, string, unknown]> = [];
    const add = (op: string) => (k: string, v: unknown) => { if (patch) filters.push([op, k, v]); return q; };
    const passes = () => filters.every(([op, k, v]) =>
      op === 'eq' ? actionRow[k] === v : op === 'in' ? (v as unknown[]).includes(actionRow[k]) : (actionRow[k] ?? null) === v);
    const q: any = {
      select: () => q, eq: add('eq'), in: add('in'), is: add('is'),
      update: (p: Row) => { patch = p; transitions.push(p); updateFilters.push(filters); return q; },
      maybeSingle: async () => (patch && passes() ? { data: { ...actionRow, ...patch }, error: null } : { data: null, error: null }),
    };
    return q;
  },
};

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../db/supabaseClient', () => ({ supabase: supabaseDouble }));
jest.mock('../../db/communityAiActionStore', () => ({ getCommunityAiActionById: async () => ({ data: readSnapshot ?? actionRow, error: null }) }));
jest.mock('../../../pages/api/community-ai/utils', () => ({
  requireTenantScope: async () => ({ organizationId: ORG, tenantId: ORG }),
  enforceActionRole: async () => ({ userId: 'approver-1', role: 'COMPANY_ADMIN' }),
}));
jest.mock('../../services/communityAiActionExecutor', () => ({
  executeAction: async (action: Row, approved: boolean, options: Row) => { executed.push({ action, approved, options }); return { ok: true, status: 'dispatched', execution_mode: 'browser' }; },
}));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: async () => undefined }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: async () => undefined }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: async () => undefined }));
jest.mock('../../services/playbooks/playbookService', () => ({ getPlaybookById: async () => null }));
jest.mock('../../services/playbooks/playbookValidator', () => ({ validateActionAgainstPlaybook: () => ({ allowed: true }) }));

import route from '../../../pages/api/community-ai/actions/execute';

const MEMBER = 'ACoAAMEMEMEMEMEMEMEMEMEMEME01';
const newDmRow = (over: Row = {}): Row => ({
  id: 'act-1', tenant_id: ORG, organization_id: ORG, platform: 'linkedin', action_type: 'dm', status: 'approved',
  target_id: 'https://www.linkedin.com/in/alice-example/', suggested_text: 'Hello Alice', requires_human_approval: true,
  requires_approval: true, approved_at: '2026-11-22T10:00:00Z', execution_mode: null, risk_level: 'medium',
  acting_user_id: 'user-1', dm_lead_id: 'lead-1', dm_sender_member_id: MEMBER, ...over,
});

async function execute(body: Row) {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  await (route as any)({ method: 'POST', headers: {}, query: {}, body: { organization_id: ORG, tenant_id: ORG, action_id: 'act-1', approved: true, ...body } }, res);
  return res;
}

beforeEach(() => { readSnapshot = null; executed.length = 0; transitions.length = 0; updateFilters.length = 0; actionRow = newDmRow(); jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());

describe('execute route: an approved "Message on LinkedIn" request', () => {
  it.each([[{}], [{ execution_mode: 'manual' }], [{ execution_mode: 'api' }], [{ execution_mode: 'rpa' }]])(
    'is executed by BROWSER with its lead, sender and account, whatever the caller asked (%p)', async (asked) => {
      const res = await execute(asked);
      expect(res.statusCode).toBeLessThan(300);
      expect(executed).toHaveLength(1);
      expect(executed[0].action).toMatchObject({
        execution_mode: 'browser', acting_user_id: 'user-1', dm_lead_id: 'lead-1', dm_sender_member_id: MEMBER,
        suggested_text: 'Hello Alice', target_id: 'https://www.linkedin.com/in/alice-example/',
      });
      expect(executed[0].options.idempotency_key).toBe('newdm:act-1');
      expect(transitions[0]).toMatchObject({ execution_mode: 'browser', idempotency_key: 'newdm:act-1' });
    });

  it('a changed text is refused: the words sent from the requester\'s account are the approved ones', async () => {
    const res = await execute({ final_text: 'Something else entirely' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'NEW_DM_TEXT_CHANGE_NOT_ALLOWED' });
    expect(executed).toHaveLength(0);
  });

  it('CONTROL: the same text passed back explicitly is accepted', async () => {
    expect((await execute({ final_text: 'Hello Alice' })).statusCode).toBeLessThan(300);
    expect(executed).toHaveLength(1);
  });

  it('review 3 N-a: an already QUEUED new DM (pending with approved_at) is never executed again', async () => {
    actionRow = newDmRow({ status: 'pending' });
    const res = await execute({});
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('NEW_DM_ALREADY_QUEUED');
    expect(executed).toHaveLength(0);
    expect(transitions).toHaveLength(0);
  });

  it('review 3 N-a: a CLAIMED new DM is never executed again', async () => {
    actionRow = newDmRow({ dispatch_lease_id: 'lease-1' });
    expect((await execute({})).body.error).toBe('NEW_DM_ALREADY_QUEUED');
    expect(executed).toHaveLength(0);
  });

  it('review 3 N-a: claimed between the route\'s read and its update -> the transition matches nothing, nothing executes', async () => {
    readSnapshot = newDmRow();                                  // the route reads an approved, unclaimed row ...
    actionRow = newDmRow({ dispatch_lease_id: 'lease-race' });  // ... but by the update an extension has claimed it
    const res = await execute({});
    expect(updateFilters[0]).toEqual(expect.arrayContaining([['eq', 'status', 'approved'], ['is', 'dispatch_lease_id', null]]));
    expect(executed).toHaveLength(0);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('CONTROL for the race: the same read/update pair with the row still unclaimed executes once', async () => {
    readSnapshot = newDmRow();
    actionRow = newDmRow();
    expect((await execute({})).statusCode).toBeLessThan(300);
    expect(executed).toHaveLength(1);
  });

  it('CONTROL: an ordinary action keeps the caller\'s mode and key behaviour (manual default, no newdm key)', async () => {
    actionRow = newDmRow({ dm_lead_id: null, dm_sender_member_id: null, action_type: 'reply', target_id: 'post-1', suggested_text: 'Thanks' });
    await execute({});
    expect(executed[0].action.execution_mode).toBe('manual');
    expect(executed[0].options.idempotency_key).toBeUndefined();
    // and its transition keeps the ordinary status set (no new-DM narrowing)
    expect(updateFilters[0]).toEqual(expect.arrayContaining([['in', 'status', ['pending', 'approved', 'scheduled']]]));
  });
});
