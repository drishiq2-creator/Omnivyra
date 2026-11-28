/**
 * A platform-list read failure (PLATFORM_ACCOUNT_LOOKUP_FAILED) must never
 * render as "not connected": the engagement integrations route answers 500
 * (no cache headers) and the platform-health resolver rejects (its route
 * answers 500), instead of both silently listing zero platforms.
 * Controls: a successful read still answers 200 / resolves with the platform.
 */
import integrationsHandler from '../../../pages/api/engagement/integrations';
import platformHealthHandler from '../../../pages/api/engagement/platform-health';
import { createApiRequestMock, createMockRes } from '../utils';

jest.mock('../../db/supabaseClient', () => {
  const { createSupabaseMock } = require('../utils/createSupabaseMock');
  return { supabase: createSupabaseMock(() => ({ data: [], error: null })) };
});
jest.mock('../../services/supabaseAuthService', () => ({ getSupabaseUserFromRequest: jest.fn() }));
jest.mock('../../services/authResolver', () => ({ resolveAuthenticatedUser: jest.fn() }));
jest.mock('../../services/requestContext', () => ({ seedRequestContextFromRequest: jest.fn() }));
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: jest.fn(),
  enforceCompanyAccess: jest.fn(async () => ({ userId: 'user-1' })),
}));
jest.mock('../../services/platformTokenService', () => ({
  getPlatformsWithActiveSocialAccountsForOrg: jest.fn(),
  getPlatformsWithTokensForOrg: jest.fn(),
}));

import {
  getPlatformsWithActiveSocialAccountsForOrg,
  getPlatformsWithTokensForOrg,
} from '../../services/platformTokenService';
import { getPlatformHealth } from '../../services/platformHealth/platformHealthService';

const activeMock = getPlatformsWithActiveSocialAccountsForOrg as jest.Mock;
const tokenMock = getPlatformsWithTokensForOrg as jest.Mock;
const RAW = 'Could not read social_accounts while listing platforms: canceling statement due to statement timeout on relation social_accounts';
const lookupFailed = () => Object.assign(new Error(RAW), { name: 'PlatformAccountResolutionError', code: 'PLATFORM_ACCOUNT_LOOKUP_FAILED' });

const callIntegrations = async () => {
  const res = createMockRes();
  await integrationsHandler(createApiRequestMock({ query: { organization_id: 'company-a' } }), res);
  return res as any;
};

beforeEach(() => {
  activeMock.mockReset();
  tokenMock.mockReset();
});

describe('GET /api/engagement/integrations on a list read failure', () => {
  it('control: successful reads answer 200 with the platforms', async () => {
    tokenMock.mockResolvedValue(['linkedin']);
    activeMock.mockResolvedValue([]);
    const res = await callIntegrations();
    expect(res.statusCode).toBe(200);
    expect(res.body ?? res.jsonBody ?? (res.json as jest.Mock).mock.calls[0]?.[0]).toMatchObject({ platforms: ['linkedin'] });
  });

  it('token-list read failure answers 500, not 200 with []', async () => {
    tokenMock.mockRejectedValue(lookupFailed());
    activeMock.mockResolvedValue(['linkedin']);
    const res = await callIntegrations();
    expect(res.statusCode).toBe(500);
  });

  it('active-account-list read failure answers 500, not 200 with a partial list', async () => {
    tokenMock.mockResolvedValue(['linkedin']);
    activeMock.mockRejectedValue(lookupFailed());
    const res = await callIntegrations();
    expect(res.statusCode).toBe(500);
  });
});

describe('getPlatformHealth on a list read failure', () => {
  it('control: a successful read reports the platform', async () => {
    tokenMock.mockResolvedValue(['linkedin']);
    activeMock.mockResolvedValue(['linkedin']);
    const health = await getPlatformHealth('company-a');
    expect(health.map((h: any) => h.platform)).toContain('linkedin');
  });

  it('a read failure rejects instead of reporting zero platforms', async () => {
    tokenMock.mockRejectedValue(lookupFailed());
    activeMock.mockResolvedValue(['linkedin']);
    await expect(getPlatformHealth('company-a')).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_LOOKUP_FAILED' });
  });
});

describe('500 bodies carry a stable code, never the raw database message', () => {
  it('integrations: body is { error: PLATFORM_ACCOUNT_LOOKUP_FAILED }', async () => {
    tokenMock.mockRejectedValue(lookupFailed());
    activeMock.mockResolvedValue([]);
    const res = await callIntegrations();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'PLATFORM_ACCOUNT_LOOKUP_FAILED' });
    expect(JSON.stringify(res.body)).not.toContain('statement timeout');
  });

  it('platform-health: body is { error: PLATFORM_ACCOUNT_LOOKUP_FAILED }', async () => {
    tokenMock.mockRejectedValue(lookupFailed());
    activeMock.mockResolvedValue([]);
    const res = createMockRes() as any;
    await platformHealthHandler(createApiRequestMock({ query: { organization_id: 'company-a' } }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'PLATFORM_ACCOUNT_LOOKUP_FAILED' });
    expect(JSON.stringify(res.body)).not.toContain('statement timeout');
  });

  it('control: platform-health answers 200 when the reads succeed', async () => {
    tokenMock.mockResolvedValue(['linkedin']);
    activeMock.mockResolvedValue(['linkedin']);
    const res = createMockRes() as any;
    await platformHealthHandler(createApiRequestMock({ query: { organization_id: 'company-a' } }), res);
    expect(res.statusCode).toBe(200);
  });
});
