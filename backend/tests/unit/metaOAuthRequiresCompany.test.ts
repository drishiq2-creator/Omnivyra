/**
 * b3 ruling (2026-11-19): a Meta (Facebook / Instagram) connection is ALWAYS for a company.
 * Before: with no company the legacy /api/auth/facebook and /api/auth/instagram flows minted a company-less state and
 * the callbacks stored Meta tokens in an untenanted social_accounts row (company_id NULL) that publishing never uses
 * (postSocialAccountResolver skips company_id NULL) - a dormant credential. Now:
 *   - start: no company -> 400 COMPANY_REQUIRED, no state minted (no redirect to Meta);
 *   - callback: a company-less state -> refused BEFORE the token exchange: no provider call, no write.
 * Each refusal has a positive leg (with a company the flow proceeds, unchanged), so a broken harness cannot pass.
 */
import { seed, invoke, writeCalls, USER_A } from '../helpers/routeAuthHarness';

export {};

jest.mock('@/config', () => ({
  config: { DEV_USER_ID: '', NODE_ENV: 'production', OAUTH_STATE_HMAC_KEY: 'meta-requires-company-test-key' },
}));
jest.mock('../../db/supabaseClient', () => require('../helpers/routeAuthHarness').supabaseModule());
jest.mock('../../db/writeOwner', () => require('../helpers/routeAuthHarness').writeOwnerModule());
jest.mock('../../services/supabaseAuthService', () => require('../helpers/routeAuthHarness').authModule());
jest.mock('../../security/IdentityResolver', () => require('../helpers/routeAuthHarness').identityModule());
jest.mock('../../auth/oauthCredentialResolver', () => ({
  getOAuthCredentialsForPlatform: jest.fn(async () => ({ client_id: 'cid', client_secret: 'csec', source: 'test' })),
}));
jest.mock('../../auth/getBaseUrl', () => ({ getBaseUrl: () => 'http://localhost:3000' }));
jest.mock('../../auth/oauthTelemetry', () => ({ logOAuthEvent: jest.fn(), safeHost: () => 'localhost' }));
jest.mock('../../auth/oauthScopePersistence', () => ({
  normaliseScopes: () => [],
  persistGrantedScopes: jest.fn(async () => undefined),
  persistGrantedScopesByPlatformUser: jest.fn(async () => undefined),
}));
jest.mock('../../services/earnCreditsService', () => ({ checkAndGrantSetupCredits: jest.fn(async () => undefined) }));
jest.mock('../../auth/tokenStore', () => ({
  setToken: jest.fn(async () => undefined),
  encryptTokenColumns: (t: { access_token: string }) => ({ access_token: `enc(${t.access_token})`, refresh_token: null }),
}));
jest.mock('../../services/metaDerivedAccountsService', () => ({
  ...jest.requireActual('../../services/metaDerivedAccountsService'),
  syncInstagramAndThreadsFromMeta: jest.fn(async () => ({ instagramAccounts: [], threadsAccounts: [] })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { encodeOAuthState } = require('../../auth/oauthState');
/* eslint-disable @typescript-eslint/no-var-requires */
const fbStart = require('../../../pages/api/auth/facebook/index').default;
const igStart = require('../../../pages/api/auth/instagram').default;
const fbCallback = require('../../../pages/api/auth/facebook/callback').default;
const igCallback = require('../../../pages/api/auth/instagram/callback').default;
/* eslint-enable @typescript-eslint/no-var-requires */

const CO_A = '11111111-1111-4111-8111-11111111111a';
const providerCalls: string[] = [];
const fetchMock = jest.fn(async (input: unknown) => {
  providerCalls.push(String(input));
  const body = String(input).includes('oauth/access_token')
    ? { access_token: 'user-token', expires_in: 5184000, scope: 'pages_show_list' }
    : { id: 'meta-user-1', name: 'Meta Person', data: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
});

beforeAll(() => { (global as any).fetch = fetchMock; });
beforeEach(() => {
  seed({
    companies: [{ id: CO_A, status: 'active', name: 'Company A' }],
    user_company_roles: [{ user_id: USER_A, company_id: CO_A, role: 'COMPANY_ADMIN', status: 'active' }],
  });
  providerCalls.length = 0;
  fetchMock.mockClear();
});

const tokenExchanges = () => providerCalls.filter((u) => u.includes('oauth/access_token'));
const socialWrites = () => writeCalls(['social_accounts', 'community_ai_platform_tokens']);

describe.each([
  ['facebook', fbStart],
  ['instagram', igStart],
])('start route /api/auth/%s', (_name, handler) => {
  it('NO company: 400 COMPANY_REQUIRED, nothing minted, no redirect to Meta', async () => {
    const r = await invoke(handler, { method: 'GET', as: 'A', query: { returnTo: '/social-platforms' } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Choose a company first', code: 'COMPANY_REQUIRED' });
    expect(r.redirect).toBeNull();
  });

  it('CONTROL: with a company the user belongs to, the flow redirects to Meta (unchanged)', async () => {
    const r = await invoke(handler, { method: 'GET', as: 'A', query: { companyId: CO_A, returnTo: '/social-platforms' } });
    expect(String(r.redirect)).toContain('https://www.facebook.com/v22.0/dialog/oauth?');
  });
});

describe.each([
  ['facebook', fbCallback],
  ['instagram', igCallback],
])('callback /api/auth/%s/callback', (_name, handler) => {
  const run = (companyId: string | undefined) => invoke(handler, {
    method: 'GET',
    as: 'A',
    query: { code: 'auth-code', state: encodeOAuthState({ companyId, userId: USER_A, returnTo: '/social-platforms' }) },
  });

  it('a company-less state is refused BEFORE the token exchange: no provider call, nothing written', async () => {
    const r = await run(undefined);
    expect(decodeURIComponent(String(r.redirect))).toContain('error=Choose a company first');
    expect(tokenExchanges()).toEqual([]);
    expect(socialWrites()).toEqual([]);
  });

  it('CONTROL: with a company the flow reaches the token exchange (unchanged)', async () => {
    await run(CO_A);
    expect(tokenExchanges().length).toBeGreaterThan(0);
  });
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../helpers/routeAuthHarness').assertNoHarnessConfigurationError();
});
