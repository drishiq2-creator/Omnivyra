import type { NextApiRequest } from 'next';
import executeHandler from '../../../pages/api/community-ai/actions/execute';
import webhooksHandler from '../../../pages/api/community-ai/webhooks';
import { executeAction as executeCommunityAction } from '../../services/communityAiActionExecutor';
import { executeAction as executeLinkedinAction } from '../../services/platformConnectors/linkedinConnector';
import { sendCommunityAiWebhooks } from '../../services/communityAiWebhookService';
import {
  actionStore,
  buildQuery,
  createMockRes,
  resetCommunityAiStores,
  seedPlaybook,
  setRole,
  tokenStore,
  webhookStore,
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

jest.mock('../../services/platformConnectors/linkedinConnector', () => ({
  executeAction: jest.fn().mockResolvedValue({ ok: true, platform: 'linkedin' }),
}));

// PL-31: webhook delivery goes through the SSRF-safe fetcher (HARDEN-005), not global.fetch - record the URLs it is
// asked to deliver to. Asserting on global.fetch made the positive test unpassable and the isolation test vacuous.
const delivered: string[] = [];
jest.mock('../../../lib/security/safeFetch', () => ({
  safeFetch: jest.fn(async (url: string) => { delivered.push(url); return { ok: true, status: 200 }; }),
}));

// SCOPE (7c): these cases prove webhook ISOLATION, which lives entirely in sendCommunityAiWebhooks' four .eq filters and
// is shared by all three of its callers (ActionExecutorContracts, ActionExecutorRuntime, Scheduler). "An action
// failure emits a webhook" is a PER-CALL-SITE property: only the RPA path is exercised here; the API path is not
// terminal (API -> browser fallback) and the other call sites are NOT covered by these cases.
// A TERMINAL failure is needed for the 'failed' webhook: an API failure now falls back once to browser dispatch, which
// is in-flight and emits no webhook (communityAiActionExecutorRuntime: API -> Browser fallback; terminal events only).
// RPA mode with a failing RPA task is the deterministic terminal-failure path through the same emitWebhook.
const rpaTasks: any[] = [];
jest.mock('../../services/rpaWorker/rpaWorkerService', () => ({
  executeRpaTask: jest.fn(async (task: any) => { rpaTasks.push(task); return { success: false, error: 'boom' }; }),
}));

const { supabase } = jest.requireMock('../../db/supabaseClient');

describe('Community-AI Webhooks', () => {
  beforeEach(() => {
    (supabase.from as jest.Mock).mockImplementation((table: string) => buildQuery(table));
    resetCommunityAiStores();
    delivered.length = 0;
    rpaTasks.length = 0;
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    (global as any).fetch = undefined;
  });

  it('creates webhook per tenant', async () => {
    setRole('COMPANY_ADMIN');
    const req = {
      method: 'POST',
      body: {
        tenant_id: 'tenant-1',
        organization_id: 'tenant-1',
        event_type: 'failed',
        webhook_url: 'https://example.com/webhook',
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();
    await webhooksHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('enforces RBAC for webhook management', async () => {
    setRole('VIEW_ONLY');
    const req = {
      method: 'POST',
      body: {
        tenant_id: 'tenant-1',
        organization_id: 'tenant-1',
        event_type: 'failed',
        webhook_url: 'https://example.com/webhook',
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();
    await webhooksHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('viewer can read webhooks', async () => {
    setRole('VIEW_ONLY');
    webhookStore.push({
      id: 'hook-1',
      tenant_id: 'tenant-1',
      organization_id: 'tenant-1',
      event_type: 'failed',
      webhook_url: 'https://example.com/webhook',
      is_active: true,
      created_at: new Date().toISOString(),
    });
    const req = {
      method: 'GET',
      query: { tenant_id: 'tenant-1', organization_id: 'tenant-1' },
    } as unknown as NextApiRequest;
    const res = createMockRes();
    await webhooksHandler(req, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.webhooks).toHaveLength(1);
  });

  it('calls webhook on action failure', async () => {
    seedPlaybook({ execution_modes: { rpa_allowed: true } }); // the playbook must permit the RPA path under test
    tokenStore.push({
      tenant_id: 'tenant-1',
      organization_id: 'tenant-1',
      platform: 'linkedin',
      access_token: 'token-1',
    });
    webhookStore.push({
      tenant_id: 'tenant-1',
      organization_id: 'tenant-1',
      event_type: 'failed',
      webhook_url: 'https://example.com/webhook',
      is_active: true,
    });
    (executeLinkedinAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'boom' });
    actionStore.set('webhook-1', {
      id: 'webhook-1',
      tenant_id: 'tenant-1',
      organization_id: 'tenant-1',
      platform: 'linkedin',
      action_type: 'reply',
      target_id: 'post-1',
      suggested_text: 'Thanks!',
      playbook_id: 'playbook-1',
      execution_mode: 'rpa',
      status: 'approved',
      requires_human_approval: false,
    });
    await executeCommunityAction(actionStore.get('webhook-1'), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rpaTasks).toHaveLength(1);                             // the action really executed and failed (terminal)
    expect(delivered).toEqual(['https://example.com/webhook']);   // the tenant's own webhook was delivered
  });

  it('does not call cross-tenant webhooks', async () => {
    setRole('CONTENT_PUBLISHER');
    seedPlaybook({ execution_modes: { rpa_allowed: true } }); // the playbook must permit the RPA path under test
    tokenStore.push({
      tenant_id: 'tenant-1',
      organization_id: 'tenant-1',
      platform: 'linkedin',
      access_token: 'token-1',
    });
    webhookStore.push({
      tenant_id: 'tenant-2',
      organization_id: 'tenant-2',
      event_type: 'failed',
      webhook_url: 'https://example.com/tenant-2-hook',
      is_active: true,
    });
    // Positive leg in the SAME run: tenant-1's own hook must fire, which proves the flow reached webhook dispatch -
    // so "tenant-2 never delivered" below is a real isolation result, not a run that stopped early.
    webhookStore.push({
      tenant_id: 'tenant-1',
      organization_id: 'tenant-1',
      event_type: 'failed',
      webhook_url: 'https://example.com/tenant-1-hook',
      is_active: true,
    });
    (executeLinkedinAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'boom' });
    actionStore.set('webhook-2', {
      id: 'webhook-2',
      tenant_id: 'tenant-1',
      organization_id: 'tenant-1',
      platform: 'linkedin',
      action_type: 'reply',
      target_id: 'post-2',
      suggested_text: 'Thanks!',
      playbook_id: 'playbook-1',
      execution_mode: 'rpa',
      status: 'approved',
      requires_human_approval: false,
    });
    const req = {
      method: 'POST',
      headers: {},
      body: {
        tenant_id: 'tenant-1',
        organization_id: 'tenant-1',
        action_id: 'webhook-2',
        approved: true,
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();
    await executeHandler(req, res);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(delivered).toContain('https://example.com/tenant-1-hook');    // dispatch was reached
    expect(delivered).not.toContain('https://example.com/tenant-2-hook'); // another tenant's hook never is
  });

  it('an action with NO tenant reaches no tenant webhook (eq(null) matches nothing, as in PostgREST)', async () => {
    webhookStore.push({
      tenant_id: 'tenant-2',
      organization_id: 'tenant-2',
      event_type: 'failed',
      webhook_url: 'https://example.com/tenant-2-hook',
      is_active: true,
    });
    await sendCommunityAiWebhooks({ tenant_id: undefined as any, organization_id: undefined as any, event_type: 'failed', message: 'm' });
    expect(delivered).toEqual([]);
  });
});
