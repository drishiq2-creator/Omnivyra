/**
 * The Sales Navigator contract store (073/074) against an in-memory fake that enforces the SAME keys as the
 * migration: owner PK member_id (23505), binding PK (company, user, transport) (23505) + composite FK to the owner
 * (23503), one open run per member (23505).
 * The real-schema suites prove the constraints themselves; this proves the store's decisions on top of them, and
 * that every unreadable answer fails closed.
 */
import {
  bindSalesNavMember, boundMember, closeSalesNavRun, loadRun, pauseSalesNavRun, recordSalesNavPage,
  reserveSalesNavQuota, resumeSalesNavRun, startSalesNavRun, toRunStatusView, type SalesNavStoreDeps,
} from '../../services/salesNav/store';

const A = { organizationId: 'org-a', initiatedBy: 'user-a' };
const B = { organizationId: 'org-b', initiatedBy: 'user-b' };
const M1 = 'ACoAAAstoreTest00001';
const M2 = 'ACoAAAstoreTest00002';
const LIST = 'https://www.linkedin.com/sales/lists/people/123';
const OPEN = ['queued', 'running', 'paused_daily_cap', 'auth_expired'];

type Row = Record<string, any>;
function fakeDb(opts: { failTable?: string; failOp?: string } = {}) {
  const t: Record<string, Row[]> = { salesnav_member_owner: [], salesnav_member_bindings: [], salesnav_extraction_runs: [] };
  let seq = 0;
  const violation = (name: string, row: Row): string | null => {
    if (name === 'salesnav_member_owner' && t[name].some((r) => r.member_id === row.member_id)) return '23505';
    if (name === 'salesnav_member_bindings') {
      if (!t.salesnav_member_owner.some((o) => o.member_id === row.member_id && o.organization_id === row.organization_id)) return '23503';
      if (t[name].some((r) => r !== row && r.organization_id === row.organization_id && r.user_id === row.user_id
        && r.transport === row.transport)) return '23505';
    }
    if (name === 'salesnav_extraction_runs' && OPEN.includes(row.status)
      && t[name].some((r) => r.member_id === row.member_id && OPEN.includes(r.status) && r.id !== row.id)) return '23505';
    return null;
  };
  const table = (name: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
    let payload: Row | null = null; let returning = false; let limitN = Infinity;
    const b: any = {
      select: (_c?: string) => { if (op === 'insert') returning = true; return b; },
      insert: (row: Row) => { op = 'insert'; payload = row; return b; },
      upsert: (row: Row) => { op = 'upsert'; payload = row; return b; },
      update: (patch: Row) => { op = 'update'; payload = patch; return b; },
      delete: () => { op = 'delete'; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return b; },
      lt: (c: string, v: string) => { filters.push((r) => String(r[c]) < v); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
      order: () => b,
      limit: (n: number) => { limitN = n; return b; },
      then: (res: (v: unknown) => void) => res(run()),
    };
    const run = () => {
      if (opts.failTable === name && (!opts.failOp || opts.failOp === op)) return { data: null, error: { message: 'down' }, status: 500 };
      const rows = t[name];
      const match = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'select') return { data: match.slice(0, limitN).map((r) => ({ ...r })), error: null, status: 200 };
      if (op === 'insert') {
        const row: Row = { id: `run-${++seq}`, status: 'running', next_page_index: 0, pages_read: 0, leads_read: 0,
          accepted: 0, rejected: 0, created_count: 0, updated_count: 0, held_for_review: 0, skipped_duplicates: 0,
          dropped: 0, quota_refused: 0, seen_lead_keys: [], list_total: null, total_unreliable: false,
          last_has_next_page: null, status_code: null, vendor_cursor: null, closed_at: null, ...payload };
        if (name !== 'salesnav_extraction_runs') delete row.id;
        const v = violation(name, row);
        if (v) return { data: null, error: { code: v }, status: 409 };
        rows.push(row);
        return { data: returning ? [{ id: row.id }] : null, error: null, status: 201 };
      }
      if (op === 'upsert') {
        const v = violation(name, payload!);
        if (v) return { data: null, error: { code: v }, status: 409 };
        const i = rows.findIndex((r) => r.organization_id === payload!.organization_id && r.transport === payload!.transport);
        if (i >= 0) rows[i] = { ...rows[i], ...payload }; else rows.push({ ...payload });
        return { data: null, error: null, status: 201 };
      }
      if (op === 'update') {
        for (const r of match) {
          const next = { ...r, ...payload };
          const v = violation(name, next);
          if (v) return { data: null, error: { code: v }, status: 409, count: null };
          Object.assign(r, payload);
        }
        return { data: null, error: null, status: 204, count: match.length };
      }
      t[name] = rows.filter((r) => !match.includes(r));
      return { data: null, error: null, status: 204 };
    };
    return b;
  };
  return { t, table };
}

const NOW = new Date('2026-11-21T12:00:00Z');
const deps = (db: ReturnType<typeof fakeDb>, extra: Partial<SalesNavStoreDeps> = {}): SalesNavStoreDeps =>
  ({ table: db.table, now: () => NOW, ...extra });

describe('bindSalesNavMember: one company per member, one member per (company, user, transport)', () => {
  const A2 = { organizationId: 'org-a', initiatedBy: 'user-a2' };

  it('binds, and a SECOND company is refused with a clear reason', async () => {
    const db = fakeDb();
    expect(await bindSalesNavMember(A, 'unipile', M1, deps(db))).toEqual({ bound: true });
    expect(await bindSalesNavMember(B, 'unipile', M1, deps(db))).toEqual({ bound: false, reason: 'member_owned_by_another_company' });
    expect(db.t.salesnav_member_bindings.filter((r) => r.organization_id === 'org-b')).toHaveLength(0);
  });

  it('control: the SAME user binds the same member on another transport; re-binding the same member is a no-op', async () => {
    const db = fakeDb();
    await bindSalesNavMember(A, 'unipile', M1, deps(db));
    expect(await bindSalesNavMember(A, 'extension', `urn:li:fsd_profile:${M1}`, deps(db))).toEqual({ bound: true });
    expect(await bindSalesNavMember(A, 'extension', M1, deps(db))).toEqual({ bound: true });
    expect(db.t.salesnav_member_bindings).toHaveLength(2);
  });

  it('a DIFFERENT member for the same (company, user, transport) is account_binding_conflict - never replaced', async () => {
    const db = fakeDb();
    await bindSalesNavMember(A, 'extension', M1, deps(db));
    expect(await bindSalesNavMember(A, 'extension', M2, deps(db))).toEqual({ bound: false, reason: 'account_binding_conflict' });
    expect(db.t.salesnav_member_bindings.map((r) => r.member_id)).toEqual([M1]);
    expect(db.t.salesnav_member_owner.map((r) => r.member_id)).toEqual([M1]);   // M2 never claimed
  });

  it('control: two USERS of one company each bind their own seat on the same transport', async () => {
    const db = fakeDb();
    expect(await bindSalesNavMember(A, 'extension', M1, deps(db))).toEqual({ bound: true });
    expect(await bindSalesNavMember(A2, 'extension', M2, deps(db))).toEqual({ bound: true });
  });

  it('a concurrent bind that loses the binding insert reports the conflict and gives back the ownership it claimed', async () => {
    const db = fakeDb();
    const racing = { ...deps(db), table: (n: string) => {
      const b = db.table(n);
      if (n === 'salesnav_member_bindings') {
        const realInsert = b.insert;
        b.insert = (row: Record<string, unknown>) => {      // another request bound (company, user, transport) first
          db.t.salesnav_member_owner.push({ member_id: M1, organization_id: 'org-a' });
          db.t.salesnav_member_bindings.push({ organization_id: 'org-a', user_id: 'user-a', transport: 'extension', member_id: M1 });
          return realInsert(row);
        };
      }
      return b;
    } };
    expect(await bindSalesNavMember(A, 'extension', M2, racing)).toEqual({ bound: false, reason: 'account_binding_conflict' });
    expect(db.t.salesnav_member_owner.map((r) => r.member_id)).toEqual([M1]);   // M2's claim released
  });

  it('no user (a system continuation) cannot bind', async () => {
    expect(await bindSalesNavMember({ organizationId: 'org-a', initiatedBy: null }, 'extension', M1, deps(fakeDb())))
      .toEqual({ bound: false, reason: 'no_user' });
  });

  it('a non-canonical id is member_unresolved and writes nothing', async () => {
    const db = fakeDb();
    expect(await bindSalesNavMember(A, 'unipile', 'Ada Lovelace', deps(db))).toEqual({ bound: false, reason: 'member_unresolved' });
    expect(db.t.salesnav_member_owner).toHaveLength(0);
  });

  it('a bindings-table failure is store_unreadable, never bound', async () => {
    const db = fakeDb({ failTable: 'salesnav_member_bindings' });
    expect(await bindSalesNavMember(A, 'unipile', M1, deps(db))).toEqual({ bound: false, reason: 'store_unreadable' });
    expect(db.t.salesnav_member_owner).toHaveLength(0);
  });

  it('an owner-table failure is store_unreadable, never bound', async () => {
    const db = fakeDb({ failTable: 'salesnav_member_owner' });
    expect(await bindSalesNavMember(A, 'unipile', M1, deps(db))).toEqual({ bound: false, reason: 'store_unreadable' });
  });
});

describe('runs', () => {
  async function started(db = fakeDb()) {
    await bindSalesNavMember(A, 'unipile', M1, deps(db));
    const r = await startSalesNavRun(A, { transport: 'unipile', url: LIST }, deps(db));
    if (!('runId' in r)) throw new Error(`not started: ${JSON.stringify(r)}`);
    return { db, runId: r.runId };
  }
  const page = (pageIndex: number, keys: string[], hasNextPage: boolean | null = true) =>
    ({ pageIndex, outcome: 'ok' as const, hasNextPage, listTotal: 60, leadKeys: keys });

  it('start uses the STARTING USER\'s member: another user of the company with no binding is member_unresolved', async () => {
    const db = fakeDb();
    await bindSalesNavMember(A, 'unipile', M1, deps(db));
    expect(await startSalesNavRun({ organizationId: 'org-a', initiatedBy: 'user-a2' }, { transport: 'unipile', url: LIST }, deps(db)))
      .toEqual({ refused: 'member_unresolved' });
    expect(await startSalesNavRun(A, { transport: 'unipile', url: LIST }, deps(db))).toMatchObject({ memberId: M1 });
  });

  it('start refuses a non-Sales-Navigator URL, an unbound member, and a second open run', async () => {
    const db = fakeDb();
    expect(await startSalesNavRun(A, { transport: 'unipile', url: 'https://example.com' }, deps(db))).toEqual({ refused: 'not_linkedin' });
    expect(await startSalesNavRun(A, { transport: 'unipile', url: LIST }, deps(db))).toEqual({ refused: 'member_unresolved' });
    await bindSalesNavMember(A, 'unipile', M1, deps(db));
    expect(await startSalesNavRun(A, { transport: 'unipile', url: LIST }, deps(db))).toMatchObject({ kind: 'lead_list' });
    expect(await startSalesNavRun(A, { transport: 'unipile', url: LIST }, deps(db))).toEqual({ refused: 'run_already_open' });
  });

  it('the run records its handoff holder: browser routes hold their own run, API routes none', async () => {
    const db = fakeDb();
    await bindSalesNavMember(A, 'unipile', M1, deps(db));
    await bindSalesNavMember(A, 'extension', M2, deps(db));
    await startSalesNavRun(A, { transport: 'unipile', url: LIST }, deps(db));
    await startSalesNavRun(A, { transport: 'extension', url: LIST }, deps(db));
    expect(db.t.salesnav_extraction_runs.map((r) => [r.transport, r.active_route]))
      .toEqual([['unipile', null], ['extension', 'extension']]);
  });

  it('a STALE running run is closed unknown/run_stale and frees the slot; a fresh one does not', async () => {
    const { db, runId } = await started();
    db.t.salesnav_extraction_runs[0].last_activity_at = new Date(NOW.getTime() - 121_000).toISOString();
    const second = await startSalesNavRun(A, { transport: 'unipile', url: LIST }, deps(db));
    expect(second).toMatchObject({ kind: 'lead_list' });
    expect(db.t.salesnav_extraction_runs.find((r) => r.id === runId)).toMatchObject({ status: 'unknown', status_code: 'run_stale' });
  });

  it('records pages in order, joins the seen keys, and completes on no next page', async () => {
    const { db, runId } = await started();
    expect(await recordSalesNavPage(A, { runId, ...page(0, ['k1', 'k2', 'k3']) }, deps(db))).toEqual({ recorded: true, closed: null });
    expect(await recordSalesNavPage(A, { runId, ...page(1, ['k4', 'k5'], false) }, deps(db)))
      .toEqual({ recorded: true, closed: { status: 'completed', code: 'no_next_page' } });
    expect(db.t.salesnav_extraction_runs[0]).toMatchObject({ next_page_index: 2, pages_read: 2, list_total: 60,
      seen_lead_keys: ['k1', 'k2', 'k3', 'k4', 'k5'] });
  });

  it('a page at the WRONG position ends the run unknown/page_position_mismatch', async () => {
    const { db, runId } = await started();
    expect(await recordSalesNavPage(A, { runId, ...page(1, ['k1']) }, deps(db)))
      .toEqual({ recorded: true, closed: { status: 'unknown', code: 'page_position_mismatch' } });
  });

  it('a REPEATED page (>=3 and >=80% already seen) ends the run unknown/page_repeated', async () => {
    const { db, runId } = await started();
    await recordSalesNavPage(A, { runId, ...page(0, ['k1', 'k2', 'k3', 'k4']) }, deps(db));
    // 4 of 5 = 80%: exactly on the threshold (3 of 4 = 75% would NOT be a repeat)
    expect(await recordSalesNavPage(A, { runId, ...page(1, ['k1', 'k2', 'k3', 'k4', 'k9']) }, deps(db)))
      .toEqual({ recorded: true, closed: { status: 'unknown', code: 'page_repeated' } });
  });

  it('control: a page with a small overlap continues', async () => {
    const { db, runId } = await started();
    await recordSalesNavPage(A, { runId, ...page(0, ['k1', 'k2', 'k3', 'k4']) }, deps(db));
    expect(await recordSalesNavPage(A, { runId, ...page(1, ['k1', 'k7', 'k8', 'k9']) }, deps(db))).toEqual({ recorded: true, closed: null });
  });

  it('an empty first page with no next page is completed/empty_first_page', async () => {
    const { db, runId } = await started();
    expect(await recordSalesNavPage(A, { runId, ...page(0, [], false) }, deps(db)))
      .toEqual({ recorded: true, closed: { status: 'completed', code: 'empty_first_page' } });
  });

  it('an unknown page ends the run unknown with its allowed code; an invented code becomes page_unconfirmed', async () => {
    const one = await started();
    expect(await recordSalesNavPage(A, { runId: one.runId, pageIndex: 0, outcome: 'unknown', hasNextPage: null,
      listTotal: null, leadKeys: [], unknownCode: 'response_lost' }, deps(one.db)))
      .toEqual({ recorded: true, closed: { status: 'unknown', code: 'response_lost' } });
    const two = await started();
    expect(await recordSalesNavPage(A, { runId: two.runId, pageIndex: 0, outcome: 'unknown', hasNextPage: null,
      listTotal: null, leadKeys: [], unknownCode: 'made_up' }, deps(two.db)))
      .toEqual({ recorded: true, closed: { status: 'unknown', code: 'page_unconfirmed' } });
  });

  it('ANOTHER company cannot load, record, pause, resume or close the run', async () => {
    const { db, runId } = await started();
    expect(await loadRun('org-b', runId, deps(db))).toBeNull();
    expect(await recordSalesNavPage(B, { runId, ...page(0, ['k1']) }, deps(db))).toEqual({ recorded: false, reason: 'run_not_found' });
    expect(await pauseSalesNavRun(B, { runId, status: 'paused_daily_cap', code: 'daily_cap' }, deps(db))).toBe('not_in_expected_state');
    expect(await closeSalesNavRun(B, { runId, status: 'cancelled', code: 'user_cancelled' }, deps(db))).toBe('not_in_expected_state');
    expect(db.t.salesnav_extraction_runs[0].status).toBe('running');
  });

  it('pause -> resume keeps the position; resume after the member is unbound is refused', async () => {
    const { db, runId } = await started();
    await recordSalesNavPage(A, { runId, ...page(0, ['k1']) }, deps(db));
    expect(await pauseSalesNavRun(A, { runId, status: 'paused_daily_cap', code: 'daily_cap' }, deps(db))).toBe('ok');
    expect(await resumeSalesNavRun(A, { runId }, deps(db))).toEqual({ resumed: true, nextPageIndex: 1 });
    expect(await pauseSalesNavRun(A, { runId, status: 'auth_expired', code: 'checkpoint' }, deps(db))).toBe('ok');
    db.t.salesnav_member_bindings.length = 0;
    expect(await resumeSalesNavRun(A, { runId }, deps(db))).toEqual({ resumed: false, reason: 'member_not_bound' });
  });

  it('pause and close accept only contract pairs', async () => {
    const { db, runId } = await started();
    expect(await pauseSalesNavRun(A, { runId, status: 'paused_daily_cap', code: 'logged_out' }, deps(db))).toBe('code_not_allowed');
    expect(await closeSalesNavRun(A, { runId, status: 'completed', code: 'daily_cap' }, deps(db))).toBe('code_not_allowed');
    expect(await closeSalesNavRun(A, { runId, status: 'cancelled', code: 'user_cancelled' }, deps(db))).toBe('ok');
    expect(db.t.salesnav_extraction_runs[0]).toMatchObject({ status: 'cancelled', closed_at: NOW.toISOString() });
  });

  it('the vendor cursor is stored for API transports and NEVER appears in the status view', async () => {
    const { db, runId } = await started();
    await recordSalesNavPage(A, { runId, ...page(0, ['k1']), vendorCursor: 'SECRET-CURSOR' }, deps(db));
    expect(db.t.salesnav_extraction_runs[0].vendor_cursor).toBe('SECRET-CURSOR');
    const run = await loadRun('org-a', runId, deps(db));
    const view = toRunStatusView({ ...(run as any), vendor_cursor: 'SECRET-CURSOR' }, NOW);
    expect(JSON.stringify(view)).not.toContain('SECRET-CURSOR');
    expect(JSON.stringify(view)).not.toContain(M1);           // nor the member id
    expect(JSON.stringify(view)).not.toContain('k1');         // nor the seen keys
  });

  it('the status view shows a stale running run as unknown/run_stale', async () => {
    const { db, runId } = await started();
    const run = await loadRun('org-a', runId, deps(db)) as any;
    expect(toRunStatusView({ ...run, last_activity_at: '2026-11-21T11:00:00Z' }, NOW)).toMatchObject({ status: 'unknown', code: 'run_stale' });
  });

  it('a runs-table read failure is store_unreadable, never "not found"', async () => {
    const { db, runId } = await started();
    const broken = { ...deps(db), table: (n: string) => (n === 'salesnav_extraction_runs' ? fakeDb({ failTable: n }).table(n) : db.table(n)) };
    expect(await recordSalesNavPage(A, { runId, ...page(0, ['k1']) }, broken)).toEqual({ recorded: false, reason: 'store_unreadable' });
    expect(await boundMember('org-a', 'user-a', 'unipile', { table: fakeDb({ failTable: 'salesnav_member_bindings' }).table })).toBe('unreadable');
  });
});

describe('reserveSalesNavQuota: fails closed', () => {
  const rpcAnswering = (rows: unknown[]) => jest.fn(async () => ({ data: rows, error: null, status: 200 }));
  async function bound() { const db = fakeDb(); await bindSalesNavMember(A, 'unipile', M1, deps(db)); return db; }

  it('grants what the database grants, with the company, member, UTC day and default cap 150', async () => {
    const db = await bound();
    const rpc = rpcAnswering([{ granted: 25, consumed: 25, remaining: 125 }]);
    expect(await reserveSalesNavQuota(A, { linkedinMemberId: M1, transport: 'unipile', requested: 25 }, deps(db, { rpc })))
      .toEqual({ granted: 25, remaining: 125 });
    expect(rpc).toHaveBeenCalledWith('salesnav_consume_daily_quota',
      { p_organization_id: 'org-a', p_member_id: M1, p_usage_day: '2026-11-21', p_count: 25, p_cap: 150 });
  });

  it('a refusal with some remaining retries ONCE with exactly the remaining', async () => {
    const db = await bound();
    const rpc = jest.fn()
      .mockResolvedValueOnce({ data: [{ granted: 0, consumed: 140, remaining: 10 }], error: null, status: 200 })
      .mockResolvedValueOnce({ data: [{ granted: 10, consumed: 150, remaining: 0 }], error: null, status: 200 });
    expect(await reserveSalesNavQuota(A, { linkedinMemberId: M1, transport: 'unipile', requested: 25 }, deps(db, { rpc })))
      .toEqual({ granted: 10, remaining: 0 });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect((rpc.mock.calls[1] as any[])[1].p_count).toBe(10);
  });

  it('control: at the cap (remaining 0) it does NOT retry', async () => {
    const db = await bound();
    const rpc = rpcAnswering([{ granted: 0, consumed: 150, remaining: 0 }]);
    expect(await reserveSalesNavQuota(A, { linkedinMemberId: M1, transport: 'unipile', requested: 25 }, deps(db, { rpc })))
      .toEqual({ granted: 0, remaining: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an rpc error', { data: null, error: { message: 'x' }, status: 500 }],
    ['a blank 204 (not an answer)', { data: null, error: null, status: 204 }],
    ['a malformed row', { data: [{ granted: 'lots' }], error: null, status: 200 }],
  ])('%s grants 0', async (_l, result) => {
    const db = await bound();
    expect(await reserveSalesNavQuota(A, { linkedinMemberId: M1, transport: 'unipile', requested: 5 },
      deps(db, { rpc: async () => result }))).toEqual({ granted: 0, remaining: 0 });
  });

  it('a member that is NOT the company\'s bound member for the transport grants 0 without calling the database', async () => {
    const db = await bound();
    const rpc = rpcAnswering([{ granted: 5, consumed: 5, remaining: 145 }]);
    expect(await reserveSalesNavQuota(A, { linkedinMemberId: M2, transport: 'unipile', requested: 5 }, deps(db, { rpc }))).toEqual({ granted: 0, remaining: 0 });
    expect(await reserveSalesNavQuota(A, { linkedinMemberId: M1, transport: 'rpa', requested: 5 }, deps(db, { rpc }))).toEqual({ granted: 0, remaining: 0 });
    expect(await reserveSalesNavQuota(B, { linkedinMemberId: M1, transport: 'unipile', requested: 5 }, deps(db, { rpc }))).toEqual({ granted: 0, remaining: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });
});
