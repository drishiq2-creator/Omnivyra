/**
 * Sales Navigator route contract v0.3, GROUP A (browser-session routes), over the shared fake 073 store.
 * Every refusal has a control that is accepted; the tenant and user come only from the (faked) verified session;
 * an unreadable store is 503, never "not found" / "not bound" / "not acked"; no response carries the member id or a
 * vendor cursor.
 */
import {
  ackHandler, cancelRunSessionHandler, resumeRunHandler, runStatusHandler, setupHandler, startRunHandler,
  type SalesNavUiDeps,
} from '../../apiHandlers/salesNav/uiRoutes';
import { SALESNAV_RESTRICTION_ACK } from '../../services/salesNav/restrictionAck';
import { bindSalesNavMember } from '../../services/salesNav/store';
import { fakeDb } from '../helpers/salesNavFakeDb';

const ORG = 'org-a';
const USER = 'user-a';
const M1 = 'ACoAAArouteTest00001';
const LIST = 'https://www.linkedin.com/sales/lists/people/123';
const NOW = new Date('2026-11-21T12:00:00Z');

function call(method: string, query: Record<string, string>, body?: unknown) {
  const res: any = { _status: 0, _json: undefined as any, _headers: {} as Record<string, string> };
  res.status = (c: number) => { res._status = c; return res; };
  res.json = (b: unknown) => { res._json = b; return res; };
  res.setHeader = (k: string, v: string) => { res._headers[k] = v; };
  return { req: { method, query, body } as any, res };
}
const signedIn = (userId = USER) => async (_req: any, _res: any, companyId?: string) =>
  (companyId === ORG || companyId === 'org-b' ? { userId } : null) as any;
const gateOpen = async () => ({ allowed: true, reason: 'cleared' });

function deps(db = fakeDb(), over: Partial<SalesNavUiDeps> = {}): SalesNavUiDeps {
  return {
    requireTenant: signedIn(),
    gate: gateOpen,
    // Round 30: these tests exercise the CLEARED path; the legal stop itself is r30SalesNavLegalStop.test.ts.
    legalCleared: () => true,
    readAck: async () => ({ consent_version: SALESNAV_RESTRICTION_ACK.version, granted_by: USER, granted_at: 'x' }),
    store: { table: db.table, now: () => NOW },
    now: () => NOW,
    ...over,
  };
}
async function boundDb() {
  const db = fakeDb();
  await bindSalesNavMember({ organizationId: ORG, initiatedBy: USER }, 'extension', M1, { table: db.table });
  return db;
}

describe('methods', () => {
  it.each([
    [setupHandler, 'POST'], [ackHandler, 'GET'], [startRunHandler, 'GET'], [runStatusHandler, 'POST'],
    [resumeRunHandler, 'GET'], [cancelRunSessionHandler, 'GET'],
  ])('%#: wrong method -> 405 with Allow', async (h: any, m) => {
    const { req, res } = call(m as string, { companyId: ORG });
    await h(req, res, deps());
    expect(res._status).toBe(405);
    expect(res._headers.Allow).toBeDefined();
  });
});

describe('GET /setup', () => {
  it('returns the CURRENT ack text + hash, acked, the gate and bound - never the member id', async () => {
    const db = await boundDb();
    const { req, res } = call('GET', { companyId: ORG, transport: 'extension' });
    await setupHandler(req, res, deps(db));
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      transport: 'extension', acked: true, bound: true, gate: { allowed: true },
      ack: { version: SALESNAV_RESTRICTION_ACK.version, textSha256: SALESNAV_RESTRICTION_ACK.textSha256, status: 'placeholder' },
    });
    expect(JSON.stringify(res._json)).not.toContain(M1);
  });
  it('an UNREADABLE ack ledger is acked: null (never false), and an unreadable binding is bound: null', async () => {
    const db = fakeDb({ failTable: 'salesnav_member_bindings' });
    const { req, res } = call('GET', { companyId: ORG });
    await setupHandler(req, res, deps(db, { readAck: async () => 'unreadable' as const }));
    expect(res._json).toMatchObject({ acked: null, bound: null });
  });
  it('control: no ack and no binding read as false / false', async () => {
    const { req, res } = call('GET', { companyId: ORG });
    await setupHandler(req, res, deps(fakeDb(), { readAck: async () => null }));
    expect(res._json).toMatchObject({ acked: false, bound: false });
  });
  it('an unknown transport -> 400', async () => {
    const { req, res } = call('GET', { companyId: ORG, transport: 'carrier_pigeon' });
    await setupHandler(req, res, deps());
    expect(res._status).toBe(400);
  });
  it('no verified session -> the guard answers, nothing else runs', async () => {
    const gate = jest.fn(gateOpen);
    const { req, res } = call('GET', { companyId: 'not-my-company' });
    await setupHandler(req, res, deps(fakeDb(), { gate }));
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('POST /ack', () => {
  const shown = { transport: 'extension', shownVersion: SALESNAV_RESTRICTION_ACK.version, shownTextSha256: SALESNAV_RESTRICTION_ACK.textSha256 };
  it('records the SHOWN text for the session user -> 200', async () => {
    const recordAck = jest.fn(async () => ({ acceptedVersion: SALESNAV_RESTRICTION_ACK.version }));
    const { req, res } = call('POST', { companyId: ORG }, { ...shown, organizationId: 'org-evil', userId: 'someone-else' });
    await ackHandler(req, res, deps(fakeDb(), { recordAck: recordAck as never }));
    expect(res._status).toBe(200);
    expect(recordAck).toHaveBeenCalledWith({ organizationId: ORG, initiatedBy: USER }, expect.objectContaining({ transport: 'extension' }));
  });
  it('a stale text -> 409 ACK_TEXT_STALE (real recorder)', async () => {
    const { req, res } = call('POST', { companyId: ORG }, { ...shown, shownVersion: 'old' });
    await ackHandler(req, res, deps());
    expect(res._status).toBe(409);
    expect(res._json.error).toBe('ACK_TEXT_STALE');
  });
  it('a failed write -> 503, never 200', async () => {
    const { req, res } = call('POST', { companyId: ORG }, shown);
    await ackHandler(req, res, deps(fakeDb(), { recordAck: (async () => { throw new Error('db'); }) as never }));
    expect(res._status).toBe(503);
  });
  it('missing shown text / bad transport -> 400', async () => {
    for (const b of [{ transport: 'extension' }, { ...shown, transport: 'x' }]) {
      const { req, res } = call('POST', { companyId: ORG }, b);
      await ackHandler(req, res, deps());
      expect(res._status).toBe(400);
    }
  });
});

describe('POST /runs (start)', () => {
  it('a CLOSED gate -> 403 GATE_CLOSED with its reason, and NO run row is written', async () => {
    const db = await boundDb();
    const { req, res } = call('POST', { companyId: ORG }, { transport: 'extension', url: LIST });
    await startRunHandler(req, res, deps(db, { gate: async () => ({ allowed: false, reason: 'legal_not_cleared' }) }));
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'GATE_CLOSED', reason: 'legal_not_cleared' });
    expect(db.t.salesnav_extraction_runs).toHaveLength(0);
  });
  it('control: open gate + bound member + allowed URL -> 201 with run id, kind, canonical URL', async () => {
    const db = await boundDb();
    const { req, res } = call('POST', { companyId: ORG }, { transport: 'extension', url: LIST, organizationId: 'org-evil' });
    await startRunHandler(req, res, deps(db));
    expect(res._status).toBe(201);
    expect(res._json).toMatchObject({ kind: 'lead_list', canonicalUrl: LIST });
    expect(db.t.salesnav_extraction_runs[0]).toMatchObject({ organization_id: ORG, initiated_by: USER, member_id: M1, active_route: 'extension' });
  });
  it.each([
    ['a non-Sales-Navigator URL', 'https://example.com/x', 422, 'URL_REFUSED'],
    ['not https', 'http://www.linkedin.com/sales/lists/people/1', 422, 'URL_REFUSED'],
  ])('%s -> %i %s', async (_l, url, code, err) => {
    const { req, res } = call('POST', { companyId: ORG }, { transport: 'extension', url });
    await startRunHandler(req, res, deps(await boundDb()));
    expect(res._status).toBe(code);
    expect(res._json.error).toBe(err);
  });
  it('an unbound user -> 409 MEMBER_UNRESOLVED; a second open run -> 409 RUN_ALREADY_OPEN', async () => {
    const { req, res } = call('POST', { companyId: ORG }, { transport: 'extension', url: LIST });
    await startRunHandler(req, res, deps(fakeDb()));
    expect(res._json.error).toBe('MEMBER_UNRESOLVED');
    const db = await boundDb();
    const first = call('POST', { companyId: ORG }, { transport: 'extension', url: LIST });
    await startRunHandler(first.req, first.res, deps(db));
    const second = call('POST', { companyId: ORG }, { transport: 'extension', url: LIST });
    await startRunHandler(second.req, second.res, deps(db));
    expect(second.res._status).toBe(409);
    expect(second.res._json.error).toBe('RUN_ALREADY_OPEN');
  });
  it('an unreadable binding store -> 503, never "unbound"', async () => {
    const { req, res } = call('POST', { companyId: ORG }, { transport: 'extension', url: LIST });
    await startRunHandler(req, res, deps(fakeDb({ failTable: 'salesnav_member_bindings' })));
    expect(res._status).toBe(503);
  });
});

describe('GET /runs/:id, resume, cancel', () => {
  async function started() {
    const db = await boundDb();
    const s = call('POST', { companyId: ORG }, { transport: 'extension', url: LIST });
    await startRunHandler(s.req, s.res, deps(db));
    return { db, runId: s.res._json.runId as string };
  }
  it('status: the view, never the member id / seen keys / vendor cursor', async () => {
    const { db, runId } = await started();
    db.t.salesnav_extraction_runs[0].seen_lead_keys = ['k-secret-1'];
    const { req, res } = call('GET', { companyId: ORG, id: runId });
    await runStatusHandler(req, res, deps(db));
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ runId, status: 'running', transport: 'extension' });
    const text = JSON.stringify(res._json);
    expect(text).not.toContain(M1);
    expect(text).not.toContain('k-secret-1');
    expect(text).not.toContain('vendor_cursor');
  });
  it('status: ANOTHER company -> 404 (never its run); unreadable -> 503', async () => {
    const { db, runId } = await started();
    const other = call('GET', { companyId: 'org-b', id: runId });
    await runStatusHandler(other.req, other.res, deps(db));
    expect(other.res._status).toBe(404);
    const broken = call('GET', { companyId: ORG, id: runId });
    await runStatusHandler(broken.req, broken.res, deps(fakeDb({ failTable: 'salesnav_extraction_runs' })));
    expect(broken.res._status).toBe(503);
  });
  it('cancel: 200 and the run is cancelled; again -> 409 RUN_NOT_OPEN; another company -> 404', async () => {
    const { db, runId } = await started();
    const other = call('POST', { companyId: 'org-b', id: runId });
    await cancelRunSessionHandler(other.req, other.res, deps(db));
    expect(other.res._status).toBe(404);
    expect(db.t.salesnav_extraction_runs[0].status).toBe('running');
    const c = call('POST', { companyId: ORG, id: runId });
    await cancelRunSessionHandler(c.req, c.res, deps(db));
    expect(c.res._status).toBe(200);
    expect(db.t.salesnav_extraction_runs[0]).toMatchObject({ status: 'cancelled', status_code: 'user_cancelled' });
    const again = call('POST', { companyId: ORG, id: runId });
    await cancelRunSessionHandler(again.req, again.res, deps(db));
    expect(again.res._status).toBe(409);
  });
  it('resume: a running run -> 409 RUN_NOT_RESUMABLE; a paused one -> 200 with its position', async () => {
    const { db, runId } = await started();
    const r1 = call('POST', { companyId: ORG, id: runId });
    await resumeRunHandler(r1.req, r1.res, deps(db));
    expect(r1.res._status).toBe(409);
    Object.assign(db.t.salesnav_extraction_runs[0], { status: 'paused_daily_cap', status_code: 'daily_cap', next_page_index: 3 });
    const r2 = call('POST', { companyId: ORG, id: runId });
    await resumeRunHandler(r2.req, r2.res, deps(db));
    expect(r2.res._status).toBe(200);
    expect(r2.res._json).toEqual({ resumed: true, nextPageIndex: 3 });
  });
});
