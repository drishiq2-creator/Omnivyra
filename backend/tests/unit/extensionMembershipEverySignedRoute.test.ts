/**
 * Items E + F - the extension membership rule on EVERY signed route, driven by a synthetic client that signs exactly
 * like the extension's shared/requestSigner.js (same canonical string as extensionHandshakeSyntheticClient.test.ts),
 * against the REAL route handlers (bodyParser off, real raw-body capture, real requireExtensionAuth, real
 * extensionMembershipService -> TenantGuard) and a fake store.
 *
 * F: a live session is refused at the next request once its company is suspended or its membership is revoked; the
 *    refusal is validate's load-bearing 403 body ('Access denied to organization', which core/authBridge.js
 *    VALIDATE_DEAD_403 maps to ORG_ACCESS_REVOKED on /validate) plus code EXTENSION_MEMBERSHIP_INACTIVE; a lookup
 *    outage is a 503 (fail closed, session kept). Every refusal is paired with a control (same request, membership
 *    intact -> the route's own logic runs).
 * E: a platform super admin without an active role in the company is refused with the distinct
 *    EXTENSION_PLATFORM_ADMIN_NOT_MEMBER code (no bypass).
 */

process.env.EXTENSION_SESSION_SECRET = 'test-extension-session-secret-not-production';
delete process.env.DEV_EXTENSION_AUTH_BYPASS;

import { Readable } from 'stream';
import { webcrypto } from 'crypto';

type Row = Record<string, any>;
const mockDb = {
  claims: new Map<string, { user: string; org: string; expiresAt: number; redeemedAt: number | null }>(),
  nonces: new Map<string, number>(),
  roles: [] as Row[],
  companies: new Map<string, string>(),
  rolesDown: false,
  /** other tables (community_ai_actions, salesnav_*): in-memory rows, every filter evaluated */
  tables: {} as Record<string, Row[]>,
  /** every table a route touched (other than the membership / company reads and the handshake rpcs) */
  touches: [] as string[],
  /** reads of the membership tables (review N-1 / N-2) */
  reads: { user_company_roles: 0, companies: 0 } as Record<string, number>,
};

function mockFrom(table: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { orFilter } = require('../helpers/rpaClaimQueueDouble');
  const preds: Array<(r: Row) => boolean> = [];
  const known = table === 'user_company_roles' || table === 'companies';
  if (!known) mockDb.touches.push(table);
  else mockDb.reads[table] += 1;
  let patch: Row | null = null;
  let inserted: Row | null = null;
  const rows = (): Row[] => {
    if (table === 'user_company_roles') return mockDb.roles;
    if (table === 'companies') return [...mockDb.companies.entries()].map(([id, status]) => ({ id, status }));
    return (mockDb.tables[table] ??= []);
  };
  const result = () => {
    if (table === 'user_company_roles' && mockDb.rolesDown) return { data: null, error: { code: 'PGRST001', message: 'connection refused' }, status: 503, count: null };
    if (inserted) { rows().push(inserted); return { data: [{ ...inserted }], error: null, status: 201, count: 1 }; }
    const hits = rows().filter((r) => preds.every((p) => p(r)));
    if (patch) for (const h of hits) Object.assign(h, patch);
    return { data: hits.map((r) => ({ ...r })), error: null, status: 200, count: hits.length };
  };
  const cmp = (c: string, f: (v: any) => boolean) => { preds.push((r) => f(r[c] ?? null)); return q; };
  const q: any = {};
  for (const m of ['select', 'limit', 'order', 'not', 'upsert', 'delete', 'filter', 'contains', 'range']) q[m] = () => q;
  q.update = (p: Row) => { patch = p; return q; };
  q.insert = (r: Row) => { inserted = { ...r }; return q; };
  q.eq = (c: string, v: unknown) => cmp(c, (x) => x === v);
  q.neq = (c: string, v: unknown) => cmp(c, (x) => x !== v);
  q.in = (c: string, v: unknown[]) => cmp(c, (x) => v.includes(x));
  q.is = (c: string, v: unknown) => cmp(c, (x) => x === v);
  q.lt = (c: string, v: string) => cmp(c, (x) => x !== null && String(x) < v);
  q.lte = (c: string, v: string) => cmp(c, (x) => x !== null && String(x) <= v);
  q.gt = (c: string, v: string) => cmp(c, (x) => x !== null && String(x) > v);
  q.gte = (c: string, v: string) => cmp(c, (x) => x !== null && String(x) >= v);
  q.or = (expr: string) => { preds.push(orFilter(expr)); return q; };
  q.maybeSingle = async () => { const r = result(); return { data: r.data ? r.data[0] ?? null : null, error: r.error }; };
  q.single = async () => { const r = result(); return { data: r.data ? r.data[0] ?? null : null, error: r.error ?? (r.data?.length ? null : { code: 'PGRST116', message: 'no rows' }) }; };
  q.then = (ok: any, ko: any) => Promise.resolve(result()).then(ok, ko);
  return q;
}

async function mockRpc(fn: string, args: Record<string, any>) {
  const now = Date.now();
  if (fn === 'extension_claim_code_issue') {
    mockDb.claims.set(args.p_code_hash, { user: args.p_user_id, org: args.p_organization_id, expiresAt: now + args.p_ttl_seconds * 1000, redeemedAt: null });
    return { data: [{ issued_at: new Date(now).toISOString(), valid_until: new Date(now + args.p_ttl_seconds * 1000).toISOString() }], error: null };
  }
  if (fn === 'extension_claim_code_peek' || fn === 'extension_claim_code_redeem') {
    const c = mockDb.claims.get(args.p_code_hash);
    if (!c || c.redeemedAt !== null || !(c.expiresAt > now)) return { data: [], error: null };
    if (fn === 'extension_claim_code_peek') return { data: [{ peek_user_id: c.user, peek_organization_id: c.org }], error: null };
    c.redeemedAt = now;
    return { data: [{ redeemed_user_id: c.user, redeemed_organization_id: c.org }], error: null };
  }
  if (fn === 'extension_request_nonce_record') {
    const exp = mockDb.nonces.get(args.p_nonce_key);
    if (exp !== undefined && exp > now) return { data: false, error: null };
    mockDb.nonces.set(args.p_nonce_key, now + args.p_ttl_seconds * 1000);
    return { data: true, error: null };
  }
  mockDb.touches.push(`rpc:${fn}`);
  return { data: null, error: null };
}

jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: (f: string, a: any) => mockRpc(f, a) } }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
// Browser ingestion is suspended in production (R-3, refused before auth). Lifted HERE so the ingest routes' auth
// path - the one that applies when ingestion is re-enabled - is exercised.
jest.mock('../../services/extensionIngestionSuspension', () => ({
  ...jest.requireActual('../../services/extensionIngestionSuspension'),
  EXTENSION_BROWSER_INGESTION_SUSPENDED: false,
}));
// The web app's cookie authentication is not under test (see extensionHandshakeSyntheticClient.test.ts).
jest.mock('../../services/userContextService', () => ({
  enforceCompanyAccess: async ({ req, res }: any) => {
    const userId = req.headers['x-test-web-user'];
    if (!userId) { res.status(401).json({ error: 'Authentication required. Please sign in again.', code: 'UNAUTHENTICATED' }); return null; }
    return { userId, authenticated: true };
  },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const R = {
  bootstrap: require('../../../pages/api/extension/bootstrap').default,
  redeem: require('../../../pages/api/extension/redeem').default,
  validate: require('../../../pages/api/extension/validate').default,
  commands: require('../../../pages/api/extension/commands').default,
  actionResult: require('../../../pages/api/extension/action-result').default,
  renew: require('../../../pages/api/extension/dispatch/renew').default,
  events: require('../../../pages/api/extension/events').default,
  comments: require('../../../pages/api/extension/events/comments').default,
  dms: require('../../../pages/api/extension/events/dms').default,
  health: require('../../../pages/api/extension/health').default,
  capabilities: require('../../../pages/api/extension/capabilities').default,
  snStatus: require('../../../pages/api/salesnav/status').default,
  snBind: require('../../../pages/api/salesnav/bind').default,
  snOpen: require('../../../pages/api/salesnav/runs/open').default,
  snNext: require('../../../pages/api/salesnav/runs/[id]/next').default,
  snPages: require('../../../pages/api/salesnav/runs/[id]/pages').default,
  snPause: require('../../../pages/api/salesnav/runs/[id]/pause').default,
  snClose: require('../../../pages/api/salesnav/runs/[id]/close').default,
  snCancel: require('../../../pages/api/salesnav/runs/[id]/cancel').default,
};
const { CAPABILITY_MAP_VERSION } = require('../../services/engagementCapabilityMap');
const sessionSvc = require('../../services/extensionSessionService');
/* eslint-enable @typescript-eslint/no-var-requires */

// ---- shared/requestSigner.js, reproduced ------------------------------------------------------------------------
const subtle = webcrypto.subtle;
const toHex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
const nonceHex = () => { const a = new Uint8Array(16); webcrypto.getRandomValues(a); return toHex(a.buffer); };
const sha256Hex = async (s: string) => toHex(await subtle.digest('SHA-256', new TextEncoder().encode(s || '')));
async function hmacHex(secret: string, msg: string) {
  const enc = new TextEncoder();
  const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await subtle.sign('HMAC', key, enc.encode(msg)));
}
async function signed(secret: string, method: string, path: string, body: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = nonceHex();
  const sig = await hmacHex(secret, `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${await sha256Hex(body)}`);
  return { 'X-Omnivyra-Timestamp': ts, 'X-Omnivyra-Nonce': nonce, 'X-Omnivyra-Signature': sig };
}

type Res = { statusCode: number; body: any };
async function call(handler: any, o: { method: string; url: string; headers?: Record<string, string>; body?: string; nextParses?: boolean }): Promise<Res> {
  const buf = Buffer.from(o.body ?? '', 'utf8');
  const req: any = o.nextParses ? { body: buf.length ? JSON.parse(buf.toString('utf8')) : {} } : Readable.from(buf.length ? [buf] : []);
  const [, qs] = o.url.split('?');
  req.method = o.method;
  req.url = o.url;
  req.headers = Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  req.query = Object.fromEntries(new URLSearchParams(qs ?? ''));
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
const PLATFORM_ORG = '00000000-0000-4000-8000-0000000000f0';
const ADMIN = '00000000-0000-4000-8000-00000000c001';
const MEMBER = '00000000-0000-4000-8000-00000000c003';
const SUPER = '00000000-0000-4000-8000-00000000c002';
const OUTSIDER = '00000000-0000-4000-8000-00000000c004';

type Session = { token: string; secret: string; userId: string; orgId: string };
const bootstrap = (user: string, org = ORG) => call(R.bootstrap, {
  method: 'POST', url: '/api/extension/bootstrap', nextParses: true,
  headers: { 'Content-Type': 'application/json', 'x-test-web-user': user }, body: JSON.stringify({ organization_id: org }),
});
const redeem = (code: string) => call(R.redeem, {
  method: 'POST', url: '/api/extension/redeem', nextParses: true,
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claim_code: code, runtime_id: 'rt' }),
});
async function pair(user = MEMBER, org = ORG): Promise<Session> {
  const b = await bootstrap(user, org);
  expect(b.statusCode).toBe(200);
  const r = await redeem(b.body.data.claim_code);
  expect(r.statusCode).toBe(200);
  const d = r.body.data;
  return { token: d.session_token, secret: d.hmac_secret, userId: d.user_id, orgId: d.org_id };
}
async function signedCall(handler: any, s: Session, method: string, path: string, payload?: Row, query = '', extra: Record<string, string> = {}) {
  const body = method === 'GET' ? '' : JSON.stringify(payload ?? {});
  const h = await signed(s.secret, method, path, body);
  return call(handler, {
    method, url: `${path}${query}`, body,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}`, ...h, ...extra },
  });
}

// Every privileged signed route, as the extension calls it.
const ROUTES: Array<[string, (s: Session) => Promise<Res>]> = [
  ['validate', (s) => signedCall(R.validate, s, 'POST', '/api/extension/validate', { userId: s.userId, orgId: s.orgId })],
  ['commands (hand-out)', (s) => signedCall(R.commands, s, 'GET', '/api/extension/commands', undefined, `?organization_id=${ORG}`, { 'X-Omnivyra-Capability-Version': CAPABILITY_MAP_VERSION, 'X-Omnivyra-Dispatch-Renewal': '1' })],
  ['action-result', (s) => signedCall(R.actionResult, s, 'POST', '/api/extension/action-result', { commandId: 'cmd-1', status: 'success', leaseId: 'lease-1', result: { success: true, confirmed: true } })],
  ['dispatch renew', (s) => signedCall(R.renew, s, 'POST', '/api/extension/dispatch/renew', { commandId: 'cmd-1', leaseId: 'lease-1' })],
  ['events ingest', (s) => signedCall(R.events, s, 'POST', '/api/extension/events', { organization_id: s.orgId, events: [] })],
  ['events/comments ingest', (s) => signedCall(R.comments, s, 'POST', '/api/extension/events/comments', { organization_id: s.orgId, comments: [] })],
  ['events/dms ingest', (s) => signedCall(R.dms, s, 'POST', '/api/extension/events/dms', { organization_id: s.orgId, messages: [] })],
  ['health', (s) => signedCall(R.health, s, 'GET', '/api/extension/health', undefined, `?organization_id=${ORG}`)],
  ['capabilities', (s) => signedCall(R.capabilities, s, 'GET', '/api/extension/capabilities', undefined, `?organization_id=${ORG}`)],
  ['salesnav /status', (s) => signedCall(R.snStatus, s, 'POST', '/api/salesnav/status', {})],
  ['salesnav /bind', (s) => signedCall(R.snBind, s, 'POST', '/api/salesnav/bind', { memberId: 'ACwAAA1' })],
  ['salesnav /runs/open', (s) => signedCall(R.snOpen, s, 'POST', '/api/salesnav/runs/open', {})],
  ['salesnav /runs/:id/next', (s) => signedCall(R.snNext, s, 'POST', '/api/salesnav/runs/r1/next', { attestedMemberId: 'ACwAAA1' }, '?id=r1')],
  ['salesnav /runs/:id/pages', (s) => signedCall(R.snPages, s, 'POST', '/api/salesnav/runs/r1/pages', { pageIndex: 0, leads: [] }, '?id=r1')],
  ['salesnav /runs/:id/pause', (s) => signedCall(R.snPause, s, 'POST', '/api/salesnav/runs/r1/pause', { status: 'auth_expired', code: 'x' }, '?id=r1')],
  ['salesnav /runs/:id/close', (s) => signedCall(R.snClose, s, 'POST', '/api/salesnav/runs/r1/close', { status: 'failed', code: 'x' }, '?id=r1')],
  ['salesnav /runs/:id/cancel', (s) => signedCall(R.snCancel, s, 'POST', '/api/salesnav/runs/r1/cancel', {}, '?id=r1')],
];

const MEMBERSHIP_REFUSAL = { success: false, error: 'Access denied to organization', code: 'EXTENSION_MEMBERSHIP_INACTIVE' };
const isMembershipRefusal = (r: Res) => r.statusCode === 403 && r.body?.code === 'EXTENSION_MEMBERSHIP_INACTIVE';
/** The control: the route got PAST authentication into its own logic (any answer but an auth/membership refusal). */
const passedAuth = (r: Res) => !isMembershipRefusal(r) && r.statusCode !== 401 && !(r.statusCode === 503 && r.body?.error === 'TENANT_LOOKUP_ERROR');

beforeEach(() => {
  mockDb.claims.clear();
  mockDb.nonces.clear();
  mockDb.touches.length = 0;
  mockDb.rolesDown = false;
  mockDb.tables = {};
  mockDb.reads = { user_company_roles: 0, companies: 0 };
  mockDb.roles = [
    { user_id: ADMIN, company_id: ORG, status: 'active', role: 'COMPANY_ADMIN' },
    { user_id: MEMBER, company_id: ORG, status: 'active', role: 'CONTENT_CREATOR' },
    { user_id: OUTSIDER, company_id: OTHER_ORG, status: 'active', role: 'COMPANY_ADMIN' },
    { user_id: SUPER, company_id: PLATFORM_ORG, status: 'active', role: 'SUPER_ADMIN' },
  ];
  mockDb.companies = new Map([[ORG, 'active'], [OTHER_ORG, 'active'], [PLATFORM_ORG, 'active']]);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// Review S-1: these report the outcome of work the session already holds; they are accepted without an active
// membership (bound to the session's own lease / run) - tested in the S-1 block below, not refused here.
const OUTCOME_ROUTES = new Set(['action-result', 'salesnav /runs/:id/pause', 'salesnav /runs/:id/close', 'salesnav /runs/:id/cancel']);
const STRICT_ROUTES = ROUTES.filter(([n]) => !OUTCOME_ROUTES.has(n));
const route = (name: string) => { const r = ROUTES.find(([n]) => n === name); if (!r) throw new Error(name); return r[1]; };

describe('F(1): a live session for a company that becomes SUSPENDED is refused on every signed route that hands out or starts work', () => {
  it('the strict set is every signed route except the four outcome reports', () => {
    expect(STRICT_ROUTES.map(([n]) => n)).toEqual(expect.arrayContaining(['validate', 'commands (hand-out)', 'dispatch renew', 'salesnav /runs/:id/next', 'salesnav /runs/:id/pages', 'salesnav /bind', 'salesnav /runs/open', 'salesnav /status']));
    expect(STRICT_ROUTES).toHaveLength(ROUTES.length - OUTCOME_ROUTES.size);
  });
  it.each(STRICT_ROUTES)('%s: CONTROL passes auth while active; refused 403 once suspended', async (_name, send) => {
    const s = await pair();
    const before = await send(s);
    expect(passedAuth(before)).toBe(true);

    mockDb.companies.set(ORG, 'suspended');
    mockDb.touches.length = 0;
    const after = await send(s);
    expect(after.statusCode).toBe(403);
    expect(after.body).toMatchObject({ ...MEMBERSHIP_REFUSAL, reason: 'ORG_INACTIVE' });
    // refused BEFORE the route's own logic: no table besides the membership/company reads was touched
    expect(mockDb.touches).toEqual([]);
  });

  it('a membership lookup outage is a 503 TENANT_LOOKUP_ERROR (fail closed, not a sign-out); CONTROL: lookup back -> 200', async () => {
    const s = await pair();
    mockDb.rolesDown = true;
    const r = await ROUTES[1][1](s);
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatchObject({ error: 'TENANT_LOOKUP_ERROR', retryable: true });
    mockDb.rolesDown = false;
    expect(passedAuth(await ROUTES[1][1](s))).toBe(true);
  });
});

describe('F(6): no command is handed out after suspension', () => {
  it('commands: active -> the route reads community_ai_actions; suspended -> 403 and community_ai_actions is never read or claimed', async () => {
    const s = await pair();
    const ok = await ROUTES[1][1](s);
    expect(ok.statusCode).toBe(200);
    expect(mockDb.touches).toContain('community_ai_actions'); // CONTROL: the hand-out query ran
    mockDb.companies.set(ORG, 'suspended');
    mockDb.touches.length = 0;
    const r = await ROUTES[1][1](s);
    expect(r.statusCode).toBe(403);
    expect(mockDb.touches).not.toContain('community_ai_actions');
  });
});

describe('F(2)/(3): pairing while suspended, and after reactivation', () => {
  it('bootstrap refused while suspended; a code minted before suspension is not redeemed; CONTROL: active -> pairs', async () => {
    const early = await bootstrap(MEMBER);
    expect(early.statusCode).toBe(200);
    mockDb.companies.set(ORG, 'suspended');
    const b = await bootstrap(MEMBER);
    expect(b.statusCode).toBe(403);
    expect(b.body.error).toBe('EXTENSION_MEMBERSHIP_REQUIRED');
    const r = await redeem(early.body.data.claim_code);
    expect(r.statusCode).toBe(403);
    expect(JSON.stringify(r.body)).not.toMatch(/session_token|hmac_secret/);
    mockDb.companies.set(ORG, 'active');
    expect((await redeem(early.body.data.claim_code)).statusCode).toBe(200); // the refused code was not consumed
  });

  it('reactivated: a NEW pairing works, and the OLD (unexpired) session works again (decision: no revocation list)', async () => {
    const old = await pair();
    mockDb.companies.set(ORG, 'suspended');
    expect((await ROUTES[0][1](old)).statusCode).toBe(403);
    mockDb.companies.set(ORG, 'active');
    expect((await ROUTES[0][1](old)).statusCode).toBe(200);
    const fresh = await pair();
    expect((await ROUTES[0][1](fresh)).statusCode).toBe(200);
  });
});

describe('F(4): revoked membership / deactivated user', () => {
  it.each(['inactive', 'removed', 'revoked', 'invited'])('role row status %s -> validate AND commands refused; CONTROL active -> allowed', async (status) => {
    const s = await pair();
    expect((await ROUTES[0][1](s)).statusCode).toBe(200);
    mockDb.roles = mockDb.roles.map((r) => (r.user_id === MEMBER ? { ...r, status } : r));
    for (const idx of [0, 1]) {
      const r = await ROUTES[idx][1](s);
      expect(r.statusCode).toBe(403);
      expect(r.body).toMatchObject({ ...MEMBERSHIP_REFUSAL, reason: 'STALE_MEMBERSHIP' });
    }
  });

  it('role row deleted -> refused NOT_A_MEMBER (the super-admin user-delete path flips rows to inactive: covered above)', async () => {
    const s = await pair();
    mockDb.roles = mockDb.roles.filter((r) => r.user_id !== MEMBER);
    const r = await ROUTES[1][1](s);
    expect(r.body).toMatchObject({ ...MEMBERSHIP_REFUSAL, reason: 'NOT_A_MEMBER' });
  });
});

describe('F(5): expired session token', () => {
  async function tokenSession(expiresAt: number): Promise<Session> {
    const nonce = 'n'.repeat(32);
    const token = sessionSvc.issueExtensionSessionToken({ userId: MEMBER, orgId: ORG, expiresAt, hmacNonce: nonce });
    const secret = sessionSvc.deriveExtensionHmacSecret({ userId: MEMBER, orgId: ORG, expiresAt, nonce });
    return { token, secret, userId: MEMBER, orgId: ORG };
  }
  it('expired -> 401 INVALID_SESSION on validate and commands; CONTROL: same token shape unexpired -> passes', async () => {
    const dead = await tokenSession(Date.now() - 1000);
    for (const idx of [0, 1]) {
      const r = await ROUTES[idx][1](dead);
      expect(r.statusCode).toBe(401);
      expect(r.body.error).toBe('INVALID_SESSION');
    }
    const live = await tokenSession(Date.now() + 60_000);
    expect((await ROUTES[0][1](live)).statusCode).toBe(200);
  });
});

describe('E: who may pair', () => {
  it('platform super admin with NO role in the company -> 403 EXTENSION_PLATFORM_ADMIN_NOT_MEMBER, no code minted', async () => {
    const r = await bootstrap(SUPER);
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toBe('EXTENSION_PLATFORM_ADMIN_NOT_MEMBER');
    expect(r.body.message).toMatch(/Company Admin/);
    expect(mockDb.claims.size).toBe(0);
  });

  it('CONTROL: the same super admin WITH an active role row in the company pairs and validates', async () => {
    mockDb.roles.push({ user_id: SUPER, company_id: ORG, status: 'active', role: 'COMPANY_ADMIN' });
    const s = await pair(SUPER);
    expect((await ROUTES[0][1](s)).statusCode).toBe(200);
  });

  it('CONTROL: a non-admin principal with no role here gets the generic EXTENSION_MEMBERSHIP_REQUIRED (the distinct code is only for platform admins)', async () => {
    const r = await bootstrap(OUTSIDER);
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toBe('EXTENSION_MEMBERSHIP_REQUIRED');
  });

  it('member of ANOTHER tenant is refused for this tenant; CONTROL: pairs for their own tenant', async () => {
    expect((await bootstrap(OUTSIDER, ORG)).statusCode).toBe(403);
    const s = await pair(OUTSIDER, OTHER_ORG);
    expect(s.orgId).toBe(OTHER_ORG);
    expect((await ROUTES[0][1](s)).statusCode).toBe(200);
  });

  it('a super admin who lost the role between bootstrap and redeem: redeem answers the distinct code, no token', async () => {
    mockDb.roles.push({ user_id: SUPER, company_id: ORG, status: 'active', role: 'COMPANY_ADMIN' });
    const b = await bootstrap(SUPER);
    expect(b.statusCode).toBe(200);
    mockDb.roles = mockDb.roles.filter((r) => !(r.user_id === SUPER && r.company_id === ORG));
    const r = await redeem(b.body.data.claim_code);
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toBe('EXTENSION_PLATFORM_ADMIN_NOT_MEMBER');
    expect(JSON.stringify(r.body)).not.toMatch(/session_token|hmac_secret/);
  });

  it('a super admin whose company-scoped session outlives the role is refused like anyone else (no bypass on signed routes)', async () => {
    mockDb.roles.push({ user_id: SUPER, company_id: ORG, status: 'active', role: 'COMPANY_ADMIN' });
    const s = await pair(SUPER);
    mockDb.roles = mockDb.roles.filter((r) => !(r.user_id === SUPER && r.company_id === ORG));
    const r = await ROUTES[1][1](s);
    expect(r.body).toMatchObject({ ...MEMBERSHIP_REFUSAL, reason: 'NOT_A_MEMBER' });
  });

  it.each([['company admin', ADMIN], ['ordinary active member', MEMBER]])('%s: pairs and validates (unchanged)', async (_l, user) => {
    const s = await pair(user);
    expect((await ROUTES[0][1](s)).statusCode).toBe(200);
  });
});

// ---- review S-1 / S-2 / N-1 / N-2 / N-3 ------------------------------------------------------------------------
const decodeToken = (t: string) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));
const holderOf = (s: Session) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('crypto');
  const p = decodeToken(s.token);
  return createHash('sha256').update(`lease-holder:${p.userId}:${p.orgId}:${p.hmacNonce}`).digest('hex').slice(0, 32);
};
const action = (over: Row = {}): Row => ({
  id: 'cmd-1', tenant_id: ORG, organization_id: ORG, platform: 'linkedin', action_type: 'like', target_id: 'urn:li:activity:1',
  suggested_text: null, final_text: null, execution_mode: 'browser', status: 'pending', created_at: '2026-11-27T00:00:00.000Z',
  approved_at: '2026-11-27T00:00:00.000Z', dispatch_lease_id: null, dispatch_lease_holder_id: null, dispatch_lease_expires_at: null,
  dispatch_acknowledged_at: null, execution_correlation_id: null, command_chain: null, command_chain_index: 0,
  idempotency_key: null, execution_result: null, risk_level: 'low', ...over,
});
const legacyCommands = (s: Session) => signedCall(R.commands, s, 'GET', '/api/extension/commands', undefined, `?organization_id=${ORG}`, { 'X-Omnivyra-Capability-Version': CAPABILITY_MAP_VERSION });
const result = (s: Session, leaseId: string, over: Row = {}) => signedCall(R.actionResult, s, 'POST', '/api/extension/action-result',
  { commandId: 'cmd-1', status: 'success', leaseId, result: { success: true, confirmed: true, mode: 'browser' }, ...over });


/** The lease /api/extension/commands writes on claim (commands.ts claim CAS), for THIS session. */
function claimFor(s: Session, over: Row = {}) {
  const leaseId = 'lease-abc';
  mockDb.tables.community_ai_actions = [action({
    dispatch_lease_id: leaseId, dispatch_lease_holder_id: holderOf(s),
    dispatch_lease_expires_at: new Date(Date.now() + 90_000).toISOString(), ...over,
  })];
  return leaseId;
}
const row1 = () => mockDb.tables.community_ai_actions[0];

describe('S-1: an outcome report for work already handed out is recorded after the membership is lost', () => {
  it('suspension between claim and action-result: result recorded, row finalised, lease released, not re-offered', async () => {
    const s = await pair();
    const leaseId = claimFor(s);
    mockDb.companies.set(ORG, 'suspended');
    const r = await result(s, leaseId);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ success: true, status: 'executed' });
    expect(row1()).toMatchObject({ status: 'executed', dispatch_lease_id: null, dispatch_lease_holder_id: null, dispatch_lease_expires_at: null });
    // no re-offer: after reactivation a LEGACY client of another member asks for work - the row is terminal
    mockDb.companies.set(ORG, 'active');
    const admin = await pair(ADMIN);
    const offer = await legacyCommands(admin);
    expect(offer.statusCode).toBe(200);
    expect((offer.body.commands ?? []).map((c: Row) => c.id)).not.toContain('cmd-1');
    expect(row1().status).toBe('executed');
  });

  it('CONTROLS while suspended: commands hand-out 403 and dispatch renew 403 (work is not handed out or extended)', async () => {
    const s = await pair();
    const leaseId = claimFor(s);
    mockDb.companies.set(ORG, 'suspended');
    expect((await ROUTES[1][1](s)).statusCode).toBe(403);
    const renew = await signedCall(R.renew, s, 'POST', '/api/extension/dispatch/renew', { commandId: 'cmd-1', leaseId });
    expect(renew.statusCode).toBe(403);
    expect(renew.body.code).toBe('EXTENSION_MEMBERSHIP_INACTIVE');
  });

  it('the lease-holder binding still applies: another (also suspended) member cannot close this lease', async () => {
    const s = await pair();
    const leaseId = claimFor(s);
    const other = await pair(ADMIN);
    mockDb.companies.set(ORG, 'suspended');
    const r = await result(other, leaseId);
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toBe('LEASE_HOLDER_MISMATCH');
    expect(row1()).toMatchObject({ status: 'pending', dispatch_lease_id: leaseId });
  });

  it('report-only never re-opens a chain: an intermediate step finalises the action as failed (CONTROL: active -> chain advances)', async () => {
    const chain = [{ action_type: 'open_thread' }, { action_type: 'send_dm' }];
    const s = await pair();
    let leaseId = claimFor(s, { command_chain: chain, command_chain_index: 0 });
    let r = await result(s, leaseId);
    expect(r.body).toMatchObject({ chain_advanced: true, next_index: 1 }); // CONTROL
    expect(row1()).toMatchObject({ status: 'pending', command_chain_index: 1, dispatch_lease_id: null });

    leaseId = claimFor(s, { command_chain: chain, command_chain_index: 0 });
    mockDb.companies.set(ORG, 'suspended');
    r = await result(s, leaseId);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ status: 'failed', chain_stopped: true });
    expect(row1()).toMatchObject({ status: 'failed', command_chain_index: 0, dispatch_lease_id: null });
  });

  it('a membership LOOKUP ERROR on action-result: the report is still recorded (recording authorises nothing new)', async () => {
    const s = await pair();
    const leaseId = claimFor(s);
    mockDb.rolesDown = true;
    const r = await result(s, leaseId);
    expect(r.statusCode).toBe(200);
    expect(row1().status).toBe('executed');
  });

  describe("Sales Navigator: stopping / closing the session member's own run", () => {
    const MEMBER_ID = 'ACwAAA1';
    const run = (over: Row = {}): Row => ({
      id: 'r1', organization_id: ORG, transport: 'extension', member_id: MEMBER_ID, status: 'running', active_route: 'extension',
      next_page_index: 1, pending_page_index: null, pending_granted: null, ...over,
    });
    beforeEach(() => {
      mockDb.tables.salesnav_extraction_runs = [run()];
      mockDb.tables.salesnav_member_bindings = [{ organization_id: ORG, user_id: MEMBER, transport: 'extension', member_id: MEMBER_ID }];
    });
    const close = (s: Session) => signedCall(R.snClose, s, 'POST', '/api/salesnav/runs/r1/close', { status: 'failed', code: 'internal_error' }, '?id=r1');

    it('close after suspension: accepted and the run is closed; CONTROL: /next after suspension refused 403', async () => {
      const s = await pair();
      mockDb.companies.set(ORG, 'suspended');
      const c = await close(s);
      expect(c.statusCode).toBe(200);
      expect(mockDb.tables.salesnav_extraction_runs[0]).toMatchObject({ status: 'failed', status_code: 'internal_error' });
      const n = await route('salesnav /runs/:id/next')(s);
      expect(n.statusCode).toBe(403);
      expect(n.body.code).toBe('EXTENSION_MEMBERSHIP_INACTIVE');
    });

    it('pause and cancel after suspension are accepted for the own run', async () => {
      const s = await pair();
      mockDb.companies.set(ORG, 'suspended');
      const p = await signedCall(R.snPause, s, 'POST', '/api/salesnav/runs/r1/pause', { status: 'auth_expired', code: 'checkpoint' }, '?id=r1');
      expect(p.statusCode).toBe(200);
      mockDb.tables.salesnav_extraction_runs = [run()];
      const c = await signedCall(R.snCancel, s, 'POST', '/api/salesnav/runs/r1/cancel', {}, '?id=r1');
      expect(c.statusCode).toBe(200);
      expect(mockDb.tables.salesnav_extraction_runs[0].status).toBe('cancelled');
    });

    it('a run of ANOTHER member is refused in report-only mode (run-owner binding); CONTROL: own run closes', async () => {
      mockDb.tables.salesnav_extraction_runs = [run({ member_id: 'ACwOTHER' })];
      const s = await pair();
      mockDb.companies.set(ORG, 'suspended');
      const c = await close(s);
      expect(c.statusCode).toBe(403);
      expect(c.body.reason).toBe('RUN_NOT_OWNED_BY_SESSION_MEMBER');
      expect(mockDb.tables.salesnav_extraction_runs[0].status).toBe('running');
      mockDb.tables.salesnav_extraction_runs = [run()];
      expect((await close(s)).statusCode).toBe(200);
    });

    it('lookup outage: close accepted; /next answers 503 TENANT_LOOKUP_ERROR (N-3)', async () => {
      const s = await pair();
      mockDb.rolesDown = true;
      expect((await close(s)).statusCode).toBe(200);
      const n = await route('salesnav /runs/:id/next')(s);
      expect(n.statusCode).toBe(503);
      expect(n.body.error).toBe('TENANT_LOOKUP_ERROR');
    });
  });

  it('the exemption is an allowlist: report-outcome asked for on another path is refused as usual', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireExtensionAuth } = require('../../middleware/extensionAuthMiddleware');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { withExtensionRawBody } = require('../../middleware/extensionRawBody');
    const probe = withExtensionRawBody(async (rq: any, rs: any) => {
      const a = await requireExtensionAuth(rq, rs, { membership: 'report-outcome' });
      if (a) rs.status(200).json({ membership: a.membership });
    });
    const s = await pair();
    mockDb.companies.set(ORG, 'suspended');
    const off = await signedCall(probe, s, 'POST', '/api/extension/dispatch/renew', { commandId: 'cmd-1', leaseId: 'x' });
    expect(off.statusCode).toBe(403);
    const on = await signedCall(probe, s, 'POST', '/api/extension/action-result', {});
    expect(on.body).toEqual({ membership: 'report-only' }); // CONTROL: an allowlisted path
  });

  it('only action-result and the SN pause/close/cancel handlers ask for report-outcome (it cannot spread silently)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('child_process');
    const out: string = execFileSync('git', ['grep', '-l', "'report-outcome'", '--', 'pages', 'backend', 'lib', ':!backend/tests'], { encoding: 'utf8' });
    expect(out.trim().split(/\r?\n/).sort()).toEqual([
      'backend/apiHandlers/salesNav/extensionRoutes.ts',
      'backend/middleware/extensionAuthMiddleware.ts',
      'pages/api/extension/action-result.ts',
    ]);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('fs').readFileSync(require('path').join(process.cwd(), 'backend/apiHandlers/salesNav/extensionRoutes.ts'), 'utf8');
    expect((src.match(/authed\(req, res, deps, 'report-outcome'\)/g) ?? []).length).toBe(3);
  });
});

describe('S-2 / N-3: an unexpected membership answer or a throw fails CLOSED (503), never open', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const svc = require('../../services/extensionMembershipService');
  it('a shape-less result ({}) -> commands 503; CONTROL: ok:true -> 200', async () => {
    const s = await pair();
    const spy = jest.spyOn(svc, 'checkExtensionMembership').mockResolvedValueOnce({} as any);
    const r = await ROUTES[1][1](s);
    expect(r.statusCode).toBe(503);
    expect(r.body.error).toBe('TENANT_LOOKUP_ERROR');
    spy.mockResolvedValueOnce({ ok: true });
    expect((await ROUTES[1][1](s)).statusCode).toBe(200);
  });

  it("validate's own check: shape-less -> 503, not 200 (middleware answered ok, validate got {})", async () => {
    const s = await pair();
    jest.spyOn(svc, 'checkExtensionMembership').mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({} as any);
    const r = await ROUTES[0][1](s);
    expect(r.statusCode).toBe(503);
  });

  it('checkExtensionMembership THROWS -> commands 503 and renew 503; action-result (outcome) still recorded', async () => {
    const s = await pair();
    const leaseId = claimFor(s);
    jest.spyOn(svc, 'checkExtensionMembership').mockRejectedValue(new Error('boom'));
    expect((await ROUTES[1][1](s)).statusCode).toBe(503);
    expect((await signedCall(R.renew, s, 'POST', '/api/extension/dispatch/renew', { commandId: 'cmd-1', leaseId })).statusCode).toBe(503);
    const r = await result(s, leaseId);
    expect(r.statusCode).toBe(200);
    expect(row1().status).toBe('executed');
  });

  it('lookup outage (rolesDown): renew 503 (not 403, not 200)', async () => {
    const s = await pair();
    const leaseId = claimFor(s);
    mockDb.rolesDown = true;
    const r = await signedCall(R.renew, s, 'POST', '/api/extension/dispatch/renew', { commandId: 'cmd-1', leaseId });
    expect(r.statusCode).toBe(503);
    expect(r.body.error).toBe('TENANT_LOOKUP_ERROR');
  });
});

describe('N-1 / N-2: membership reads per signed request', () => {
  it('N-1: a denied signed request reads user_company_roles ONCE (no platform-admin consult); CONTROL: bootstrap consults (2 reads)', async () => {
    const s = await pair();
    mockDb.roles = mockDb.roles.filter((r) => r.user_id !== MEMBER);
    mockDb.roles.push({ user_id: MEMBER, company_id: PLATFORM_ORG, status: 'active', role: 'SUPER_ADMIN' }); // would match the consult
    mockDb.reads = { user_company_roles: 0, companies: 0 };
    const r = await ROUTES[1][1](s);
    expect(r.statusCode).toBe(403);
    expect(mockDb.reads.user_company_roles).toBe(1);
    mockDb.reads = { user_company_roles: 0, companies: 0 };
    const b = await bootstrap(MEMBER);
    expect(b.body.error).toBe('EXTENSION_PLATFORM_ADMIN_NOT_MEMBER');
    expect(mockDb.reads.user_company_roles).toBe(2);
  });

  it('N-2: unsigned and bad-signature requests read NO membership/company row; CONTROL: a signed one does', async () => {
    const s = await pair();
    mockDb.reads = { user_company_roles: 0, companies: 0 };
    const unsigned = await call(R.commands, { method: 'GET', url: '/api/extension/commands', headers: { Authorization: `Bearer ${s.token}` } });
    expect(unsigned.statusCode).toBe(401);
    const bad = await signedCall(R.commands, { ...s, secret: 'not-the-secret' }, 'GET', '/api/extension/commands');
    expect(bad.statusCode).toBe(401);
    const noToken = await signedCall(R.commands, { ...s, token: 'garbage' }, 'GET', '/api/extension/commands');
    expect(noToken.statusCode).toBe(401);
    expect(mockDb.reads).toEqual({ user_company_roles: 0, companies: 0 });
    await ROUTES[1][1](s);
    expect(mockDb.reads.user_company_roles).toBeGreaterThan(0);
  });
});
