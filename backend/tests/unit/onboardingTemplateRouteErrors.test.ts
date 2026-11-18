/**
 * POST /api/active-leads/enterprise-onboarding error mapping (2026-11-18, a9 review of the cross-tenant write fix):
 *  - a template the caller's organization does not own -> uniform 404 onboarding_template_not_found (a probe cannot
 *    tell "exists elsewhere" from "never existed");
 *  - any other failure -> 500 carrying ONLY the stable code before the first ':'; PostgREST detail is never echoed.
 */
import type { NextApiRequest, NextApiResponse } from 'next';

let mockUpsert: jest.Mock;
jest.mock('../../services/userContextService', () => ({
  enforceCompanyAccess: jest.fn(async () => ({ userId: 'user-a', companyId: 'c0a00000-0000-4000-8000-00000000000a' })),
}));
jest.mock('../../services/rbacService', () => ({ getUserRole: jest.fn(async () => ({ role: 'COMPANY_ADMIN', error: null })) }));
jest.mock('../../services/rbac/communityAiCapabilities', () => ({ hasCommunityAiCapability: () => true }));
jest.mock('../../services/enterpriseOnboardingService', () => {
  const actual = jest.requireActual('../../services/enterpriseOnboardingService');
  return {
    ...actual,
    upsertOnboardingTemplate: (...a: unknown[]) => mockUpsert(...a),
  };
});

import handler from '../../../pages/api/active-leads/enterprise-onboarding';
import { OnboardingTemplateNotFoundError } from '../../services/enterpriseOnboardingService';

function call(body: Record<string, unknown>) {
  const res: any = {
    statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string>, headersSent: false,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; this.headersSent = true; return this; },
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return this.headers[k.toLowerCase()]; },
    end() { this.headersSent = true; return this; },
  };
  const req = { method: 'POST', body, query: {}, headers: {}, url: '/api/active-leads/enterprise-onboarding' } as unknown as NextApiRequest;
  return Promise.resolve(handler(req, res as NextApiResponse)).then(() => res);
}
const upsertBody = { companyId: 'c0a00000-0000-4000-8000-00000000000a', action: 'upsert_template', templateKind: 'industry_preset', name: 'n', id: 'tpl-b-shared' };

describe('enterprise-onboarding POST: error mapping never leaks internals', () => {
  it("another tenant's / a platform template id -> 404 onboarding_template_not_found (uniform)", async () => {
    mockUpsert = jest.fn(async () => { throw new OnboardingTemplateNotFoundError(); });
    const r = await call(upsertBody);
    expect(mockUpsert).toHaveBeenCalledTimes(1); // the route reached the service (not refused earlier)
    expect(r.statusCode).toBe(404);
    expect(r.body).toEqual({ ok: false, error: 'onboarding_template_not_found' });
  });

  it('a DB failure -> 500 with only the stable code; the PostgREST detail is not echoed', async () => {
    mockUpsert = jest.fn(async () => { throw new Error('onboarding_template_update_failed:JSON object requested, multiple (or no) rows returned'); });
    const r = await call(upsertBody);
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ ok: false, error: 'onboarding_template_update_failed' });
    expect(JSON.stringify(r.body)).not.toMatch(/JSON object|rows returned/);
  });

  it('a non-code message -> the generic onboarding_action_failed', async () => {
    mockUpsert = jest.fn(async () => { throw new Error('connection reset by peer at 10.0.0.1'); });
    const r = await call(upsertBody);
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ ok: false, error: 'onboarding_action_failed' });
  });

  it('CONTROL: a validation code with no detail still reaches the client unchanged', async () => {
    mockUpsert = jest.fn(async () => { throw new Error('onboarding_template_name_required'); });
    const r = await call(upsertBody);
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ ok: false, error: 'onboarding_template_name_required' });
  });
});
