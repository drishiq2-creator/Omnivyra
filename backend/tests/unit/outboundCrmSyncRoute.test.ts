/**
 * Round 12 (Agent A): /api/website-intelligence/outbound-crm-sync route.
 *
 * Auth helpers and the service are mocked; no network, DB or credentials.
 * FAILING CONTROL: OUTBOUND_CRM_ROUTE may point at the 2bc52db7a copy of the
 * route; [fix] tests must fail there, [pin] tests pass on both.
 */
import type { NextApiRequest, NextApiResponse } from 'next';

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

const ORG_A = '0eda0896-7814-4613-8b49-4a8f408e45f1';
const ORG_B = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const USER = '11111111-2222-4333-8444-555555555555';

// The caller is a COMPANY_ADMIN of ORG_A only (mirrors assertTenantAccess binding company_id to membership).
const mockEnforceCompanyAccess = jest.fn(async ({ res, companyId }: any) => {
  if (companyId !== ORG_A) { res.status(403).json({ error: 'Access denied to company' }); return null; }
  return { userId: USER, role: 'user', companyIds: [ORG_A], defaultCompanyId: ORG_A };
});
jest.mock('../../services/userContextService', () => ({
  enforceCompanyAccess: (...a: unknown[]) => (mockEnforceCompanyAccess as any)(...a),
}));
const mockEnforceRole = jest.fn(async ({ res, companyId }: any) => {
  if (companyId !== ORG_A) { res.status(403).json({ error: 'COMPANY_SCOPE_VIOLATION' }); return null; }
  return { userId: USER, role: 'COMPANY_ADMIN' };
});
jest.mock('../../services/rbacService', () => ({
  Role: { COMPANY_ADMIN: 'COMPANY_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' },
  enforceRole: (...a: unknown[]) => (mockEnforceRole as any)(...a),
}));
const mockSyncToCrm = jest.fn();
const mockBuildReport = jest.fn();
jest.mock('../../services/intelligence/outboundCrmSyncService', () => ({
  syncToCrm: (...a: unknown[]) => mockSyncToCrm(...a),
  buildOutboundCrmReport: (...a: unknown[]) => mockBuildReport(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const route = require(process.env.OUTBOUND_CRM_ROUTE || '../../../pages/api/website-intelligence/outbound-crm-sync').default;

function call(method: string, body: Record<string, unknown> = {}, query: Record<string, string> = {}) {
  const out: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status: (c: number) => { out.status = c; return res; },
    json: (b: unknown) => { out.body = b; return res; },
  };
  return Promise.resolve(route({ method, body, query, headers: {} } as unknown as NextApiRequest, res as NextApiResponse)).then(() => out);
}
const post = (over: Record<string, unknown> = {}) =>
  call('POST', { company_id: ORG_A, provider: 'webhook_only', lead_id: 'lead-1', event: 'create', payload: { email: 'a@example.test' }, ...over });

beforeEach(() => {
  mockSyncToCrm.mockReset();
  mockBuildReport.mockReset();
  mockSyncToCrm.mockResolvedValue({ status: 'synced', detail: 'ok', dedupeKey: 'k' });
});

describe('tenant isolation', () => {
  it('[pin] control: the own-company scenario EXISTS and reaches the service', async () => {
    const r = await post();
    expect(r.status).toBe(200);
    expect(mockSyncToCrm).toHaveBeenCalledTimes(1);
    expect(mockSyncToCrm.mock.calls[0][0].companyId).toBe(ORG_A);
  });

  it('[pin] another company\'s id: 403 and the service is never called', async () => {
    const r = await post({ company_id: ORG_B });
    expect(r.status).toBe(403);
    expect(mockSyncToCrm).not.toHaveBeenCalled();
  });

  it('[pin] GET for another company: 403, no report built', async () => {
    const r = await call('GET', {}, { company_id: ORG_B });
    expect(r.status).toBe(403);
    expect(mockBuildReport).not.toHaveBeenCalled();
  });
});

describe('POST contract', () => {
  it('[fix] the acting user id is passed to the service for audit', async () => {
    await post();
    expect(mockSyncToCrm.mock.calls[0][0].actor).toEqual({ userId: USER });
  });

  it('[fix] credential / destination overrides in the body are rejected (400), service not called', async () => {
    for (const extra of [{ credentials: { accessToken: 't' } }, { webhook_url: 'https://x.example.test' }, { instance_url: 'https://x.example.test' }]) {
      const r = await post(extra);
      expect(r.status).toBe(400);
    }
    expect(mockSyncToCrm).not.toHaveBeenCalled();
  });

  it('[fix] status mapping: unknown -> 409 (never a 5xx "try again"), refused -> 422', async () => {
    mockSyncToCrm.mockResolvedValueOnce({ status: 'unknown', detail: 'x', dedupeKey: 'k', retryable: false });
    expect((await post()).status).toBe(409);
    mockSyncToCrm.mockResolvedValueOnce({ status: 'refused', detail: 'x', dedupeKey: 'k', retryable: false });
    expect((await post()).status).toBe(422);
  });

  it('[pin] status mapping: synced/deduped 200, not_configured 503, failed 500', async () => {
    const codes: number[] = [];
    for (const status of ['synced', 'deduped', 'not_configured', 'failed']) {
      mockSyncToCrm.mockResolvedValueOnce({ status, detail: 'x', dedupeKey: 'k' });
      codes.push((await post()).status);
    }
    expect(codes).toEqual([200, 200, 503, 500]);
  });

  it('[fix] internal error text is not returned to the client', async () => {
    mockSyncToCrm.mockRejectedValueOnce(new Error('internal-detail-xyz'));
    const r = await post();
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('internal-detail-xyz');
    mockBuildReport.mockRejectedValueOnce(new Error('internal-detail-xyz'));
    const g = await call('GET', {}, { company_id: ORG_A });
    expect(g.status).toBe(500);
    expect(JSON.stringify(g.body)).not.toContain('internal-detail-xyz');
  });
});
