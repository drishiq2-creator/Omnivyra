/**
 * Owner 2026-11-22: two independently usable LinkedIn extensions (Omnivyra for LinkedIn = engagement, Omnivyra Sales
 * Navigator). Server side:
 *   1. one-time claim codes live in a SHARED store (sha256 only, single use, expiry, product-scoped) - not one server
 *      process's memory;
 *   2. a session carries the product it was redeemed for, signed into the token;
 *   3. each product's routes refuse the other product's session (legacy sessions without a product still pass);
 *   4. every extension-authenticated route declares its product, or is listed as serving both.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { claimCodeTableFake } from '../helpers/claimCodeTableFake';

const SECRET = 'product-split-test-auth-secret';
const saved = process.env.AUTH_SECRET;
beforeAll(() => { process.env.AUTH_SECRET = SECRET; });
afterAll(() => { if (saved === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = saved; });

/* eslint-disable @typescript-eslint/no-var-requires */
const svc = () => require('../../services/extensionClaimCodeService') as typeof import('../../services/extensionClaimCodeService');
const ses = () => require('../../services/extensionSessionService') as typeof import('../../services/extensionSessionService');
const mw = () => require('../../middleware/extensionAuthMiddleware') as typeof import('../../middleware/extensionAuthMiddleware');
/* eslint-enable @typescript-eslint/no-var-requires */

const T0 = Date.parse('2026-11-22T10:00:00.000Z');
const at = (ms: number) => ({ now: () => ms });

describe('claim codes: the shared store', () => {
  it('CONTROL: a code created on one "instance" is redeemed on another (same store), once', async () => {
    const db = claimCodeTableFake();
    const c = await svc().createClaimCode('user-1', 'org-1', null, { table: db.table, ...at(T0) });
    // A FRESH module instance = a second server process: no module state is shared, only the table.
    let other!: typeof import('../../services/extensionClaimCodeService');
    jest.isolateModules(() => { other = require('../../services/extensionClaimCodeService'); });
    expect(other).not.toBe(svc());
    expect(await other.redeemClaimCode(c.code, {}, { table: db.table, ...at(T0 + 1000) }))
      .toEqual({ userId: 'user-1', orgId: 'org-1', product: null });
    expect(await svc().redeemClaimCode(c.code, {}, { table: db.table, ...at(T0 + 2000) })).toBeNull();
  });

  it('stores only sha256(code), never the code', async () => {
    const db = claimCodeTableFake();
    const c = await svc().createClaimCode('user-1', 'org-1', 'salesnav', { table: db.table, ...at(T0) });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].code_hash).toBe(createHash('sha256').update(c.code).digest('hex'));
    expect(JSON.stringify(db.rows)).not.toContain(c.code);
    expect(db.rows[0].product).toBe('salesnav');
  });

  it('an expired code is refused (60 s)', async () => {
    const db = claimCodeTableFake();
    const c = await svc().createClaimCode('user-1', 'org-1', null, { table: db.table, ...at(T0) });
    expect(await svc().redeemClaimCode(c.code, {}, { table: db.table, ...at(T0 + 61_000) })).toBeNull();
  });

  it.each([
    ['salesnav', 'linkedin_engagement', false],
    ['linkedin_engagement', 'salesnav', false],
    ['salesnav', 'salesnav', true],
    [null, 'salesnav', true],                // a pre-split page's code: any extension
    [null, 'linkedin_engagement', true],
    ['salesnav', undefined, false],          // review finding 4: a pre-split extension (no product) cannot take a product's code
  ] as const)('a code issued for %p redeemed by %p -> %p', async (issued, redeemer, ok) => {
    const db = claimCodeTableFake();
    const c = await svc().createClaimCode('user-1', 'org-1', issued, { table: db.table, ...at(T0) });
    const r = await svc().redeemClaimCode(c.code, redeemer ? { product: redeemer } : {}, { table: db.table, ...at(T0 + 1000) });
    if (ok) expect(r).toMatchObject({ userId: 'user-1', orgId: 'org-1' });
    else expect(r).toBeNull();
  });

  it('a store that cannot answer is "unavailable", never "invalid code" (error and thrown)', async () => {
    const good = claimCodeTableFake();
    const c = await svc().createClaimCode('user-1', 'org-1', null, { table: good.table, ...at(T0) });
    expect(await svc().redeemClaimCode(c.code, {}, { table: claimCodeTableFake({ failUpdate: true }).table })).toBe('unavailable');
    expect(await svc().redeemClaimCode(c.code, {}, { table: claimCodeTableFake({ throwUpdate: true }).table })).toBe('unavailable');
  });

  it('a failed insert throws ClaimStoreUnavailableError (the page gets 503, no code)', async () => {
    const S = svc();
    await expect(S.createClaimCode('user-1', 'org-1', null, { table: claimCodeTableFake({ failInsert: true }).table }))
      .rejects.toBeInstanceOf(S.ClaimStoreUnavailableError);
  });

  it('a malformed code is refused without touching the store; an unknown product is refused at creation', async () => {
    const db = claimCodeTableFake();
    expect(await svc().redeemClaimCode('cc_not-a-code', {}, { table: db.table })).toBeNull();
    expect(db.calls).toEqual([]);
    await expect(svc().createClaimCode('user-1', 'org-1', 'recruiter' as never, { table: db.table })).rejects.toThrow(/unknown product/);
  });
});

describe('sessions carry their product', () => {
  it('the product is signed into the token and read back; a tampered product is not a valid token', () => {
    const tok = ses().issueExtensionSessionToken({ userId: 'u', orgId: 'o', expiresAt: Date.now() + 60_000, hmacNonce: 'n', product: 'salesnav' });
    expect(ses().verifyExtensionSessionToken(tok)?.product).toBe('salesnav');
    const [p, sig] = tok.split('.');
    const forged = Buffer.from(Buffer.from(p, 'base64url').toString('utf8').replace('salesnav', 'linkedin_engagement')).toString('base64url');
    expect(ses().verifyExtensionSessionToken(`${forged}.${sig}`)).toBeNull();
  });

  it('a legacy token (no product) still verifies; an unknown product does not', () => {
    const legacy = ses().issueExtensionSessionToken({ userId: 'u', orgId: 'o', expiresAt: Date.now() + 60_000, hmacNonce: 'n' });
    expect(ses().verifyExtensionSessionToken(legacy)?.product).toBeUndefined();
    const odd = ses().issueExtensionSessionToken({ userId: 'u', orgId: 'o', expiresAt: Date.now() + 60_000, hmacNonce: 'n', product: 'recruiter' as never });
    expect(ses().verifyExtensionSessionToken(odd)).toBeNull();
  });
});

describe('cross-product authorization', () => {
  function call(product: 'linkedin_engagement' | 'salesnav' | undefined, routeProduct: 'linkedin_engagement' | 'salesnav' | undefined) {
    const token = ses().issueExtensionSessionToken({ userId: 'u', orgId: 'o', expiresAt: Date.now() + 60_000, hmacNonce: 'n', ...(product ? { product } : {}) });
    const out: { status?: number; body?: unknown } = {};
    const res = { status(s: number) { out.status = s; return this; }, json(b: unknown) { out.body = b; return this; }, setHeader() { return this; } };
    const req = { method: 'POST', url: '/x', headers: { authorization: `Bearer ${token}` }, body: {}, query: {} };
    return mw().requireExtensionAuth(req as never, res as never, routeProduct ? { product: routeProduct } : {}).then((r) => ({ r, out }));
  }

  it.each([
    ['salesnav', 'linkedin_engagement'],
    ['linkedin_engagement', 'salesnav'],
  ] as const)('a %s session is refused by a %s route (403 before the signature check)', async (sessionProduct, routeProduct) => {
    const { r, out } = await call(sessionProduct, routeProduct);
    expect(r).toBeNull();
    expect(out).toEqual({ status: 403, body: { success: false, error: 'EXTENSION_PRODUCT_NOT_AUTHORIZED' } });
  });

  it.each([
    ['salesnav', 'salesnav'],
    ['linkedin_engagement', 'linkedin_engagement'],
    [undefined, 'salesnav'],
    [undefined, 'linkedin_engagement'],
    ['salesnav', undefined],
  ] as const)('CONTROL: a %p session on a %p route passes the product gate (then the unsigned request fails the signature)', async (sessionProduct, routeProduct) => {
    const { out } = await call(sessionProduct, routeProduct);
    expect(out.status).toBe(401);
    expect(out.body).toMatchObject({ error: 'SIGNATURE_INVALID' });
  });
});

describe('every extension-authenticated route declares its product', () => {
  const ROOT = path.join(__dirname, '..', '..', '..');
  // The routes that serve BOTH extensions (pairing health, capability map, validation, and the R-3 410 ingestion
  // routes). Adding a route to this list is a decision, not a default.
  const BOTH = new Set([
    // Command hand-out, its results and lease renewal serve both: GET /commands offers each product only its own
    // work (salesnav: approved new LinkedIn DMs only - extensionNewDmRouting.test.ts); results and renewals are bound
    // to the session that holds the command's lease.
    'pages/api/extension/commands.ts', 'pages/api/extension/action-result.ts', 'pages/api/extension/dispatch/renew.ts',
    'pages/api/extension/validate.ts', 'pages/api/extension/health.ts', 'pages/api/extension/capabilities.ts',
    'pages/api/extension/events.ts', 'pages/api/extension/events/comments.ts', 'pages/api/extension/events/dms.ts',
  ]);
  const EXPECT: Record<string, string> = {
    'backend/apiHandlers/salesNav/extensionRoutes.ts': 'salesnav',
  };
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules|tests|\.next/.test(e.name)) walk(p, out); }
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }
  const callers = [...walk(path.join(ROOT, 'pages', 'api')), ...walk(path.join(ROOT, 'backend', 'apiHandlers'))]
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .filter((f) => /requireExtensionAuth\(req,\s*res/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));

  it('CONTROL: the scan finds the known callers', () => {
    for (const f of Object.keys(EXPECT)) expect(callers).toContain(f);
  });

  it.each(Object.entries(EXPECT))('%s passes { product: %p } at every call', (f, product) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const calls = src.match(/requireExtensionAuth\(req,\s*res[^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toContain(`product: '${product}'`);
  });

  it('no caller is unclassified (a new extension route must pick a product or be added to BOTH)', () => {
    const unclassified = callers.filter((f) => !(f in EXPECT) && !BOTH.has(f));
    expect(unclassified).toEqual([]);
  });
});
