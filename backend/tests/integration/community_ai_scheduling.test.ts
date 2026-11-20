/**
 * Community-AI scheduling is RETIRED (owner ruling 2026-11-20; a9). The scheduler that would have executed a
 * scheduled action was never wired, so POST /api/community-ai/actions { status: 'scheduled' } promised a send that
 * never happened. It now answers 422 SCHEDULING_NOT_SUPPORTED and touches nothing. Tenant scoping still runs first,
 * and the endpoint itself is alive (status 'skipped' still works) - which is why 422 and not 410.
 */
import type { NextApiRequest } from 'next';
import fs from 'fs';
import path from 'path';
import actionsHandler from '../../../pages/api/community-ai/actions';
import {
  actionLogStore,
  actionStore,
  buildQuery,
  createMockRes,
  resetCommunityAiStores,
  seedPlaybook,
  setRole,
} from './communityAiTestHarness';

jest.mock('../../services/userContextService', () => ({
  enforceCompanyAccess: jest.fn().mockResolvedValue({
    userId: 'user-1',
    role: 'admin',
    companyIds: ['tenant-1'],
    defaultCompanyId: 'tenant-1',
  }),
  resolveUserContext: jest.fn().mockResolvedValue({
    userId: 'user-1',
    role: 'admin',
    companyIds: ['tenant-1'],
    defaultCompanyId: 'tenant-1',
  }),
}));

jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: jest.fn(), rpc: jest.fn() },
}));

const { supabase } = jest.requireMock('../../db/supabaseClient');

const action = (id: string, tenant: string) => ({
  id, tenant_id: tenant, organization_id: tenant, platform: 'linkedin', action_type: 'reply',
  target_id: `post-${id}`, suggested_text: 'Thanks!', status: 'pending', requires_human_approval: false,
});
const post = (body: Record<string, unknown>) =>
  ({ method: 'POST', body: { tenant_id: 'tenant-1', organization_id: 'tenant-1', ...body } } as unknown as NextApiRequest);

describe('Community-AI scheduling is retired', () => {
  beforeEach(() => {
    (supabase.from as jest.Mock).mockImplementation((table: string) => buildQuery(table));
    resetCommunityAiStores();
    seedPlaybook();
    setRole('CONTENT_REVIEWER');
  });

  it("status 'scheduled' -> 422 SCHEDULING_NOT_SUPPORTED; the row is untouched and no 'scheduled' event is logged", async () => {
    actionStore.set('action-10', action('action-10', 'tenant-1'));
    const res = createMockRes();
    await actionsHandler(post({ action_id: 'action-10', status: 'scheduled', scheduled_at: new Date(Date.now() + 60000).toISOString(), approved: true }), res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({ error: 'SCHEDULING_NOT_SUPPORTED' });
    const row = actionStore.get('action-10');
    expect(row.scheduled_at).toBeUndefined();
    expect(row.status).toBe('pending');
    expect(actionLogStore.some((log) => log.event_type === 'scheduled')).toBe(false);
  });

  it("tenant scoping still runs FIRST: a scheduling request for another tenant's action -> 403", async () => {
    actionStore.set('action-12', action('action-12', 'tenant-2'));
    const res = createMockRes();
    await actionsHandler(post({ action_id: 'action-12', status: 'scheduled', scheduled_at: new Date().toISOString(), approved: true }), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("CONTROL (why 422, not 410): the endpoint is alive - status 'skipped' still succeeds", async () => {
    actionStore.set('action-13', action('action-13', 'tenant-1'));
    const res = createMockRes();
    await actionsHandler(post({ action_id: 'action-13', status: 'skipped' }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(actionStore.get('action-13').status).toBe('skipped');
  });

  it('GET still REPORTS an existing approved+scheduled row (scheduled_actions, status approved) and never offers scheduling', async () => {
    actionStore.set('action-14', { ...action('action-14', 'tenant-1'), status: 'approved', scheduled_at: '2026-11-01T09:00:00.000Z' });
    const res = createMockRes();
    await actionsHandler({ method: 'GET', query: { tenant_id: 'tenant-1', organization_id: 'tenant-1' } } as unknown as NextApiRequest, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.scheduled_actions.map((a: { id?: string; action_id?: string }) => a.action_id ?? a.id)).toEqual(['action-14']);
    expect(body.scheduled_actions[0].status).toBe('approved');
    expect(body.permissions.canSchedule).toBe(false);
  });

  it('nothing in the repo can execute a scheduled action: the scheduler and its script are gone', () => {
    const root = path.resolve(__dirname, '../../..');
    expect(fs.existsSync(path.join(root, 'backend/services/communityAiScheduler.ts'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'scripts/communityAiScheduler.ts'))).toBe(false);
  });
});
