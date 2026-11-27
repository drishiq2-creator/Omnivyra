/**
 * SEC91-W2B-5 (P3) — signing-secret-unavailable answers.
 *
 * Since SEC91-B1 the extension and RPA token issuers fail closed when no server-only
 * signing secret is configured (SigningSecretUnavailableError). The routes then answered
 * HTTP 500 with the error message, which names the environment variables to set
 * (`... (set EXTENSION_SESSION_SECRET or AUTH_SECRET)`) — configuration detail handed to
 * any authenticated caller (or, for /api/extension/redeem, any claim-code holder).
 *
 * NOW: 503 with the plain code `SIGNING_SECRET_UNAVAILABLE`; any other failure is a
 * generic 500 without the internal message. Production resolves AUTH_SECRET (it has no
 * EXTENSION_SESSION_SECRET / RPA_AUTH_SECRET), so the success path is unchanged (COMPAT).
 */
import { seed, invoke, CO_A, USER_A } from '../helpers/routeAuthHarness';

jest.mock('@/config', () => ({ config: { DEV_USER_ID: '', NODE_ENV: 'production' } }));
// Phase E: claim codes live in the shared handshake store (extension_claim_code_* rpc). The harness rpc answers
// { data: null } for every function, which the store reads as unavailable (503) - so those two functions get a
// minimal faithful fake here; every other rpc still goes to the harness.
jest.mock('../../db/supabaseClient', () => {
  const h = require('../helpers/routeAuthHarness');
  const claims = new Map<string, { u: string; o: string; redeemed: boolean }>();
  const rpc = async (fn: string, a: any) => {
    if (fn === 'extension_claim_code_issue') {
      claims.set(a.p_code_hash, { u: a.p_user_id, o: a.p_organization_id, redeemed: false });
      const now = Date.now();
      return { data: [{ issued_at: new Date(now).toISOString(), valid_until: new Date(now + a.p_ttl_seconds * 1000).toISOString() }], error: null };
    }
    if (fn === 'extension_claim_code_redeem') {
      const c = claims.get(a.p_code_hash);
      if (!c || c.redeemed) return { data: [], error: null };
      c.redeemed = true;
      return { data: [{ redeemed_user_id: c.u, redeemed_organization_id: c.o }], error: null };
    }
    return h.fakeSupabase.rpc(fn, a);
  };
  const supabase = { ...h.fakeSupabase, rpc };
  return { ...h.supabaseModule(), supabase, default: supabase };
});
jest.mock('../../db/writeOwner', () => require('../helpers/routeAuthHarness').writeOwnerModule());
jest.mock('../../services/supabaseAuthService', () => require('../helpers/routeAuthHarness').authModule());
jest.mock('../../security/IdentityResolver', () => require('../helpers/routeAuthHarness').identityModule());

/* eslint-disable @typescript-eslint/no-var-requires */
const route = (p: string) => require(`../../../pages/api/${p}`).default;
const { createClaimCode } = require('../../services/extensionClaimCodeService');
/* eslint-enable @typescript-eslint/no-var-requires */

const SECRET_ENVS = ['EXTENSION_SESSION_SECRET', 'RPA_AUTH_SECRET', 'AUTH_SECRET', 'NEXTAUTH_SECRET'];
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of SECRET_ENVS) saved[k] = process.env[k]; });
afterAll(() => { for (const k of SECRET_ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
beforeEach(() => {
  seed();
  for (const k of SECRET_ENVS) delete process.env[k];
});

const CASES: Array<{ name: string; path: string; method: string; body?: unknown; query?: Record<string, string> }> = [
  { name: 'extension/bootstrap', path: 'extension/bootstrap', method: 'POST', body: { organization_id: CO_A } },
  { name: 'extension/session', path: 'extension/session', method: 'GET', query: { organization_id: CO_A } },
];

const noEnvNames = (body: unknown) => {
  const s = JSON.stringify(body ?? '');
  for (const k of SECRET_ENVS) expect(s).not.toContain(k);
  expect(s).not.toMatch(/SECRET_UNAVAILABLE:|\(set /);
};

describe('SEC91-W2B-5 signing secret missing → 503 with a plain code, no env names', () => {
  it.each(CASES)('$name', async (c) => {
    const r = await invoke(route(c.path), { method: c.method, as: 'A', body: c.body, query: c.query });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: 'SIGNING_SECRET_UNAVAILABLE' });
    noEnvNames(r.body);
  });

  it('extension/redeem: a claim minted before the secret went away → 503, no env names', async () => {
    process.env.AUTH_SECRET = 'sec91-w2b-5-test-auth-secret';
    const claim = await createClaimCode(USER_A, CO_A); // a member: redeem reaches token issuance
    delete process.env.AUTH_SECRET;
    const r = await invoke(route('extension/redeem'), { method: 'POST', body: { claim_code: claim.code } });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ success: false, error: 'SIGNING_SECRET_UNAVAILABLE' });
    noEnvNames(r.body);
  });
});

describe('COMPAT: with AUTH_SECRET configured (production) the routes issue tokens as before', () => {
  beforeEach(() => { process.env.AUTH_SECRET = 'sec91-w2b-5-test-auth-secret'; });

  it('extension/bootstrap → 200 with a claim code', async () => {
    const r = await invoke(route('extension/bootstrap'), { method: 'POST', as: 'A', body: { organization_id: CO_A } });
    expect(r.status).toBe(200);
    expect(r.body.data.claim_code).toMatch(/^cc_/);
  });

  it('extension/redeem → 200 with a session token', async () => {
    const claim = await createClaimCode(USER_A, CO_A);
    const r = await invoke(route('extension/redeem'), { method: 'POST', body: { claim_code: claim.code } });
    expect(r.status).toBe(200);
    expect(typeof r.body.data.session_token).toBe('string');
  });

  it('extension/session → 200 with a session token', async () => {
    const r = await invoke(route('extension/session'), { method: 'GET', as: 'A', query: { organization_id: CO_A } });
    expect(r.status).toBe(200);
    expect(typeof r.body.data.sessionToken).toBe('string');
  });

  // rpa/auth/start no longer issues tokens: RPA logins are disabled (owner decision #17,
  // 2026-11-10; backend/tests/unit/rpaLoginBlock410.test.ts). It answers 410 before the
  // signing secret is consulted, so it left the 503 table above as well.
  it('rpa/auth/start → 410 RPA_DISABLED, no token (owner #17)', async () => {
    const r = await invoke(route('rpa/auth/start'), { method: 'POST', as: 'A', body: { organization_id: CO_A, platform: 'linkedin' } });
    expect(r.status).toBe(410);
    expect(r.body.session_token).toBeUndefined();
  });

  it('authorization is unchanged: anonymous extension/session → 401, no token', async () => {
    const r = await invoke(route('extension/session'), { method: 'GET', query: { organization_id: CO_A } });
    expect(r.status).toBe(401);
  });
});

// ── OD-6 (Phase 82) ── mechanical adoption of the harness-configuration detector.
//
// A refusal means the harness declined to MODEL a statement, so nothing ran.
// On a DENY path writeCalls() counts it, so the canonical zero-write assertion
// fails and the refusal surfaces. On a GRANT path it does not: a refused
// statement is indistinguishable from a real write to presence, payload and
// ordering assertions, and a route that catches the throw makes it silent.
//
// This is the established detector, already proven in three suites. Adopting it
// here fails the test instead of letting a swallowed refusal read as
// enforcement. It is additive: no existing hook, assertion or declaration is
// changed, and the helper is required lazily so no import statement is touched.
afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../helpers/routeAuthHarness').assertNoHarnessConfigurationError();
});
