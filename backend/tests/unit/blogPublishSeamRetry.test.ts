/**
 * e9 ruling 2026-11-14: POST /api/blogs/:id/publish runs executePublishingJob inline, whose claim first resolves the
 * job's tenant (resolveTenantOfRow). A FAILED tenant read throws a retryable TenantSeamError before the claim (the job
 * stays queued for the publishing worker). The route answers 503 + Retry-After without the seam detail - never the
 * generic 500 that echoed the error message.
 */
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../middleware/withIdempotency', () => ({ withIdempotency: (h: unknown) => h }));
jest.mock('../../services/userContextService', () => ({ enforceCompanyAccess: jest.fn(async () => ({ userId: 'u-1' })) }));
jest.mock('../../services/rbacService', () => ({
  enforceRole: jest.fn(async () => ({ role: 'COMPANY_ADMIN' })),
  Role: { COMPANY_ADMIN: 'COMPANY_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' },
}));
jest.mock('../../services/blogService', () => ({
  publishBlogPost: jest.fn(),
  getBlog: jest.fn(async () => ({ id: 'b-1' })),
}));

import { TenantSeamError } from '../../db/tenantTable';
import { publishBlogPost, getBlog } from '../../services/blogService';
/* eslint-disable @typescript-eslint/no-var-requires */
const handler = require('../../../pages/api/blogs/[id]/publish').default;
/* eslint-enable @typescript-eslint/no-var-requires */

function call() {
  const out: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const res: any = {
    status(code: number) { out.status = code; return res; },
    json(b: unknown) { out.body = b; return res; },
    setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = v; return res; },
  };
  return Promise.resolve(handler({ method: 'POST', query: { id: 'b-1', company_id: 'c-1' }, body: {}, headers: {} }, res)).then(() => out);
}

beforeEach(() => jest.clearAllMocks());

describe('POST /api/blogs/:id/publish - publishing job tenant unreadable', () => {
  it('retryable seam error -> 503 + Retry-After, no seam detail in the body', async () => {
    (publishBlogPost as jest.Mock).mockRejectedValueOnce(new TenantSeamError('TENANT_PARENT_UNREADABLE', 'publishing_jobs: row tenant unreadable (57014)'));
    const r = await call();
    expect(r.status).toBe(503);
    expect(r.headers['retry-after']).toBe('5');
    expect(JSON.stringify(r.body)).not.toMatch(/TENANT_PARENT_UNREADABLE|57014|publishing_jobs/);
    expect(getBlog).not.toHaveBeenCalled();
  });
  it('control: any other publish failure keeps the existing 500', async () => {
    (publishBlogPost as jest.Mock).mockRejectedValueOnce(new Error('A title is required before publishing'));
    const r = await call();
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ success: false, message: 'A title is required before publishing' });
  });
  it('control: a NON-retryable seam error keeps the existing 500', async () => {
    (publishBlogPost as jest.Mock).mockRejectedValueOnce(new TenantSeamError('TENANT_CONTEXT_MISSING', 'x'));
    expect((await call()).status).toBe(500);
  });
});
