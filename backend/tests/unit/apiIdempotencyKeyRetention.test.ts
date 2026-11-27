/**
 * purgeExpiredApiIdempotencyKeys — PROPOSAL tests (function is not wired to
 * any job or route; see apiIdempotencyKeyCleaner.ts).
 *
 * Uses a small STATEFUL table double that evaluates the filters the code
 * actually sends (in / lt / order / limit on select; in / lt on delete), so
 * the assertions are about which rows survive, not about the call chain.
 */

jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: jest.fn() },
}));
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: jest.fn(),
}));
jest.mock('../../services/billing/billingAuditEmitter', () => ({
  emitAnomaly: jest.fn(),
}));

import { supabase } from '../../db/supabaseClient';
import { ownedDbTable } from '../../db/writeOwner';
import {
  purgeExpiredApiIdempotencyKeys,
  MIN_API_IDEMPOTENCY_RETENTION_SEC,
} from '../../services/billing/idempotency/apiIdempotencyKeyCleaner';

type Row = {
  id: string;
  scope: string;
  caller_id: string | null;
  idempotency_key: string;
  status: 'processing' | 'completed' | 'failed';
  updated_at: string;
  created_at?: string;
};

type Filter = (r: Row) => boolean;

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const DAY = 24 * 60 * 60;
const RETENTION = 7 * DAY;
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

let store: Row[];
let otherTable: Array<{ id: string }>;
let tablesTouched: string[];
let beforeDelete: (() => void) | null;
let deleteCalls: number;
let deleteError: { message: string } | null;

function builder(table: string) {
  tablesTouched.push(table);
  const rowsOf = (): any[] => (table === 'api_idempotency_keys' ? store : otherTable);
  const filters: Filter[] = [];
  const orders: Array<{ col: keyof Row; asc: boolean }> = [];
  let lim = Infinity;
  let mode: 'select' | 'delete' = 'select';

  const chain: any = {
    in: (col: keyof Row, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return chain; },
    lt: (col: keyof Row, v: string) => { filters.push((r) => String(r[col]) < v); return chain; },
    lte: (col: keyof Row, v: string) => { filters.push((r) => String(r[col]) <= v); return chain; },
    eq: (col: keyof Row, v: unknown) => { filters.push((r) => r[col] === v); return chain; },
    order: (col: keyof Row, o?: { ascending?: boolean }) => { orders.push({ col, asc: o?.ascending !== false }); return chain; },
    limit: (n: number) => { lim = n; return chain; },
    select: () => chain,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      try {
        if (mode === 'delete') {
          deleteCalls += 1;
          if (deleteError) return Promise.resolve({ data: null, error: deleteError }).then(resolve, reject);
          if (beforeDelete) beforeDelete();
          const all = rowsOf();
          const hit = all.filter((r) => filters.every((f) => f(r)));
          const keep = all.filter((r) => !hit.includes(r));
          all.length = 0;
          all.push(...keep);
          return Promise.resolve({ data: hit.map((r) => ({ id: r.id, status: r.status })), error: null }).then(resolve, reject);
        }
        let out = rowsOf().filter((r) => filters.every((f) => f(r)));
        out = [...out].sort((a, b) => {
          for (const o of orders) {
            const x = String(a[o.col]); const y = String(b[o.col]);
            if (x !== y) return (x < y ? -1 : 1) * (o.asc ? 1 : -1);
          }
          return 0;
        });
        return Promise.resolve({ data: out.slice(0, lim).map((r) => ({ ...r })), error: null }).then(resolve, reject);
      } catch (e) {
        return Promise.reject(e).then(resolve, reject);
      }
    },
  };
  return {
    select: () => { mode = 'select'; return chain; },
    delete: () => { mode = 'delete'; return chain; },
  };
}

function row(id: string, status: Row['status'], ageSec: number, extra: Partial<Row> = {}): Row {
  return { id, scope: 'scope-a', caller_id: 'user-1', idempotency_key: `k-${id}`, status, updated_at: ago(ageSec), ...extra };
}

const run = (o: Record<string, unknown> = {}) =>
  purgeExpiredApiIdempotencyKeys({ retentionSec: RETENTION, now: () => NOW, ...o });

const ids = () => store.map((r) => r.id).sort();

describe('purgeExpiredApiIdempotencyKeys (proposal, not wired)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store = [];
    otherTable = [{ id: 'other-1' }];
    tablesTouched = [];
    beforeDelete = null;
    deleteCalls = 0;
    deleteError = null;
    (supabase.from as jest.Mock).mockImplementation(builder);
    (ownedDbTable as jest.Mock).mockImplementation(builder);
  });

  it('is DISABLED without an explicit retention: touches nothing', async () => {
    store = [row('old-c', 'completed', 400 * DAY)];
    const r = await purgeExpiredApiIdempotencyKeys();
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe('retention_not_configured');
    expect(tablesTouched).toEqual([]);
    expect(ids()).toEqual(['old-c']);
  });

  it('refuses a retention below the 24h floor', async () => {
    store = [row('old-c', 'completed', 2 * DAY)];
    const r = await run({ retentionSec: MIN_API_IDEMPOTENCY_RETENTION_SEC - 1 });
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe('retention_below_minimum');
    expect(tablesTouched).toEqual([]);
    expect(ids()).toEqual(['old-c']);
  });

  it('deletes expired terminal rows (completed + failed) and keeps unexpired ones', async () => {
    store = [
      row('old-c', 'completed', RETENTION + 60),
      row('old-f', 'failed', RETENTION + 60),
      row('new-c', 'completed', RETENTION - 60),
      row('new-f', 'failed', 60), // failed within retention
    ];
    const r = await run();
    expect(r.enabled).toBe(true);
    expect(r.deleted).toBe(2);
    expect(r.byStatus).toEqual({ completed: 1, failed: 1 });
    expect(ids()).toEqual(['new-c', 'new-f']);
  });

  it('never deletes processing rows, stale or fresh', async () => {
    store = [
      row('stale-p', 'processing', 365 * DAY),
      row('fresh-p', 'processing', 1),
      row('old-c', 'completed', RETENTION + 1),
    ];
    const r = await run();
    expect(r.scanned).toBe(1);
    expect(r.deleted).toBe(1);
    expect(ids()).toEqual(['fresh-p', 'stale-p']);
  });

  it('concurrent retry: a row re-claimed between scan and delete survives (guarded DELETE)', async () => {
    store = [row('old-f', 'failed', RETENTION + 60), row('old-c', 'completed', RETENTION + 60)];
    beforeDelete = () => {
      // withIdempotency failed-resume path: failed -> processing, updated_at = now
      const f = store.find((x) => x.id === 'old-f')!;
      f.status = 'processing';
      f.updated_at = new Date(NOW).toISOString();
    };
    const r = await run();
    expect(r.scanned).toBe(2);
    expect(r.deleted).toBe(1);
    expect(r.skipped).toBe(1);
    expect(ids()).toEqual(['old-f']);
    expect(store[0].status).toBe('processing');
  });

  it('concurrent completion refresh: a terminal row whose updated_at moved inside the window survives', async () => {
    store = [row('old-f', 'failed', RETENTION + 60)];
    beforeDelete = () => {
      // resumed and finished again: failed -> processing -> completed, fresh updated_at
      store[0].status = 'completed';
      store[0].updated_at = new Date(NOW).toISOString();
    };
    const r = await run();
    expect(r.deleted).toBe(0);
    expect(r.skipped).toBe(1);
    expect(ids()).toEqual(['old-f']);
  });

  it('criteria are caller/scope independent and only api_idempotency_keys is touched', async () => {
    store = [
      row('a-old', 'completed', RETENTION + 60, { scope: 'scope-a', caller_id: 'user-1' }),
      row('b-old', 'completed', RETENTION + 60, { scope: 'scope-b', caller_id: 'user-2' }),
      row('legacy-old', 'completed', RETENTION + 60, { caller_id: null }),
      row('a-new', 'completed', 60, { scope: 'scope-a', caller_id: 'user-1' }),
      row('b-new', 'failed', 60, { scope: 'scope-b', caller_id: 'user-2' }),
    ];
    const r = await run();
    expect(r.deleted).toBe(3);
    expect(ids()).toEqual(['a-new', 'b-new']);
    expect(new Set(tablesTouched)).toEqual(new Set(['api_idempotency_keys']));
    expect(otherTable).toEqual([{ id: 'other-1' }]);
  });

  it('repeated execution is a no-op once drained', async () => {
    store = [row('old-c', 'completed', RETENTION + 60), row('new-c', 'completed', 60)];
    const first = await run();
    expect(first.deleted).toBe(1);
    const second = await run();
    expect(second.scanned).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.errors).toBe(0);
    expect(deleteCalls).toBe(1); // no DELETE issued when nothing qualifies
    expect(ids()).toEqual(['new-c']);
  });

  it('respects the batch bound and deletes oldest-first deterministically', async () => {
    store = [
      row('r3', 'completed', RETENTION + 30),
      row('r1', 'completed', RETENTION + 90),
      row('r2', 'failed', RETENTION + 60),
      row('r4', 'completed', RETENTION + 10),
    ];
    const r = await run({ limit: 2 });
    expect(r.batchLimit).toBe(2);
    expect(r.scanned).toBe(2);
    expect(r.deleted).toBe(2);
    expect(ids()).toEqual(['r3', 'r4']);
  });

  it('clamps an oversized batch to the maximum', async () => {
    const r = await run({ limit: 1_000_000 });
    expect(r.batchLimit).toBe(250);
  });

  it('dry-run counts candidates without deleting', async () => {
    store = [row('old-c', 'completed', RETENTION + 60), row('old-f', 'failed', RETENTION + 60)];
    const r = await run({ dryRun: true });
    expect(r.scanned).toBe(2);
    expect(r.deleted).toBe(0);
    expect(r.byStatus).toEqual({ completed: 1, failed: 1 });
    expect(deleteCalls).toBe(0);
    expect(ids()).toEqual(['old-c', 'old-f']);
  });

  it('a non-finite retention (NaN / Infinity) is treated as not configured', async () => {
    store = [row('old-c', 'completed', 400 * DAY)];
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await run({ retentionSec: bad });
      expect(r.enabled).toBe(false);
      expect(r.reason).toBe('retention_not_configured');
    }
    expect(tablesTouched).toEqual([]);
    expect(ids()).toEqual(['old-c']);
  });

  it('the cutoff is strict: a row whose updated_at equals the cutoff survives', async () => {
    store = [row('at-cutoff', 'completed', RETENTION), row('past-cutoff', 'completed', RETENTION + 1)];
    const r = await run();
    expect(r.deleted).toBe(1);
    expect(ids()).toEqual(['at-cutoff']);
  });

  it('the clock is updated_at (last activity), not created_at', async () => {
    // Created long ago but resumed/finalised an hour ago: still inside the window.
    store = [
      row('old-created-recent-activity', 'completed', 3600, { created_at: ago(90 * DAY) }),
      row('old-activity', 'failed', RETENTION + 60, { created_at: ago(RETENTION + 60) }),
    ];
    const r = await run();
    expect(r.deleted).toBe(1);
    expect(ids()).toEqual(['old-created-recent-activity']);
  });

  it('a delete error is reported, counts nothing as deleted, and leaves rows intact', async () => {
    store = [row('old-c', 'completed', RETENTION + 60)];
    deleteError = { message: 'statement timeout' };
    const r = await run();
    expect(r.scanned).toBe(1);
    expect(r.errors).toBe(1);
    expect(r.deleted).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.byStatus).toEqual({ completed: 0, failed: 0 });
    expect(ids()).toEqual(['old-c']);
  });

  it('a scan error deletes nothing and is reported', async () => {
    store = [row('old-c', 'completed', RETENTION + 60)];
    (supabase.from as jest.Mock).mockImplementation(() => ({
      select: () => {
        const c: any = {
          in: () => c, lt: () => c, order: () => c,
          limit: () => Promise.resolve({ data: null, error: { message: 'db down' } }),
        };
        return c;
      },
    }));
    const r = await run();
    expect(r.errors).toBe(1);
    expect(r.deleted).toBe(0);
    expect(ids()).toEqual(['old-c']);
  });
});
