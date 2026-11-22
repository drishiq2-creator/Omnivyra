/**
 * Review 3 (2026-11-22) N-a / F1: once a "Message on LinkedIn" row is approved and queued for its Sales Navigator
 * extension it is stored as 'pending' WITH approved_at. From then on:
 *   - approving it again is a no-op (a second approval would move it out of the extension's queue under a running send);
 *   - it is never scheduled (the scheduler cannot run a new DM - it would fail it);
 *   - it can be skipped only while no extension has claimed it (a claimed one may be on its way out of the browser).
 * Each refusal has a CONTROL showing the same request still works for an ordinary action / an unclaimed new DM.
 */
type Row = Record<string, any>;

const ORG = 'org-1';
let row: Row;
const updates: Array<{ patch: Row; filters: Array<[string, string, unknown]>; matched: boolean }> = [];

const supabaseDouble = {
  from: (_t: string) => {
    let patch: Row | null = null;
    const filters: Array<[string, string, unknown]> = [];
    const add = (op: string) => (k: string, v: unknown) => { if (patch) filters.push([op, k, v]); return q; };
    const passes = () => filters.every(([op, k, v]) =>
      op === 'eq' ? row[k] === v : op === 'in' ? (v as unknown[]).includes(row[k]) : (row[k] ?? null) === v);
    const finish = () => {
      if (!patch) return { data: row, error: null };
      const matched = passes();
      updates.push({ patch, filters, matched });
      if (matched) row = { ...row, ...patch };
      return { data: matched ? row : null, error: null };
    };
    const q: any = {
      select: () => q, eq: add('eq'), in: add('in'), is: add('is'),
      update: (p: Row) => { patch = p; return q; },
      single: async () => finish(),
      maybeSingle: async () => finish(),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(finish()).then(ok, bad),
    };
    return q;
  },
};

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../db/supabaseClient', () => ({ supabase: supabaseDouble }));
jest.mock('../../db/communityAiActionStore', () => ({ getCommunityAiActionById: async () => ({ data: row, error: null }) }));
jest.mock('../../../pages/api/community-ai/utils', () => ({
  requireTenantScope: async () => ({ organizationId: ORG, tenantId: ORG }),
  enforceActionRole: async () => ({ userId: 'approver-1', role: 'COMPANY_ADMIN' }),
  resolveActionRole: async () => 'COMPANY_ADMIN',
}));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: async () => undefined }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAiBulk: async () => undefined }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: async () => undefined }));
jest.mock('../../services/telemetry/telemetryDispatcher', () => ({ trackEvent: () => undefined }));

import approveRoute from '../../../pages/api/community-ai/actions/approve';
import actionsRoute from '../../../pages/api/community-ai/actions';

const newDm = (over: Row = {}): Row => ({
  id: 'act-1', tenant_id: ORG, organization_id: ORG, platform: 'linkedin', action_type: 'dm', status: 'pending',
  requires_human_approval: true, approved_at: null, dispatch_lease_id: null,
  acting_user_id: 'user-1', dm_lead_id: 'lead-1', dm_sender_member_id: 'ACoAAMEMEMEMEMEMEMEMEMEMEME01', ...over,
});
const ordinary = (over: Row = {}): Row => newDm({ dm_lead_id: null, dm_sender_member_id: null, action_type: 'reply', ...over });

async function call(route: any, body: Row) {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  await route({ method: 'POST', headers: {}, query: {}, body: { organization_id: ORG, tenant_id: ORG, action_id: 'act-1', ...body } }, res);
  return res;
}

beforeEach(() => { updates.length = 0; jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());

describe('approve: a queued new DM is never approved again', () => {
  it('pending WITH approved_at (queued for the extension) -> 200 idempotent, the row is not written', async () => {
    row = newDm({ approved_at: '2026-11-22T10:00:00Z' });
    const res = await call(approveRoute, {});
    expect(res.statusCode).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(updates).toHaveLength(0);
    expect(row.status).toBe('pending');
  });

  it('CONTROL: a pending new DM not yet approved IS approved', async () => {
    row = newDm();
    const res = await call(approveRoute, {});
    expect(res.statusCode).toBe(200);
    expect(row.status).toBe('approved');
  });
});

describe('schedule: a new DM is never scheduled', () => {
  it('refused with NEW_DM_SCHEDULE_NOT_SUPPORTED, nothing written', async () => {
    row = newDm({ status: 'approved', approved_at: '2026-11-22T10:00:00Z' });
    const res = await call(actionsRoute, { status: 'scheduled', scheduled_at: '2026-11-23T10:00:00Z', approved: true });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('NEW_DM_SCHEDULE_NOT_SUPPORTED');
    expect(updates).toHaveLength(0);
  });

  it('CONTROL: an ordinary approved action is still scheduled', async () => {
    row = ordinary({ status: 'approved', approved_at: '2026-11-22T10:00:00Z' });
    const res = await call(actionsRoute, { status: 'scheduled', scheduled_at: '2026-11-23T10:00:00Z', approved: true });
    expect(res.statusCode).toBe(200);
    expect(updates[0].patch.scheduled_at).toBe('2026-11-23T10:00:00Z');
  });
});

describe('skip: a CLAIMED new DM is never skipped', () => {
  it('claimed by an extension -> 409 NEW_DM_IN_PROGRESS, the row stays open', async () => {
    row = newDm({ approved_at: '2026-11-22T10:00:00Z', dispatch_lease_id: 'lease-1' });
    const res = await call(actionsRoute, { status: 'skipped' });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('NEW_DM_IN_PROGRESS');
    expect(row.status).toBe('pending');
  });

  it('CONTROL: a queued but unclaimed new DM IS skipped (the user can still withdraw it)', async () => {
    row = newDm({ approved_at: '2026-11-22T10:00:00Z' });
    const res = await call(actionsRoute, { status: 'skipped' });
    expect(res.statusCode).toBe(200);
    expect(row.status).toBe('skipped');
  });

  it('CONTROL: an ordinary action is skipped as before', async () => {
    row = ordinary({ dispatch_lease_id: 'lease-1' });
    expect((await call(actionsRoute, { status: 'skipped' })).statusCode).toBe(200);
    expect(row.status).toBe('skipped');
  });
});
