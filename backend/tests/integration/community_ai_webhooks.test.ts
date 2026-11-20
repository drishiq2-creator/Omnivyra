import type { NextApiRequest } from 'next';
import executeHandler from '../../../pages/api/community-ai/actions/execute';
import webhooksHandler from '../../../pages/api/community-ai/webhooks';
import { executeAction as executeCommunityAction } from '../../services/communityAiActionExecutor';
import {
  actionStore,
  buildQuery,
  createMockRes,
  resetCommunityAiStores,
  seedConnectedAccount,
  seedPlaybook,
  setRole,
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

// Tokens live in social_accounts since the consolidation; read them from the harness store (same seam as
// community_ai_action_connectors.test.ts). Without a connected account the API path falls back to the browser
// (status 'dispatched') and the connector failure these tests exercise never happens.
jest.mock('../../auth/tokenStore', () => {
  const harness = jest.requireActual('./communityAiTestHarness');
  return {
    getToken: jest.fn(async (socialAccountId: string) => {
      const row = harness.socialAccountStore.find((r: any) => r.id === socialAccountId);
      return row ? { access_token: row.access_token, token_type: 'Bearer' } : null;
    }),
    isTokenExpiringSoon: jest.fn(() => false),
    setToken: jest.fn(async () => {}),
  };
});
jest.mock('../../auth/tokenRefresh', () => ({ refreshPlatformToken: jest.fn(async () => null) }));

// A TERMINAL failure is what emits the 'failed' webhook. A failed API send is NOT terminal: the executor falls back
// once to the browser (status 'dispatched', in flight), so these tests fail through RPA, which has no fallback.
jest.mock('../../services/rpaWorker/rpaWorkerService', () => ({
  executeRpaTask: jest.fn(async () => ({ success: false, error: 'boom' })),
}));

// Webhook delivery goes through the SSRF-safe fetcher (HARDEN-005, 41f134d3b), which uses undici - NOT global fetch.
// These tests used to assert on global.fetch and so could never observe a delivery (red on main since 2026-07-09).
// Record deliveries at the real egress seam instead: the URL and the payload actually posted.
const delivered: Array<{ url: string; body: any }> = [];
jest.mock('../../../lib/security/safeFetch', () => ({
  safeFetch: jest.fn(async (url: string, init: { body: string }) => {
    delivered.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  }),
}));

jest.mock('../../services/platformConnectors/linkedinConnector', () => ({
  executeAction: jest.fn().mockResolvedValue({ ok: true, platform: 'linkedin' }),
}));

const { supabase } = jest.requireMock('../../db/supabaseClient');

describe('Community-AI Webhooks', () => {
  beforeEach(() => {
    (supabase.from as jest.Mock).mockImplementation((table: string) => buildQuery(table));
    resetCommunityAiStores();
    delivered.length = 0;
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
    // The action names playbook-1; without it the executor stops at PLAYBOOK_NOT_FOUND before the connector runs.
    seedPlaybook({ execution_modes: { api_allowed: true, rpa_allowed: true, manual_only: false } });
    seedConnectedAccount({ platform: 'linkedin', accessToken: 'token-1' });
    webhookStore.push({
      tenant_id: 'tenant-1',
      organization_id: 'tenant-1',
      event_type: 'failed',
      webhook_url: 'https://example.com/webhook',
      is_active: true,
    });
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
    const result = await executeCommunityAction(actionStore.get('webhook-1'), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result).toMatchObject({ ok: false, status: 'failed' }); // the scenario IS a terminal failure
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    expect(delivered.every((d) => d.url === 'https://example.com/webhook')).toBe(true);
    expect(delivered[0].body).toMatchObject({ tenant_id: 'tenant-1', organization_id: 'tenant-1', event_type: 'failed', action_id: 'webhook-1' });
  });

  /** The route-level failed-action flow, with one hook registered for (hookTenant, hookOrg). Returns what was delivered. */
  async function failThroughExecuteRoute(hookTenant: string, hookOrg: string = hookTenant) {
    setRole('CONTENT_PUBLISHER');
    seedPlaybook({ execution_modes: { api_allowed: true, rpa_allowed: true, manual_only: false } });
    seedConnectedAccount({ platform: 'linkedin', accessToken: 'token-1' });
    webhookStore.push({
      tenant_id: hookTenant,
      organization_id: hookOrg,
      event_type: 'failed',
      webhook_url: `https://${hookTenant}.${hookOrg}.example.com/webhook`,
      is_active: true,
    });
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
      body: { tenant_id: 'tenant-1', organization_id: 'tenant-1', action_id: 'webhook-2', approved: true },
    } as unknown as NextApiRequest;
    const res = createMockRes();
    await executeHandler(req, res);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { res, delivered: [...delivered] };
  }

  it('CONTROL: the same failed action DOES deliver to its own tenant\'s hook (the scenario reaches delivery)', async () => {
    const { res, delivered: got } = await failThroughExecuteRoute('tenant-1');
    expect(res.json.mock.calls[0][0]).toMatchObject({ status: 'failed' }); // terminal failure through the route
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(got.every((d) => d.url === 'https://tenant-1.tenant-1.example.com/webhook' && d.body.tenant_id === 'tenant-1')).toBe(true);
  });

  // Title kept as main's (the T2 parity gate keys tests by title).
  it('does not call cross-tenant webhooks', async () => {
    const { res, delivered: got } = await failThroughExecuteRoute('tenant-2', 'tenant-2');
    expect(res.json.mock.calls[0][0]).toMatchObject({ status: 'failed' }); // same terminal failure as the control
    expect(got).toEqual([]);
  });

  it.each([
    ['same org, another tenant (tenant filter alone)', 'tenant-2', 'tenant-1'],
    ['same tenant, another org (org filter alone)', 'tenant-1', 'tenant-2'],
  ])('does not call a webhook whose scope differs in one field: %s', async (_n, hookTenant, hookOrg) => {
    const { res, delivered: got } = await failThroughExecuteRoute(hookTenant, hookOrg);
    expect(res.json.mock.calls[0][0]).toMatchObject({ status: 'failed' }); // same terminal failure as the control
    expect(got).toEqual([]);
  });
});
