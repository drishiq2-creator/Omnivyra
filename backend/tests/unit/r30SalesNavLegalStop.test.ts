/**
 * Round 30 / P0-1 — the legal stop on /bind, /ack and /runs/:id/pages (closes K18), server-side.
 *
 * Every case runs the REAL default switch read (process.env.SALESNAV_EXTENSION_LEGAL_CLEARED through
 * salesNavLegalCleared) - nothing here injects `legalCleared`, except the one case that proves an unreadable switch
 * fails closed. Every refusal has an accepted control with the exact value 'true'.
 *
 * Proven per route: enabled / disabled / missing / malformed / unreadable; the protected operation is NOT attempted
 * (no bind, no ack write, no store read, no ingest); the blocked body carries nothing but the closed condition; an
 * unauthorised caller is answered by auth, not by the guard; the tenant comes from the verified session; and the
 * unrelated extension routes (status, open run, pause, close, cancel) keep working under the stop.
 */
import {
  bindHandler, cancelRunExtensionHandler, closeHandler, openRunHandler, pagesHandler, pauseHandler, statusHandler,
  type SalesNavExtensionDeps,
} from '../../apiHandlers/salesNav/extensionRoutes';
import { ackHandler, type SalesNavUiDeps } from '../../apiHandlers/salesNav/uiRoutes';
import { SALESNAV_LEGAL_STOP_BODY, salesNavLegalCleared } from '../../services/salesNav/gate';
import { submitPage } from '../../services/salesNav/loop';
import { bindSalesNavMember, startSalesNavRun } from '../../services/salesNav/store';
import { fakeDb } from '../helpers/salesNavFakeDb';

const SWITCH = 'SALESNAV_EXTENSION_LEGAL_CLEARED';
const ORG = 'org-a';
const USER = 'user-a';
const M1 = 'ACoAAAlegalTest00001';
const URN = `urn:li:fsd_profile:${M1}`;
const LIST = 'https://www.linkedin.com/sales/lists/people/123';
const NOW = new Date('2026-11-27T12:00:00Z');

/** Values that must NOT clear the switch (missing is `undefined`). */
const CLOSED: Array<string | undefined> = [undefined, 'false', '', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'on', '"true"'];

let saved: string | undefined;
let savedRpa: string | undefined;
beforeEach(() => { saved = process.env[SWITCH]; savedRpa = process.env.SALESNAV_RPA_LEGAL_CLEARED; });
afterEach(() => {
  if (saved === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = saved;
  if (savedRpa === undefined) delete process.env.SALESNAV_RPA_LEGAL_CLEARED; else process.env.SALESNAV_RPA_LEGAL_CLEARED = savedRpa;
});
const setSwitch = (v: string | undefined) => { if (v === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = v; };

function call(method: string, body: unknown, query: Record<string, string> = {}) {
  const res: any = { _status: 0, _json: undefined as any, _headers: {} as Record<string, string> };
  res.status = (c: number) => { res._status = c; return res; };
  res.json = (b: unknown) => { res._json = b; return res; };
  res.setHeader = (k: string, v: string) => { res._headers[k] = v; };
  return { req: { method, query, body } as any, res };
}

/** Extension deps WITHOUT legalCleared: the guard reads the real environment. */
function extDeps(db = fakeDb(), over: Partial<SalesNavExtensionDeps> = {}) {
  const ingest = jest.fn(async () => { throw new Error('ingest must not be reached'); });
  const screen = jest.fn(async () => { throw new Error('screen must not be reached'); });
  const table = jest.fn((name: string) => db.table(name));
  const deps: SalesNavExtensionDeps = {
    auth: async () => ({ session: { userId: USER, orgId: ORG, expiresAt: 9e12, hmacNonce: 'n' } }),
    store: { table, now: () => NOW },
    screen: screen as never,
    ingest: ingest as never,
    secretFor: () => 'test-only-secret',
    now: () => NOW,
    ...over,
  };
  return { db, deps, ingest, screen, table };
}

async function dbWithRun() {
  const db = fakeDb();
  const st = { table: db.table, now: () => NOW };
  await bindSalesNavMember({ organizationId: ORG, initiatedBy: USER }, 'extension', M1, st);
  const r = await startSalesNavRun({ organizationId: ORG, initiatedBy: USER }, { transport: 'extension', url: LIST }, st);
  if (!('runId' in r)) throw new Error('no run');
  return { db, runId: r.runId };
}

const expectBlocked = (res: any) => {
  expect(res._status).toBe(403);
  // EXACTLY the fixed body - no run, binding, member, ack or tenant state
  expect(res._json).toEqual({ error: 'GATE_CLOSED', reason: 'legal_not_cleared' });
  expect(Object.keys(res._json).sort()).toEqual(['error', 'reason']);
};

describe('salesNavLegalCleared (the strict, fail-closed switch read)', () => {
  it.each(CLOSED)('%p does not clear', (v) => {
    expect(salesNavLegalCleared('extension', v === undefined ? {} : { [SWITCH]: v })).toBe(false);
  });
  it('control: exactly "true" clears, and only for its own transport', () => {
    expect(salesNavLegalCleared('extension', { [SWITCH]: 'true' })).toBe(true);
    expect(salesNavLegalCleared('rpa', { [SWITCH]: 'true' })).toBe(false);
  });
  it('an environment that cannot be read fails CLOSED (no throw)', () => {
    const exploding = new Proxy({}, { get() { throw new Error('env unavailable'); } }) as Record<string, string>;
    expect(salesNavLegalCleared('extension', exploding)).toBe(false);
  });
  it('the blocked body is frozen and names only the condition', () => {
    expect(SALESNAV_LEGAL_STOP_BODY).toEqual({ error: 'GATE_CLOSED', reason: 'legal_not_cleared' });
    expect(Object.isFrozen(SALESNAV_LEGAL_STOP_BODY)).toBe(true);
  });
});

describe('POST /bind under the legal stop', () => {
  it.each(CLOSED)('switch %p -> 403, nothing bound, binding store never touched', async (v) => {
    setSwitch(v);
    const bind = jest.fn();
    const e = extDeps(fakeDb(), { binding: { bind, memberFor: jest.fn() } as never });
    const { req, res } = call('POST', { memberId: URN });
    await bindHandler(req, res, e.deps);
    expectBlocked(res);
    expect(bind).not.toHaveBeenCalled();
    expect(e.table).not.toHaveBeenCalled();
  });
  it('control: "true" binds the SESSION tenant (200)', async () => {
    setSwitch('true');
    const e = extDeps();
    const { req, res } = call('POST', { memberId: URN });
    await bindHandler(req, res, e.deps);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ bound: true });
    expect(e.db.t.salesnav_member_bindings).toHaveLength(1);
    expect(e.db.t.salesnav_member_bindings[0]).toMatchObject({ organization_id: ORG, user_id: USER });
  });
  it('an unreadable switch (the port throws) fails closed', async () => {
    const bind = jest.fn();
    const e = extDeps(fakeDb(), {
      binding: { bind, memberFor: jest.fn() } as never,
      legalCleared: () => { throw new Error('config unavailable'); },
    });
    const { req, res } = call('POST', { memberId: URN });
    await bindHandler(req, res, e.deps);
    expectBlocked(res);
    expect(bind).not.toHaveBeenCalled();
  });
  it('unauthorised: auth answers (401) and the guard never speaks, cleared or not', async () => {
    for (const v of ['true', 'false']) {
      setSwitch(v);
      const bind = jest.fn();
      const e = extDeps(fakeDb(), {
        auth: async (_req, res) => { res.status(401).json({ error: 'UNAUTHENTICATED' }); return null; },
        binding: { bind, memberFor: jest.fn() } as never,
      });
      const { req, res } = call('POST', { memberId: URN });
      await bindHandler(req, res, e.deps);
      expect(res._status).toBe(401);
      expect(res._json).toEqual({ error: 'UNAUTHENTICATED' });
      expect(bind).not.toHaveBeenCalled();
    }
  });
  it('a GET is still 405 before anything else', async () => {
    setSwitch(undefined);
    const e = extDeps();
    const { req, res } = call('GET', {});
    await bindHandler(req, res, e.deps);
    expect(res._status).toBe(405);
  });
});

describe('POST /runs/:id/pages under the legal stop', () => {
  const page = (runId: string) => call('POST', {
    pageIndex: 0, finalUrl: LIST, outcome: 'ok', hasNextPage: false, listTotal: 1,
    leads: [{ lead_key: 'k1', full_name: 'Lead k1' }], reader_version: 'snr-1', attestedMemberId: URN,
  }, { id: runId });

  it.each(CLOSED)('switch %p -> 403; no run read, no screen, no ingest', async (v) => {
    setSwitch(v);
    const { db, runId } = await dbWithRun();
    const e = extDeps(db);
    const { req, res } = page(runId);
    await pagesHandler(req, res, e.deps);
    expectBlocked(res);
    expect(e.table).not.toHaveBeenCalled();
    expect(e.screen).not.toHaveBeenCalled();
    expect(e.ingest).not.toHaveBeenCalled();
    expect(db.t.salesnav_extraction_runs[0]).toMatchObject({ status: 'running', pages_read: 0 });
  });
  it('control: "true" passes the guard and reaches the loop (no reservation -> 409, still nothing ingested)', async () => {
    setSwitch('true');
    const { db, runId } = await dbWithRun();
    const e = extDeps(db);
    const { req, res } = page(runId);
    await pagesHandler(req, res, e.deps);
    expect(res._status).toBe(409);
    expect(res._json.error).toBe('NO_RESERVATION');
    expect(e.table).toHaveBeenCalled();
    expect(e.ingest).not.toHaveBeenCalled();
  });
  it('unauthorised: auth answers and nothing is read', async () => {
    setSwitch('true');
    const { db, runId } = await dbWithRun();
    const e = extDeps(db, { auth: async (_q, r) => { r.status(401).json({ error: 'UNAUTHENTICATED' }); return null; } });
    const { req, res } = page(runId);
    await pagesHandler(req, res, e.deps);
    expect(res._status).toBe(401);
    expect(e.table).not.toHaveBeenCalled();
  });
});

describe('submitPage (shared loop) - the in-process RPA route is stopped too', () => {
  it.each(['extension', 'rpa'] as const)('route %s with the switch unset -> GATE_CLOSED, store never read', async (route) => {
    setSwitch(undefined);
    delete process.env.SALESNAV_RPA_LEGAL_CLEARED;
    const table = jest.fn();
    const ingest = jest.fn();
    const out = await submitPage({ organizationId: ORG, initiatedBy: USER }, 'run-x', {
      route, pageIndex: 0, finalUrl: LIST, outcome: 'ok', hasNextPage: false, listTotal: 0, leads: [],
      readerVersion: 'snr-1', attestedMemberId: URN,
    }, { store: { table: table as never }, ingest: ingest as never });
    expect(out).toEqual({ kind: 'refusal', http: 403, error: 'GATE_CLOSED', extra: { reason: 'legal_not_cleared' } });
    expect(table).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });
  it('control: the extension switch "true" lets the extension route reach the store', async () => {
    setSwitch('true');
    const db = fakeDb();
    const table = jest.fn((n: string) => db.table(n));
    const out = await submitPage({ organizationId: ORG, initiatedBy: USER }, 'missing-run', {
      route: 'extension', pageIndex: 0, finalUrl: LIST, outcome: 'ok', hasNextPage: false, listTotal: 0, leads: [],
      readerVersion: 'snr-1', attestedMemberId: URN,
    }, { store: { table: table as never } });
    expect(out).toMatchObject({ kind: 'refusal', http: 404, error: 'RUN_NOT_FOUND' });
    expect(table).toHaveBeenCalled();
  });
});

describe('POST /ack under the legal stop', () => {
  const signedIn = async (_req: any, _res: any, companyId?: string) => (companyId === ORG ? { userId: USER } : null) as any;
  const body = { transport: 'extension', shownVersion: 'v', shownTextSha256: 'h' };
  const uiDeps = (over: Partial<SalesNavUiDeps> = {}) => {
    const recordAck = jest.fn(async () => ({ recorded: true }));
    return { recordAck, deps: { requireTenant: signedIn, recordAck: recordAck as never, ...over } as SalesNavUiDeps };
  };

  it.each(CLOSED)('switch %p -> 403 and NO acknowledgement is written', async (v) => {
    setSwitch(v);
    const u = uiDeps();
    const { req, res } = call('POST', body, { companyId: ORG });
    await ackHandler(req, res, u.deps);
    expectBlocked(res);
    expect(u.recordAck).not.toHaveBeenCalled();
  });
  it('control: "true" records it for the VERIFIED tenant and user', async () => {
    setSwitch('true');
    const u = uiDeps();
    const { req, res } = call('POST', body, { companyId: ORG });
    await ackHandler(req, res, u.deps);
    expect(res._status).toBe(200);
    expect(u.recordAck).toHaveBeenCalledWith({ organizationId: ORG, initiatedBy: USER }, expect.objectContaining({ transport: 'extension' }));
  });
  it('tenant isolation: a caller who is not a member of companyId is refused by the tenant check, never reaching the guard or the write', async () => {
    for (const v of ['true', undefined]) {
      setSwitch(v);
      const legalCleared = jest.fn(() => true);
      const u = uiDeps({ requireTenant: (async (_q: any, r: any) => { r.status(403).json({ error: 'FORBIDDEN' }); return null; }) as never, legalCleared });
      const { req, res } = call('POST', body, { companyId: 'org-b' });
      await ackHandler(req, res, u.deps);
      expect(res._status).toBe(403);
      expect(res._json).toEqual({ error: 'FORBIDDEN' });
      expect(legalCleared).not.toHaveBeenCalled();
      expect(u.recordAck).not.toHaveBeenCalled();
    }
  });
  it('an unreadable switch fails closed', async () => {
    const u = uiDeps({ legalCleared: () => { throw new Error('config unavailable'); } });
    const { req, res } = call('POST', body, { companyId: ORG });
    await ackHandler(req, res, u.deps);
    expectBlocked(res);
    expect(u.recordAck).not.toHaveBeenCalled();
  });
  it('the RPA transport has its own switch: the extension switch "true" does not clear an rpa ack', async () => {
    setSwitch('true');
    delete process.env.SALESNAV_RPA_LEGAL_CLEARED;
    const u = uiDeps();
    const { req, res } = call('POST', { ...body, transport: 'rpa' }, { companyId: ORG });
    await ackHandler(req, res, u.deps);
    expectBlocked(res);
    expect(u.recordAck).not.toHaveBeenCalled();
  });
});

describe('unrelated extension routes keep working under the stop (switch unset)', () => {
  beforeEach(() => setSwitch(undefined));

  it('/status answers 200 and REPORTS the stop (real gate), without exposing a member id', async () => {
    const { db } = await dbWithRun();
    const e = extDeps(db);
    const { req, res } = call('POST', {});
    await statusHandler(req, res, e.deps);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ enabled: false, gateReason: 'legal_not_cleared' });
    expect(JSON.stringify(res._json)).not.toContain(M1);
  });
  it('/runs/open still lets the extension find (and so stop) an open run', async () => {
    const { db, runId } = await dbWithRun();
    const e = extDeps(db);
    const { req, res } = call('POST', {});
    await openRunHandler(req, res, e.deps);
    expect(res._status).toBe(200);
    expect(res._json.runId).toBe(runId);
  });
  it('/pause, /close and /cancel - the stop-direction routes - still apply', async () => {
    const a = await dbWithRun();
    const p = call('POST', { status: 'auth_expired', code: 'logged_out' }, { id: a.runId });
    await pauseHandler(p.req, p.res, extDeps(a.db).deps);
    expect(p.res._status).toBe(200);

    const b = await dbWithRun();
    const c = call('POST', { status: 'failed', code: 'transport_error' }, { id: b.runId });
    await closeHandler(c.req, c.res, extDeps(b.db).deps);
    expect(c.res._status).toBe(200);

    const d = await dbWithRun();
    const x = call('POST', {}, { id: d.runId });
    await cancelRunExtensionHandler(x.req, x.res, extDeps(d.db).deps);
    expect(x.res._status).toBe(200);
    expect(x.res._json).toEqual({ cancelled: true });
  });
});
