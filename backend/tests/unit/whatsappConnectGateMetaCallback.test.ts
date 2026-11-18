/**
 * Launch gate (b3, 11-18), connect side: the community-AI Meta OAuth callback is the ONLY place on main
 * that connects WhatsApp (it saves the Meta token for facebook, instagram AND whatsapp). While
 * WHATSAPP_CONNECT_ENABLED is not exactly 'true', the WhatsApp token is NOT saved; Facebook and
 * Instagram connect exactly as before. Driven through the REAL callback with the route-auth harness
 * (the same mocks sec91BSecretLogRedaction uses), and a successful token exchange.
 * All values are fake fixtures.
 */
export {};
import { seed, invoke, USER_A } from '../helpers/routeAuthHarness';

jest.mock('@/config', () => ({ config: { DEV_USER_ID: '', NODE_ENV: 'production', OAUTH_STATE_HMAC_KEY: 'wa-gate-test-hmac-key' } }));
jest.mock('../../db/supabaseClient', () => require('../helpers/routeAuthHarness').supabaseModule());
jest.mock('../../db/writeOwner', () => require('../helpers/routeAuthHarness').writeOwnerModule());
jest.mock('../../services/supabaseAuthService', () => require('../helpers/routeAuthHarness').authModule());
jest.mock('../../security/IdentityResolver', () => require('../helpers/routeAuthHarness').identityModule());
jest.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
jest.mock('../../../lib/supabase/publishableKey', () => ({ requireSupabasePublishableKey: () => 'fake-publishable' }));
jest.mock('../../auth/oauthCredentialResolver', () => ({
  getOAuthCredentialsForPlatform: jest.fn(async () => ({ client_id: 'fake-client-id', client_secret: 'fake-client-secret', source: 'test' })),
}));
jest.mock('../../auth/getBaseUrl', () => ({ getBaseUrl: () => 'http://localhost:3000' }));
jest.mock('../../auth/getCanonicalOAuthRedirectUri', () => ({
  getCanonicalOAuthRedirectUri: (p: string) => `http://localhost:3000/api/auth/${p}/callback`,
}));
jest.mock('../../auth/oauthTelemetry', () => ({ logOAuthEvent: jest.fn(), safeHost: () => 'localhost' }));
jest.mock('../../auth/tokenStore', () => ({
  getToken: jest.fn(async () => null),
  setToken: jest.fn(async () => undefined),
  markSocialAccountNeedsReauth: jest.fn(async () => undefined),
  encryptTokenColumns: () => ({ access_token: 'enc', refresh_token: null }),
  dualWriteSocialAccount: jest.fn(async () => undefined),
}));
jest.mock('../../auth/refreshLock', () => ({ withRefreshLock: async (_k: string, fn: () => unknown) => fn() }));
jest.mock('../../auth/oauthScopePersistence', () => ({
  normaliseScopes: () => [], persistGrantedScopes: jest.fn(async () => undefined), persistGrantedScopesByPlatformUser: jest.fn(async () => undefined),
}));
jest.mock('../../services/earnCreditsService', () => ({ checkAndGrantSetupCredits: jest.fn(async () => undefined) }));
const mockSaveToken = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('../../services/platformTokenService', () => ({ saveToken: (...a: unknown[]) => mockSaveToken(...a) }));
jest.mock('../../services/metaDerivedAccountsService', () => ({
  syncInstagramAndThreadsFromMeta: jest.fn(async () => ({ instagramAccounts: [], threadsAccounts: [] })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { encodeOAuthState } = require('../../auth/oauthState');
const ORG = '11111111-1111-4111-8111-11111111111a';
const PRIOR = process.env.WHATSAPP_CONNECT_ENABLED;
const setFlag = (v: string | undefined) => {
  if (v === undefined) delete process.env.WHATSAPP_CONNECT_ENABLED;
  else process.env.WHATSAPP_CONNECT_ENABLED = v;
};
afterAll(() => setFlag(PRIOR));

beforeEach(() => {
  mockSaveToken.mockClear();
  seed({
    companies: [{ id: ORG, status: 'active', name: 'Org' }],
    user_company_roles: [{ user_id: USER_A, company_id: ORG, role: 'COMPANY_ADMIN', status: 'active' }],
  });
  // A successful token exchange, then a successful /me read.
  (global as any).fetch = jest.fn(async (url: string) => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => (String(url).includes('/oauth/access_token')
      ? { access_token: 'fake-user-token', expires_in: 3600, scope: 'pages_show_list' }
      : { id: 'meta-user-1', name: 'Meta User' }),
    text: async () => '{}',
  }));
});

async function connect() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const handler = require('../../../pages/api/community-ai/connectors/meta/callback').default;
  const state = encodeOAuthState({ companyId: ORG, tenantId: ORG, userId: USER_A, flow: 'community-ai' });
  await invoke(handler, { method: 'GET', as: 'A', query: { code: 'auth-code', state } });
  return mockSaveToken.mock.calls.map((c) => c[2]).sort();
}

describe('Meta connect: the WhatsApp token is saved only when WhatsApp is enabled', () => {
  it('OFF (unset): facebook and instagram are saved, whatsapp is NOT', async () => {
    setFlag(undefined);
    expect(await connect()).toEqual(['facebook', 'instagram']);
  });

  it("OFF ('TRUE', not exactly 'true'): whatsapp is NOT saved", async () => {
    setFlag('TRUE');
    expect(await connect()).toEqual(['facebook', 'instagram']);
  });

  it("ON ('true'): whatsapp is saved too (the pre-gate behaviour)", async () => {
    setFlag('true');
    expect(await connect()).toEqual(['facebook', 'instagram', 'whatsapp']);
  });
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../helpers/routeAuthHarness').assertNoHarnessConfigurationError();
});
