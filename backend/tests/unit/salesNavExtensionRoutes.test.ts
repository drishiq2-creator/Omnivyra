/**
 * Sales Navigator route contract v0.3, GROUP B (the extension's routes), over the shared fake 073 store, a fake 074
 * consume (rpc), and doubled screen / ingest. Proves the server-held loop: the signed /next 'read' answer, the
 * reservation (consume-on-reserve, idempotent per page, cb's double-spend case), /pages ingesting at most the grant
 * and never without a reservation, the closed outcome mapping (a9 v0.2) and the member / reader-version refusals.
 */
import {
  bindHandler, cancelRunExtensionHandler, closeHandler, nextHandler, openRunHandler, pagesHandler, pauseHandler,
  statusHandler, type SalesNavExtensionDeps,
} from '../../apiHandlers/salesNav/extensionRoutes';
import { verifyNextEnvelope } from '../../services/salesNav/nextEnvelope';
import { bindSalesNavMember, startSalesNavRun } from '../../services/salesNav/store';
import { fakeDb } from '../helpers/salesNavFakeDb';

const ORG = 'org-a';
const USER = 'user-a';
const M1 = 'ACoAAAextTest000001';
const URN = `urn:li:fsd_profile:${M1}`;
const LIST = 'https://www.linkedin.com/sales/lists/people/123';
const SECRET = 'test-only-session-secret';
const NOW = new Date('2026-11-21T12:00:00Z');

function call(body: unknown, query: Record<string, string> = {}) {
  const res: any = { _status: 0, _json: undefined as any, _headers: {} as Record<string, string> };
  res.status = (c: number) => { res._status = c; return res; };
  res.json = (b: unknown) => { res._json = b; return res; };
  res.setHeader = (k: string, v: string) => { res._headers[k] = v; };
  return { req: { method: 'POST', query, body } as any, res };
}
const lead = (k: string, extra: Record<string, unknown> = {}) => ({ lead_key: k, full_name: `Lead ${k}`, ...extra });

function env(opts: { granted?: number; gate?: boolean } = {}) {
  const db = fakeDb();
  const rpc = jest.fn(async (_fn: string, args: any) => {
    const g = Math.min(args.p_count, opts.granted ?? 25);
    return { data: [{ granted: g, consumed: g, remaining: 150 - g }], error: null, status: 200 };
  });
  const ingest = jest.fn(async ({ records }: any) => ({
    organizationId: ORG, source: 's', total: records.length, succeeded: records.length, failed: 0,
    outcomes: records.map(() => ({ externalId: 'x', ok: true, provenanceOutcome: 'created' })),
  }));
  const screen = jest.fn(async ({ records }: any) => ({ toIngest: records, skippedDuplicates: 0, heldForReview: 0, probeUnknown: 0 }));
  const deps: SalesNavExtensionDeps = {
    auth: async () => ({ session: { userId: USER, orgId: ORG, expiresAt: 9e12, hmacNonce: 'n' } }),
    gate: async () => ({ allowed: opts.gate ?? true, reason: opts.gate === false ? 'tenant_flag_off:salesnav_extraction' : 'cleared' }),
    store: { table: db.table, rpc, now: () => NOW },
    screen: screen as never,
    ingest: ingest as never,
    secretFor: () => SECRET,
    now: () => NOW,
  };
  return { db, rpc, ingest, screen, deps };
}
async function withRun(opts: { granted?: number; gate?: boolean } = {}) {
  const e = env(opts);
  const st = { table: e.db.table, now: () => NOW };
  await bindSalesNavMember({ organizationId: ORG, initiatedBy: USER }, 'extension', M1, st);
  const r = await startSalesNavRun({ organizationId: ORG, initiatedBy: USER }, { transport: 'extension', url: LIST }, st);
  if (!('runId' in r)) throw new Error('no run');
  return { ...e, runId: r.runId };
}
const run0 = (db: ReturnType<typeof fakeDb>) => db.t.salesnav_extraction_runs[0];

describe('POST /bind', () => {
  it('binds the session user; another company is refused; a different member is a conflict', async () => {
    const e = env();
    const ok = call({ memberId: URN });
    await bindHandler(ok.req, ok.res, e.deps);
    expect(ok.res._json).toEqual({ bound: true });
    const conflict = call({ memberId: 'urn:li:fsd_profile:ACoAAAextTest000002' });
    await bindHandler(conflict.req, conflict.res, e.deps);
    expect(conflict.res._status).toBe(409);
    expect(conflict.res._json.error).toBe('ACCOUNT_BINDING_CONFLICT');
    const other = call({ memberId: URN });
    await bindHandler(other.req, other.res, { ...e.deps, auth: async () => ({ session: { userId: 'u-b', orgId: 'org-b', expiresAt: 9e12 } }) });
    expect(other.res._json.error).toBe('MEMBER_OWNED_BY_ANOTHER_COMPANY');
  });
  it('a non-canonical id -> 422; a GET -> 405', async () => {
    const e = env();
    const bad = call({ memberId: 'Ada Lovelace' });
    await bindHandler(bad.req, bad.res, e.deps);
    expect(bad.res._status).toBe(422);
    const g = call({}); g.req.method = 'GET';
    await bindHandler(g.req, g.res, e.deps);
    expect(g.res._status).toBe(405);
  });
});

describe('POST /runs/open and /status', () => {
  it('open: the run with its canonicalUrl (the list pin) - never the member id', async () => {
    const e = await withRun();
    const { req, res } = call({});
    await openRunHandler(req, res, e.deps);
    expect(res._json).toMatchObject({ runId: e.runId, transport: 'extension', urlKind: 'lead_list', canonicalUrl: LIST, status: 'running', nextPageIndex: 0 });
    expect(JSON.stringify(res._json)).not.toContain(M1);
  });
  it('open: no binding -> { run: null }', async () => {
    const { req, res } = call({});
    await openRunHandler(req, res, env().deps);
    expect(res._json).toEqual({ run: null });
  });
  it('status: remaining_today = cap - consumed today; an unreadable quota is null, never a full cap', async () => {
    const e = await withRun();
    e.db.t.salesnav_daily_quota.push({ member_id: M1, usage_day: '2026-11-21', consumed: 40 });
    const { req, res } = call({});
    await statusHandler(req, res, e.deps);
    expect(res._json).toMatchObject({ enabled: true, bound: true, remaining_today: 110, cap: 150, run: { status: 'running' } });
    const broken = env();
    await bindSalesNavMember({ organizationId: ORG, initiatedBy: USER }, 'extension', M1, { table: broken.db.table });
    const failing = { ...broken.deps, store: { ...broken.deps.store, table: (n: string) => (n === 'salesnav_daily_quota' ? fakeDb({ failTable: n }).table(n) : broken.db.table(n)) } };
    const r2 = call({});
    await statusHandler(r2.req, r2.res, failing);
    expect(r2.res._json.remaining_today).toBeNull();
  });
});

describe('POST /runs/:id/next - the server decides, the answer is signed', () => {
  it('reserves BEFORE the read and answers a SIGNED read command for the run\'s own list position', async () => {
    const e = await withRun();
    const { req, res } = call({ attestedMemberId: URN }, { id: e.runId });
    await nextHandler(req, res, e.deps);
    expect(res._json).toMatchObject({ command: 'read', pageIndex: 0, pageUrl: LIST, maxLeads: 25, position: { param: 'page', value: '1' } });
    expect(verifyNextEnvelope(res._json.envelope, res._json.envelope_signature, SECRET)).toBe(true);
    expect(res._json.envelope).toMatchObject({ run_id: e.runId, page_index: 0, member: URN, max_leads: 25 });
    expect(e.rpc).toHaveBeenCalledTimes(1);
    expect(run0(e.db)).toMatchObject({ pending_page_index: 0, pending_granted: 25 });
  });
  it('IDEMPOTENT per page: a second /next re-issues the same command and does NOT consume again', async () => {
    const e = await withRun();
    for (let i = 0; i < 2; i += 1) {
      const { req, res } = call({ attestedMemberId: URN }, { id: e.runId });
      await nextHandler(req, res, e.deps);
      expect(res._json).toMatchObject({ command: 'read', pageIndex: 0, maxLeads: 25 });
    }
    expect(e.rpc).toHaveBeenCalledTimes(1);
  });
  it('the quota granting 0 -> paused_daily_cap with resumesAt the next UTC midnight', async () => {
    const e = await withRun({ granted: 0 });
    const { req, res } = call({ attestedMemberId: URN }, { id: e.runId });
    await nextHandler(req, res, e.deps);
    expect(res._json).toEqual({ command: 'paused', status: 'paused_daily_cap', code: 'daily_cap', resumesAt: '2026-11-22T00:00:00.000Z' });
    expect(run0(e.db)).toMatchObject({ status: 'paused_daily_cap', pending_page_index: null });
  });
  it('a DIFFERENT logged-in member -> stop refused/member_mismatch, and the run is closed', async () => {
    const e = await withRun();
    const { req, res } = call({ attestedMemberId: 'urn:li:fsd_profile:ACoAAAextTest000099' }, { id: e.runId });
    await nextHandler(req, res, e.deps);
    expect(res._json).toEqual({ command: 'stop', status: 'refused', code: 'member_mismatch' });
    expect(run0(e.db)).toMatchObject({ status: 'refused', status_code: 'member_mismatch' });
    expect(e.rpc).not.toHaveBeenCalled();
  });
  it('a gate closed mid-run -> stop refused/gate_closed, nothing consumed', async () => {
    const e = await withRun({ gate: false });
    const { req, res } = call({ attestedMemberId: URN }, { id: e.runId });
    await nextHandler(req, res, e.deps);
    expect(res._json).toMatchObject({ command: 'stop', code: 'gate_closed' });
    expect(e.rpc).not.toHaveBeenCalled();
  });
  it('cb DOUBLE-SPEND case: the mark fails after a granted consume -> 503 naming the spent cap; a retry consumes AGAIN, and at most one page is ingested', async () => {
    const e = await withRun();
    let failMark = true;
    const table = (n: string) => {
      const b = e.db.table(n);
      if (n === 'salesnav_extraction_runs' && failMark) {
        const upd = b.update;
        b.update = (patch: any, o?: any) => (patch && 'pending_granted' in patch && patch.pending_granted !== null
          ? { ...b, eq: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ is: async () => ({ error: { message: 'down' }, count: null }) }) }) }) }) }
          : upd(patch, o));
      }
      return b;
    };
    const failing = { ...e.deps, store: { ...e.deps.store, table } };
    const first = call({ attestedMemberId: URN }, { id: e.runId });
    await nextHandler(first.req, first.res, failing);
    expect(first.res._status).toBe(503);
    expect(first.res._json).toEqual({ error: 'RESERVATION_NOT_RECORDED', capConsumed: 25 });
    failMark = false;
    const retry = call({ attestedMemberId: URN }, { id: e.runId });
    await nextHandler(retry.req, retry.res, failing);
    expect(retry.res._json.command).toBe('read');
    expect(e.rpc).toHaveBeenCalledTimes(2);                   // two consumes for one page: the owner-ruled direction
    const page = call({ pageIndex: 0, finalUrl: LIST, outcome: 'ok', hasNextPage: true, listTotal: 60, reader_version: 'snr-1',
      attestedMemberId: URN, leads: Array.from({ length: 30 }, (_, i) => lead(`key00000${String(i).padStart(2, '0')}`)) }, { id: e.runId });
    await pagesHandler(page.req, page.res, failing);
    expect(e.ingest.mock.calls[0][0].records).toHaveLength(25);  // never more than ONE page's grant
  });
  it('a paused run answers paused; a closed one answers stop', async () => {
    const e = await withRun();
    Object.assign(run0(e.db), { status: 'auth_expired', status_code: 'checkpoint' });
    const p = call({ attestedMemberId: URN }, { id: e.runId });
    await nextHandler(p.req, p.res, e.deps);
    expect(p.res._json).toEqual({ command: 'paused', status: 'auth_expired', code: 'checkpoint' });
    Object.assign(run0(e.db), { status: 'completed', status_code: 'no_next_page', closed_at: 'x' });
    const s = call({ attestedMemberId: URN }, { id: e.runId });
    await nextHandler(s.req, s.res, e.deps);
    expect(s.res._json).toEqual({ command: 'stop', status: 'completed', code: 'no_next_page' });
  });
});

describe('POST /runs/:id/pages', () => {
  async function reserved(opts: { granted?: number } = {}) {
    const e = await withRun(opts);
    const n = call({ attestedMemberId: URN }, { id: e.runId });
    await nextHandler(n.req, n.res, e.deps);
    return e;
  }
  const page = (runId: string, over: Record<string, unknown> = {}) => call({
    pageIndex: 0, finalUrl: LIST, outcome: 'ok', hasNextPage: true, listTotal: 60, reader_version: 'snr-1',
    attestedMemberId: URN, leads: [lead('keyA00001'), lead('keyA00002')], ...over,
  }, { id: runId });

  it('ingests the page, records counts, clears the reservation and advances the position', async () => {
    const e = await reserved();
    const { req, res } = page(e.runId);
    await pagesHandler(req, res, e.deps);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ accepted: 2, created: 2, quotaRefused: 0, rejected: 0 });
    expect(run0(e.db)).toMatchObject({ next_page_index: 1, pending_page_index: null, pending_granted: null, created_count: 2, leads_read: 2 });
    expect(e.ingest.mock.calls[0][0]).toMatchObject({ organizationId: ORG, source: 'linkedin_sales_navigator', ingestionRunId: e.runId });
  });
  it('WITHOUT a reservation -> 409 NO_RESERVATION and NOTHING is ingested', async () => {
    const e = await withRun();
    const { req, res } = page(e.runId);
    await pagesHandler(req, res, e.deps);
    expect(res._status).toBe(409);
    expect(res._json.error).toBe('NO_RESERVATION');
    expect(e.ingest).not.toHaveBeenCalled();
  });
  it('leads beyond the grant are quotaRefused and NOT ingested', async () => {
    const e = await reserved({ granted: 1 });
    const { req, res } = page(e.runId);
    await pagesHandler(req, res, e.deps);
    expect(res._json).toMatchObject({ accepted: 1, quotaRefused: 1 });
    expect(e.ingest.mock.calls[0][0].records).toHaveLength(1);
  });
  it('an outdated reader CLOSES the run refused/reader_version_unsupported (a9: tell the user to update)', async () => {
    const e = await reserved();
    const { req, res } = page(e.runId, { reader_version: 'snr-0' });
    await pagesHandler(req, res, e.deps);
    expect(res._status).toBe(422);
    expect(res._json.error).toBe('READER_VERSION_UNSUPPORTED');
    expect(run0(e.db)).toMatchObject({ status: 'refused', status_code: 'reader_version_unsupported' });
    expect(e.ingest).not.toHaveBeenCalled();
  });
  it('a loaded page that is not the commanded one -> unknown/page_position_mismatch, nothing ingested', async () => {
    const e = await reserved();
    const { req, res } = page(e.runId, { finalUrl: 'https://www.linkedin.com/sales/lists/people/999' });
    await pagesHandler(req, res, e.deps);
    expect(run0(e.db)).toMatchObject({ status: 'unknown', status_code: 'page_position_mismatch' });
    expect(e.ingest).not.toHaveBeenCalled();
  });
  it('an unknown outcome closes the run with its allowed code', async () => {
    const e = await reserved();
    const { req, res } = page(e.runId, { outcome: 'unknown', unknownCode: 'structure_unrecognised', leads: [] });
    await pagesHandler(req, res, e.deps);
    expect(run0(e.db)).toMatchObject({ status: 'unknown', status_code: 'structure_unrecognised' });
  });
  it('a /sales/ URL is never stored (the landed fromWire); a lead already seen in the run is skipped, not re-ingested', async () => {
    const e = await reserved();
    run0(e.db).seen_lead_keys = ['keyA00002'];
    const { req, res } = page(e.runId, { leads: [
      lead('keyA00001', { public_profile_url: 'https://www.linkedin.com/sales/lead/X,NAME_SEARCH,secretAuthToken' }),
      lead('keyA00002'),
    ] });
    await pagesHandler(req, res, e.deps);
    const records = e.ingest.mock.calls[0][0].records;
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('secretAuthToken');
    expect(res._json.skippedDuplicates).toBe(1);
  });
  it('the last page (hasNextPage false) completes the run', async () => {
    const e = await reserved();
    const { req, res } = page(e.runId, { hasNextPage: false });
    await pagesHandler(req, res, e.deps);
    expect(run0(e.db)).toMatchObject({ status: 'completed', status_code: 'no_next_page' });
  });
});

describe('POST /pause, /close, /cancel', () => {
  it('pause: only auth_expired pairs; the daily-cap pause is the server\'s, never a route\'s', async () => {
    const e = await withRun();
    const cap = call({ status: 'paused_daily_cap', code: 'daily_cap' }, { id: e.runId });
    await pauseHandler(cap.req, cap.res, e.deps);
    expect(cap.res._status).toBe(422);
    const ok = call({ status: 'auth_expired', code: 'checkpoint' }, { id: e.runId });
    await pauseHandler(ok.req, ok.res, e.deps);
    expect(ok.res._json).toEqual({ paused: true });
    expect(run0(e.db)).toMatchObject({ status: 'auth_expired', status_code: 'checkpoint' });
  });
  it('close: only the route-reportable pairs (a9 v0.2); anything else -> 422 and the run untouched', async () => {
    const e = await withRun();
    const bad = call({ status: 'completed', code: 'no_next_page' }, { id: e.runId });
    await closeHandler(bad.req, bad.res, e.deps);
    expect(bad.res._status).toBe(422);
    expect(run0(e.db).status).toBe('running');
    const ok = call({ status: 'rate_limited', code: 'site_rate_limit' }, { id: e.runId });
    await closeHandler(ok.req, ok.res, e.deps);
    expect(run0(e.db)).toMatchObject({ status: 'rate_limited', status_code: 'site_rate_limit' });
  });
  it('cancel under extension auth: cancelled/user_cancelled', async () => {
    const e = await withRun();
    const { req, res } = call({}, { id: e.runId });
    await cancelRunExtensionHandler(req, res, e.deps);
    expect(res._json).toEqual({ cancelled: true });
    expect(run0(e.db)).toMatchObject({ status: 'cancelled', status_code: 'user_cancelled' });
  });
  it('another company\'s run -> 404 on every route', async () => {
    const e = await withRun();
    const other = { ...e.deps, auth: async () => ({ session: { userId: 'u-b', orgId: 'org-b', expiresAt: 9e12, hmacNonce: 'n' } }) };
    for (const h of [nextHandler, pagesHandler, pauseHandler, closeHandler, cancelRunExtensionHandler]) {
      const { req, res } = call({ attestedMemberId: URN, status: 'auth_expired', code: 'checkpoint' }, { id: e.runId });
      await h(req, res, other);
      expect(res._status).toBe(404);
    }
    expect(run0(e.db).status).toBe('running');
  });
});
