/**
 * Phase E - the extension handshake end to end, driven by a SYNTHETIC CLIENT that signs exactly like the extension's
 * shared/requestSigner.js (WebCrypto, TextEncoder, the same canonical string) and builds bodies exactly like
 * background/serviceWorker.js redeemClaimCode and core/authBridge.js requestValidationViaBackground.
 *
 * TWO SERVER INSTANCES: the routes are loaded twice with jest.isolateModules (two module registries = two Vercel
 * instances: separate module state, separate globalThis-pinned caches are irrelevant because nothing is cached in
 * process any more). Both talk to ONE store - the fake Supabase below, whose rpc() implements the three
 * migration-20270314000010 functions with the same semantics (atomic single-use redeem, first-use nonce, database
 * clock). The SQL itself is proven on a real PostgreSQL 17 schema in
 * backend/tests/realschema/extension_handshake_store.test.ts.
 *
 * Requests are real Node streams with bodyParser off (the routes' config), so the raw-body capture path runs.
 * Every refusal is paired with a control that shows the scenario is reachable and accepted when the one refused
 * property is removed.
 */

process.env.EXTENSION_SESSION_SECRET = 'test-extension-session-secret-not-production';
delete process.env.DEV_EXTENSION_AUTH_BYPASS;

import { Readable } from 'stream';
import { webcrypto } from 'crypto';

type Claim = { user: string; org: string; createdAt: number; expiresAt: number; redeemedAt: number | null };
type RoleRow = { user_id: string; company_id: string; status: string; role: string };

// ---- the ONE shared store (both instances' supabase clients read and write it) -----------------------------------
const mockDb = {
  skewMs: 0,
  rpcDown: false,
  /** Fail only this rpc (the others answer): models a store error at one step. */
  failFn: null as string | null,
  /** user_company_roles reads answer a transport error (membership lookup outage). */
  rolesDown: false,
  claims: new Map<string, Claim>(),
  nonces: new Map<string, number>(),
  roles: [] as RoleRow[],
  companies: new Map<string, string>(),
  rpcCalls: [] as string[],
  now() { return Date.now() + this.skewMs; },
};

function mockFrom(table: string) {
  const preds: Array<(r: Record<string, unknown>) => boolean> = [];
  const rows = (): Record<string, unknown>[] => {
    if (table === 'user_company_roles') return mockDb.roles as unknown as Record<string, unknown>[];
    if (table === 'companies') return [...mockDb.companies.entries()].map(([id, status]) => ({ id, status }));
    throw new Error(`unexpected table ${table}`);
  };
  const q: any = {
    select: () => q,
    eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return q; },
    limit: () => q,
    maybeSingle: async () => {
      if (table === 'user_company_roles' && mockDb.rolesDown) return { data: null, error: { code: 'PGRST001', message: 'connection refused' } };
      const hit = rows().find((r) => preds.every((p) => p(r)));
      return { data: hit ? { ...hit } : null, error: null };
    },
  };
  return q;
}

async function mockRpc(fn: string, args: Record<string, any>) {
  mockDb.rpcCalls.push(fn);
  if (mockDb.rpcDown || mockDb.failFn === fn) return { data: null, error: { code: 'PGRST001', message: 'connection refused' } };
  const now = mockDb.now();
  if (fn === 'extension_claim_code_issue') {
    if (mockDb.claims.has(args.p_code_hash)) return { data: null, error: { code: '23505', message: 'duplicate' } };
    const c = { user: args.p_user_id, org: args.p_organization_id, createdAt: now, expiresAt: now + args.p_ttl_seconds * 1000, redeemedAt: null };
    mockDb.claims.set(args.p_code_hash, c);
    return { data: [{ issued_at: new Date(c.createdAt).toISOString(), valid_until: new Date(c.expiresAt).toISOString() }], error: null };
  }
  if (fn === 'extension_claim_code_peek') {
    const c = mockDb.claims.get(args.p_code_hash);
    if (!c || c.redeemedAt !== null || !(c.expiresAt > now)) return { data: [], error: null };
    return { data: [{ peek_user_id: c.user, peek_organization_id: c.org }], error: null };
  }
  if (fn === 'extension_claim_code_redeem') {
    const c = mockDb.claims.get(args.p_code_hash);
    if (!c || c.redeemedAt !== null || !(c.expiresAt > now)) return { data: [], error: null };
    c.redeemedAt = now;
    return { data: [{ redeemed_user_id: c.user, redeemed_organization_id: c.org }], error: null };
  }
  if (fn === 'extension_request_nonce_record') {
    const exp = mockDb.nonces.get(args.p_nonce_key);
    if (exp !== undefined && exp > now) return { data: false, error: null };
    mockDb.nonces.set(args.p_nonce_key, now + args.p_ttl_seconds * 1000);
    return { data: true, error: null };
  }
  return { data: null, error: { code: '42883', message: `function ${fn} does not exist` } };
}

jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: (f: string, a: any) => mockRpc(f, a) } }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
// The web app's cookie authentication is not under test: enforceCompanyAccess ADMITS the principal named by the
// test header, as the real one admits a platform super admin (TenantGuard bypass) or a member. The extension rule
// that runs AFTER it is real (extensionMembershipService -> TenantGuard -> the fake tables above).
jest.mock('../../services/userContextService', () => ({
  enforceCompanyAccess: async ({ req, res }: any) => {
    const userId = req.headers['x-test-web-user'];
    if (!userId) { res.status(401).json({ error: 'Authentication required. Please sign in again.', code: 'UNAUTHENTICATED' }); return null; }
    return { userId, authenticated: true };
  },
}));

type Routes = { bootstrap: any; redeem: any; validate: any; health: any };
function loadInstance(): Routes {
  let r: Routes | undefined;
  jest.isolateModules(() => {
    r = {
      bootstrap: require('../../../pages/api/extension/bootstrap').default,
      redeem: require('../../../pages/api/extension/redeem').default,
      validate: require('../../../pages/api/extension/validate').default,
      health: require('../../../pages/api/extension/health').default,
    };
  });
  return r as Routes;
}
const A = loadInstance();
const B = loadInstance();

// ---- the synthetic client: shared/requestSigner.js, reproduced line for line --------------------------------------
const subtle = webcrypto.subtle;
function toHex(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}
function randomNonceHex(lengthBytes = 16) {
  const arr = new Uint8Array(lengthBytes);
  webcrypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(str: string) {
  const enc = new TextEncoder().encode(str || '');
  return toHex(await subtle.digest('SHA-256', enc));
}
async function hmacSha256Hex(secret: string, message: string) {
  const enc = new TextEncoder();
  const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await subtle.sign('HMAC', key, enc.encode(message)));
}
async function buildSignedHeaders(secret: string, { method, path, body }: { method: string; path: string; body: string }, nonce = randomNonceHex()) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = await sha256Hex(body || '');
  const canonical = `${String(method || 'GET').toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = await hmacSha256Hex(secret, canonical);
  return { 'X-Omnivyra-Timestamp': timestamp, 'X-Omnivyra-Nonce': nonce, 'X-Omnivyra-Signature': signature };
}

// ---- HTTP plumbing: a real stream request (bodyParser is off in the routes' config) -------------------------------
type Res = { statusCode: number; body: any };
// bootstrap / redeem keep Next's default body parser (they are not request-signed): `nextParses` simulates it
// (stream consumed, req.body = the JSON parse). The signed routes get the raw stream (their config: bodyParser off).
async function call(handler: any, opts: { method: string; url: string; headers?: Record<string, string>; body?: string; nextParses?: boolean }): Promise<Res> {
  const buf = Buffer.from(opts.body ?? '', 'utf8');
  const req: any = opts.nextParses ? { body: buf.length ? JSON.parse(buf.toString('utf8')) : {} } : Readable.from(buf.length ? [buf] : []);
  const [pathname, qs] = opts.url.split('?');
  req.method = opts.method;
  req.url = opts.url;
  // Node lower-cases incoming header names
  req.headers = Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  req.query = Object.fromEntries(new URLSearchParams(qs ?? ''));
  void pathname;
  const res: any = { statusCode: 0, body: undefined, headers: {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: unknown) => { res.headers[k] = v; return res; };
  res.end = () => res;
  await handler(req, res);
  return res;
}

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000b2';
const MEMBER = '00000000-0000-4000-8000-00000000c001';
const SUPER_ADMIN_NO_ROLE = '00000000-0000-4000-8000-00000000c002';

// web app (hooks/useExtensionBridge.ts fetchClaimCode)
const bootstrap = (inst: Routes, user: string | null, org = ORG) => call(inst.bootstrap, {
  method: 'POST', url: '/api/extension/bootstrap', nextParses: true,
  headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-web-user': user } : {}) },
  body: JSON.stringify({ organization_id: org }),
});
// background/serviceWorker.js redeemClaimCode
const redeem = (inst: Routes, claimCode: string, product?: unknown) => call(inst.redeem, {
  method: 'POST', url: '/api/extension/redeem', nextParses: true,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ claim_code: claimCode, runtime_id: 'ext-runtime-id', ...(product !== undefined ? { product } : {}) }),
});

type Session = { token: string; secret: string; userId: string; orgId: string };
async function pair(product?: unknown, user = MEMBER, org = ORG): Promise<{ session: Session; redeemed: Res }> {
  const b = await bootstrap(A, user, org);
  expect(b.statusCode).toBe(200);
  const r = await redeem(B, b.body.data.claim_code, product); // the OTHER instance
  expect(r.statusCode).toBe(200);
  const d = r.body.data;
  return { session: { token: d.session_token, secret: d.hmac_secret, userId: d.user_id, orgId: d.org_id }, redeemed: r };
}

// core/authBridge.js requestValidationViaBackground: signed POST /api/extension/validate
async function validate(inst: Routes, s: Session, payload: Record<string, unknown> = { userId: s.userId, orgId: s.orgId, timestamp: new Date().toISOString() }, nonce?: string) {
  const path = '/api/extension/validate';
  const bodyString = JSON.stringify(payload || {});
  const signed = await buildSignedHeaders(s.secret, { method: 'POST', path, body: bodyString }, nonce);
  return call(inst.validate, {
    method: 'POST', url: path, body: bodyString,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}`, ...signed },
  });
}

const decodeToken = (t: string) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));

beforeEach(() => {
  mockDb.skewMs = 0;
  mockDb.rpcDown = false;
  mockDb.failFn = null;
  mockDb.rolesDown = false;
  mockDb.claims.clear();
  mockDb.nonces.clear();
  mockDb.rpcCalls.length = 0;
  mockDb.roles = [
    { user_id: MEMBER, company_id: ORG, status: 'active', role: 'COMPANY_ADMIN' },
    { user_id: MEMBER, company_id: OTHER_ORG, status: 'active', role: 'COMPANY_ADMIN' },
  ];
  mockDb.companies = new Map([[ORG, 'active'], [OTHER_ORG, 'active']]);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('cross-instance handshake: bootstrap (A) -> redeem (B) -> validate -> a signed GET', () => {
  it('the two instances are separate module registries sharing only the store', () => {
    expect(A.redeem).not.toBe(B.redeem);
    expect(A.bootstrap).not.toBe(B.bootstrap);
  });

  it('completes end to end with the exact client signing; the signed GET carries a query appended AFTER signing', async () => {
    const { session, redeemed } = await pair('salesnav');
    expect(redeemed.body.data).toMatchObject({ user_id: MEMBER, org_id: ORG, product: 'salesnav', sync_mode: 'batch' });
    expect(decodeToken(session.token).product).toBe('salesnav');

    const v = await validate(A, session);
    expect(v.statusCode).toBe(200);
    expect(v.body.data).toMatchObject({ valid: true, user_id: MEMBER, org_id: ORG });

    // serviceWorker.js signs `endpoint` (no query), then appends ?organization_id= for GETs.
    const path = '/api/extension/health';
    const signed = await buildSignedHeaders(session.secret, { method: 'GET', path, body: '' });
    const h = await call(B.health, {
      method: 'GET', url: `${path}?organization_id=${encodeURIComponent(ORG)}`,
      headers: { Authorization: `Bearer ${session.token}`, ...signed },
    });
    expect(h.statusCode).toBe(200);
  });

  // jest.isolateModules shares globalThis, and the OLD Map was pinned on globalThis - so "A mints, B redeems" alone
  // would also pass against the old code. This pins that the code lives ONLY in the shared store.
  it('the claim lives only in the shared store: wiping the store makes a just-minted code unredeemable', async () => {
    const kept = await bootstrap(A, MEMBER);
    const wiped = await bootstrap(A, MEMBER);
    const wipedHash = require('crypto').createHash('sha256').update(wiped.body.data.claim_code).digest('hex');
    mockDb.claims.delete(wipedHash);
    expect((await redeem(B, kept.body.data.claim_code)).statusCode).toBe(200); // control
    expect((await redeem(A, wiped.body.data.claim_code)).statusCode).toBe(401); // even on the minting instance
    expect((globalThis as Record<string, unknown>).__omnivyra_claim_code_store__).toBeUndefined();
  });

  it('only a digest of the claim code is stored', async () => {
    const b = await bootstrap(A, MEMBER);
    const code: string = b.body.data.claim_code;
    expect(code).toMatch(/^cc_[0-9a-f]{32}_[0-9a-f]{16}$/);
    expect([...mockDb.claims.keys()]).toEqual([require('crypto').createHash('sha256').update(code).digest('hex')]);
    expect(b.body.data.ttl_ms).toBe(60_000);
  });
});

describe('single use, expiry, concurrency', () => {
  it('a code redeems ONCE across instances (control: the first redeem succeeds)', async () => {
    const b = await bootstrap(A, MEMBER);
    const first = await redeem(B, b.body.data.claim_code);
    expect(first.statusCode).toBe(200);
    const again = await redeem(A, b.body.data.claim_code);
    expect(again.statusCode).toBe(401);
    expect(again.body.error).toBe('INVALID_OR_EXPIRED_CLAIM_CODE');
  });

  it('two concurrent redeems on two instances yield exactly one session', async () => {
    const b = await bootstrap(A, MEMBER);
    const [x, y] = await Promise.all([redeem(A, b.body.data.claim_code), redeem(B, b.body.data.claim_code)]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 401]);
  });

  it('G-2: a code consumed between the lookup and the redeem is refused 401 at the REDEEM step (control: unconsumed -> 200)', async () => {
    const b = await bootstrap(A, MEMBER);
    const hash = require('crypto').createHash('sha256').update(b.body.data.claim_code).digest('hex');
    const realRpc = mockRpc;
    let raced = false;
    const spy = jest.spyOn(mockDb.rpcCalls, 'push').mockImplementation(function (this: string[], ...fns: string[]) {
      // the moment the route calls the consuming redeem, another redeemer has already won
      if (fns[0] === 'extension_claim_code_redeem' && !raced) { raced = true; mockDb.claims.get(hash)!.redeemedAt = Date.now(); }
      return Array.prototype.push.apply(this, fns);
    });
    const r = await redeem(B, b.body.data.claim_code);
    spy.mockRestore();
    expect(raced).toBe(true);
    expect(mockDb.rpcCalls).toContain('extension_claim_code_peek');
    expect(r.statusCode).toBe(401);
    expect(r.body.error).toBe('INVALID_OR_EXPIRED_CLAIM_CODE');
    void realRpc;
    const c = await bootstrap(A, MEMBER);
    expect((await redeem(B, c.body.data.claim_code)).statusCode).toBe(200);
  });

  it('a code older than 60 s (store clock) is refused; control: at 59 s it redeems', async () => {
    const b1 = await bootstrap(A, MEMBER);
    const b2 = await bootstrap(A, MEMBER);
    mockDb.skewMs = 59_000;
    expect((await redeem(B, b1.body.data.claim_code)).statusCode).toBe(200);
    mockDb.skewMs = 61_000;
    const late = await redeem(B, b2.body.data.claim_code);
    expect(late.statusCode).toBe(401);
    expect(late.body.error).toBe('INVALID_OR_EXPIRED_CLAIM_CODE');
  });

  it('a malformed code never reaches the store', async () => {
    const r = await redeem(B, 'cc_not-a-code');
    expect(r.statusCode).toBe(401);
    expect(mockDb.rpcCalls).not.toContain('extension_claim_code_redeem');
    expect(mockDb.rpcCalls).not.toContain('extension_claim_code_peek');
  });
});

describe('request replay across instances', () => {
  it('the same signed request replayed on the other instance is refused NONCE_REPLAYED (control: a fresh nonce passes)', async () => {
    const { session } = await pair();
    const nonce = randomNonceHex();
    const first = await validate(A, session, undefined, nonce);
    expect(first.statusCode).toBe(200);
    const replay = await validate(B, session, undefined, nonce);
    expect(replay.statusCode).toBe(401);
    expect(replay.body).toMatchObject({ error: 'SIGNATURE_INVALID', reason: 'NONCE_REPLAYED' });
    const fresh = await validate(B, session);
    expect(fresh.statusCode).toBe(200);
  });

  it('a bad signature does not burn the nonce (an unsigned caller cannot fill the store)', async () => {
    const { session } = await pair();
    const nonce = randomNonceHex();
    const forged = await validate(A, { ...session, secret: 'not-the-secret' }, undefined, nonce);
    expect(forged.statusCode).toBe(401);
    expect(forged.body.reason).toBe('SIGNATURE_MISMATCH');
    const genuine = await validate(B, session, undefined, nonce);
    expect(genuine.statusCode).toBe(200);
  });
});

describe('tenant binding', () => {
  it('validate with another organization in the body is refused ORG_MISMATCH-style (control: own org passes)', async () => {
    const { session } = await pair();
    const own = await validate(A, session, { userId: session.userId, orgId: ORG });
    expect(own.statusCode).toBe(200);
    const other = await validate(A, session, { userId: session.userId, orgId: OTHER_ORG });
    expect(other.statusCode).toBe(403);
    expect(other.body.error).toBe('Extension session organization mismatch');
  });

  it('a code is bound to the org it was minted for (the session carries it, whatever the redeemer sends)', async () => {
    const b = await bootstrap(A, MEMBER, OTHER_ORG);
    const r = await redeem(B, b.body.data.claim_code);
    expect(r.body.data.org_id).toBe(OTHER_ORG);
  });
});

describe('ONE membership rule at bootstrap, redeem and validate', () => {
  it('a principal admitted by enforceCompanyAccess but with NO role row (platform super admin) is refused at BOOTSTRAP; no code exists', async () => {
    const r = await bootstrap(A, SUPER_ADMIN_NO_ROLE);
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toBe('EXTENSION_MEMBERSHIP_REQUIRED');
    expect(mockDb.claims.size).toBe(0);
    // control: the same principal WITH an active role row is admitted and completes the handshake
    mockDb.roles.push({ user_id: SUPER_ADMIN_NO_ROLE, company_id: ORG, status: 'active', role: 'SUPER_ADMIN' });
    const { session } = await pair(undefined, SUPER_ADMIN_NO_ROLE);
    expect((await validate(A, session)).statusCode).toBe(200);
  });

  it('an invited (non-active) membership is refused at bootstrap', async () => {
    mockDb.roles = [{ user_id: MEMBER, company_id: ORG, status: 'invited', role: 'COMPANY_ADMIN' }];
    expect((await bootstrap(A, MEMBER)).statusCode).toBe(403);
  });

  it('a suspended company: refused at bootstrap AND at validate (validate used to check the role row only)', async () => {
    const { session } = await pair();
    expect((await validate(A, session)).statusCode).toBe(200); // control
    mockDb.companies.set(ORG, 'suspended');
    const v = await validate(A, session);
    expect(v.statusCode).toBe(403);
    expect(v.body.error).toBe('Access denied to organization'); // authBridge VALIDATE_DEAD_403 -> ORG_ACCESS_REVOKED
    expect((await bootstrap(A, MEMBER)).statusCode).toBe(403);
  });

  it('membership removed between bootstrap and redeem: no token is issued (control: unchanged membership redeems)', async () => {
    const b = await bootstrap(A, MEMBER);
    const ctl = await bootstrap(A, MEMBER);
    expect((await redeem(B, ctl.body.data.claim_code)).statusCode).toBe(200);
    mockDb.roles = mockDb.roles.filter((r) => r.company_id !== ORG);
    const r = await redeem(B, b.body.data.claim_code);
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toBe('EXTENSION_MEMBERSHIP_REQUIRED');
    expect(r.body.data).toBeUndefined();
  });

  it('S-4: a membership refusal does NOT consume the code (control: membership restored -> the same code redeems)', async () => {
    const b = await bootstrap(A, MEMBER);
    const saved = mockDb.roles;
    mockDb.roles = mockDb.roles.filter((r) => r.company_id !== ORG);
    expect((await redeem(B, b.body.data.claim_code)).statusCode).toBe(403);
    expect([...mockDb.claims.values()].every((c) => c.redeemedAt === null)).toBe(true);
    expect(mockDb.rpcCalls).not.toContain('extension_claim_code_redeem');
    mockDb.roles = saved;
    expect((await redeem(B, b.body.data.claim_code)).statusCode).toBe(200);
  });

  it('S-4: a membership lookup outage (503 retryable) does not consume the code; the retry redeems', async () => {
    const b = await bootstrap(A, MEMBER);
    mockDb.rolesDown = true;
    const r = await redeem(B, b.body.data.claim_code);
    mockDb.rolesDown = false;
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatchObject({ error: 'TENANT_LOOKUP_ERROR', retryable: true });
    expect((await redeem(B, b.body.data.claim_code)).statusCode).toBe(200);
  });

  it('validate after redeem succeeds for exactly the principals bootstrap admitted', async () => {
    const { session } = await pair('linkedin_engagement');
    expect((await validate(B, session)).statusCode).toBe(200);
  });
});

describe('store unreadable -> 503, never valid', () => {
  it('bootstrap: 503 CLAIM_STORE_UNAVAILABLE (control: store up -> 200)', async () => {
    expect((await bootstrap(A, MEMBER)).statusCode).toBe(200);
    mockDb.rpcDown = true;
    const r = await bootstrap(A, MEMBER);
    expect(r.statusCode).toBe(503);
    expect(r.body.error).toBe('CLAIM_STORE_UNAVAILABLE');
    expect(r.body.data).toBeUndefined();
  });

  it('redeem: 503 CLAIM_STORE_UNAVAILABLE and no token (control: the same code redeems once the store is back)', async () => {
    const b = await bootstrap(A, MEMBER);
    mockDb.rpcDown = true;
    const r = await redeem(B, b.body.data.claim_code);
    expect(r.statusCode).toBe(503);
    expect(r.body.error).toBe('CLAIM_STORE_UNAVAILABLE');
    expect(JSON.stringify(r.body)).not.toMatch(/session_token|hmac_secret/);
    mockDb.rpcDown = false;
    expect((await redeem(B, b.body.data.claim_code)).statusCode).toBe(200);
  });

  it('S-4: a store failure AT the consuming redeem step is NOT retryable: repair_required (the code may be gone)', async () => {
    const b = await bootstrap(A, MEMBER);
    mockDb.failFn = 'extension_claim_code_redeem';
    const r = await redeem(B, b.body.data.claim_code);
    mockDb.failFn = null;
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatchObject({ success: false, error: 'CLAIM_REDEEM_UNCONFIRMED', retryable: false, repair_required: true });
    expect(JSON.stringify(r.body)).not.toMatch(/session_token|hmac_secret/);
    // CONTROL: the lookup step failing instead is an honest retryable 503 and the code survives
    const c = await bootstrap(A, MEMBER);
    mockDb.failFn = 'extension_claim_code_peek';
    const p = await redeem(B, c.body.data.claim_code);
    mockDb.failFn = null;
    expect(p.statusCode).toBe(503);
    expect(p.body).toMatchObject({ error: 'CLAIM_STORE_UNAVAILABLE', retryable: true });
    expect((await redeem(B, c.body.data.claim_code)).statusCode).toBe(200);
  });

  it('a signed call: 503 REPLAY_STORE_UNAVAILABLE - not a 401 the extension would sign out on (control: 200 when up)', async () => {
    const { session } = await pair();
    mockDb.rpcDown = true;
    const r = await validate(A, session);
    expect(r.statusCode).toBe(503);
    expect(r.body.error).toBe('REPLAY_STORE_UNAVAILABLE');
    mockDb.rpcDown = false;
    expect((await validate(A, session)).statusCode).toBe(200);
  });
});

describe('redeem product', () => {
  it('no product (combined / pre-split builds): product null and nothing bound into the token', async () => {
    const { session, redeemed } = await pair();
    expect(redeemed.body.data.product).toBeNull();
    expect(decodeToken(session.token)).not.toHaveProperty('product');
  });

  it("'linkedin_engagement' is echoed and bound; it is never reported as 'salesnav'", async () => {
    const { session, redeemed } = await pair('linkedin_engagement');
    expect(redeemed.body.data.product).toBe('linkedin_engagement');
    expect(decodeToken(session.token).product).toBe('linkedin_engagement');
  });

  it('an unknown product is refused BEFORE the code is consumed (control: the same code then redeems)', async () => {
    const b = await bootstrap(A, MEMBER);
    for (const bad of ['SALESNAV', 'combined', 42, { p: 'salesnav' }]) {
      const r = await redeem(B, b.body.data.claim_code, bad);
      expect(r.statusCode).toBe(400);
      expect(r.body.error).toBe('UNSUPPORTED_PRODUCT');
    }
    const ok = await redeem(B, b.body.data.claim_code, 'salesnav');
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.product).toBe('salesnav');
  });

  it('a token claiming an unknown product does not verify', () => {
    const svc = require('../../services/extensionSessionService');
    const good = svc.issueExtensionSessionToken({ userId: MEMBER, orgId: ORG, expiresAt: Date.now() + 60_000, hmacNonce: 'n', product: 'salesnav' });
    expect(svc.verifyExtensionSessionToken(good)).not.toBeNull(); // control
    const bad = svc.issueExtensionSessionToken({ userId: MEMBER, orgId: ORG, expiresAt: Date.now() + 60_000, hmacNonce: 'n', product: 'other' });
    expect(svc.verifyExtensionSessionToken(bad)).toBeNull();
  });
});
