/**
 * c6 2026-11-18 (F2 a/b/c/d - independent of the triage pricing decision):
 *   a) selection pages newest-first with a per-company cap: a first page of already-classified threads no longer starves
 *      unclassified threads behind it, and one busy company cannot take the whole tick;
 *   b) a FAILED engagement-controls read fails CLOSED (every control off), a missing row still means the defaults;
 *   c) one provider call per thread per tick: a null result is final, only the DB write is retried;
 *   d) a failed messages / classifications read ends the tick with no AI call.
 */
type Row = Record<string, any>;
const db: { threads: Row[]; messages: Row[]; classifications: Row[]; controls: Row[]; failRead: Set<string>; failWrite: number } = {
  threads: [], messages: [], classifications: [], controls: [], failRead: new Set(), failWrite: 0,
};
const writes: Array<{ table: string; op: string }> = [];

function query(table: string) {
  const st: { filters: Array<(r: Row) => boolean>; order: Array<[string, boolean]>; range?: [number, number]; limit?: number } = { filters: [], order: [] };
  const rows = () => (table === 'engagement_threads' ? db.threads : table === 'engagement_messages' ? db.messages
    : table === 'engagement_thread_classification' ? db.classifications : table === 'engagement_system_controls' ? db.controls : []);
  const run = () => {
    if (db.failRead.has(table)) return { data: null, error: { message: `read ${table} failed` } };
    let out = rows().filter((r) => st.filters.every((f) => f(r)));
    for (const [col, asc] of [...st.order].reverse()) {
      out = [...out].sort((a, b) => (a[col] === b[col] ? 0 : (a[col] ?? '') < (b[col] ?? '') ? (asc ? -1 : 1) : (asc ? 1 : -1)));
    }
    if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
    if (st.limit !== undefined) out = out.slice(0, st.limit);
    return { data: out, error: null };
  };
  const b: any = {
    select: () => b,
    not: (c: string) => { st.filters.push((r) => r[c] !== null && r[c] !== undefined); return b; },
    eq: (c: string, v: unknown) => { st.filters.push((r) => r[c] === v); return b; },
    in: (c: string, vs: unknown[]) => { st.filters.push((r) => vs.includes(r[c])); return b; },
    order: (c: string, o?: { ascending?: boolean }) => { st.order.push([c, o?.ascending !== false]); return b; },
    range: (a: number, z: number) => { st.range = [a, z]; return b; },
    limit: (n: number) => { st.limit = n; return b; },
    maybeSingle: async () => { const r = run(); return { data: r.data ? r.data[0] ?? null : null, error: r.error }; },
    then: (ok: any, ko: any) => Promise.resolve(run()).then(ok, ko),
    update: () => ({ eq: () => ({ eq: async () => { writes.push({ table, op: 'update' }); return { error: null }; } }) }),
    insert: async () => {
      writes.push({ table, op: 'insert' });
      if (db.failWrite > 0) { db.failWrite--; return { error: { message: 'write failed' } }; }
      return { error: null };
    },
  };
  return b;
}
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => query(t) } }));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => query(t) }));
jest.mock('../../services/systemHealthMetricsService', () => ({ recordMetric: async () => undefined }));
const attempts: number[] = [];
jest.mock('../../services/workerRetryService', () => ({
  executeWithRetry: async (_w: string, _p: unknown, fn: () => Promise<unknown>) => {
    let n = 0;
    for (;;) { n++; try { const r = await fn(); attempts.push(n); return r; } catch (e) { if (n >= 3) { attempts.push(n); throw e; } } }
  },
}));
const classified: string[] = [];
let classifyResult: any = { classification_category: 'general_comment', classification_confidence: 0.9, sentiment: 'neutral', triage_priority: 3 };
jest.mock('../../services/conversationTriageService', () => ({
  classifyThread: async (threadId: string) => { classified.push(threadId); return classifyResult; },
}));

import { runConversationTriageWorker, TRIAGE_PER_ORG_CAP } from '../../workers/conversationTriageWorker';
import { getControls } from '../../services/engagementGovernanceService';

const iso = (minAgo: number) => new Date(Date.UTC(2026, 10, 18, 12, 0, 0) - minAgo * 60_000).toISOString();
function thread(i: number, org: string, updatedMinAgo: number): Row {
  return { id: `t${String(i).padStart(4, '0')}`, organization_id: org, ignored: false, updated_at: iso(updatedMinAgo) };
}
beforeEach(() => {
  db.threads = []; db.messages = []; db.classifications = []; db.controls = []; db.failRead = new Set(); db.failWrite = 0;
  writes.length = 0; attempts.length = 0; classified.length = 0;
  classifyResult = { classification_category: 'general_comment', classification_confidence: 0.9, sentiment: 'neutral', triage_priority: 3 };
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => (console.error as jest.Mock).mockRestore?.());

describe('a) selection', () => {
  test('a first page of already-classified threads no longer starves unclassified threads behind it', async () => {
    // 100 recently-updated threads, all classified after their last message; 3 older ones never classified.
    for (let i = 0; i < 100; i++) {
      const org = `org-${i % 25}`;
      db.threads.push(thread(i, org, i));
      db.messages.push({ thread_id: `t${String(i).padStart(4, '0')}`, platform_created_at: iso(500) });
      db.classifications.push({ thread_id: `t${String(i).padStart(4, '0')}`, classified_at: iso(10) });
    }
    for (let i = 100; i < 103; i++) db.threads.push(thread(i, 'org-late', 1000 + i));
    const r = await runConversationTriageWorker();
    expect(classified.sort()).toEqual(['t0100', 't0101', 't0102']);
    expect(r).toEqual({ processed: 3, errors: 0 });
  });

  test(`a company gets at most ${TRIAGE_PER_ORG_CAP} threads per tick; others still get theirs`, async () => {
    for (let i = 0; i < 20; i++) db.threads.push(thread(i, 'org-busy', i));
    for (let i = 20; i < 23; i++) db.threads.push(thread(i, 'org-quiet', i));
    await runConversationTriageWorker();
    const busy = classified.filter((t) => Number(t.slice(1)) < 20).length;
    const quiet = classified.filter((t) => Number(t.slice(1)) >= 20).length;
    expect(busy).toBe(TRIAGE_PER_ORG_CAP);
    expect(quiet).toBe(3);
  });
});

test('7c: a thread pushed onto the next page by concurrent activity is classified ONCE per tick', async () => {
  // t0000..t0099 fill page 0 (newest first); t0100 is on page 1. All classified except t0099 (last of page 0).
  const orig: Row[] = [];
  for (let i = 0; i <= 100; i++) orig.push(thread(i, `org-${i}`, 10 + i));
  for (let i = 0; i <= 100; i++) if (i !== 99) db.classifications.push({ thread_id: `t${String(i).padStart(4, '0')}`, classified_at: iso(1) });
  // Concurrent inbound activity between the two page reads: t0100 is bumped to the front, pushing t0099 onto page 1.
  let reads = 0;
  Object.defineProperty(db, 'threads', { configurable: true, get: () => { reads++; if (reads === 2) orig[100].updated_at = iso(0); return orig; }, set: () => undefined });
  try {
    await runConversationTriageWorker();
  } finally {
    Object.defineProperty(db, 'threads', { configurable: true, writable: true, value: [] });
  }
  expect(classified.filter((t) => t === 't0099')).toHaveLength(1);
});

describe('d) reads fail closed', () => {
  test.each(['engagement_threads', 'engagement_messages', 'engagement_thread_classification'])(
    'a failed read of %s ends the tick with NO AI call', async (table) => {
      db.threads.push(thread(1, 'org-a', 1));
      db.failRead.add(table);
      const r = await runConversationTriageWorker();
      expect(classified).toEqual([]);
      expect(r).toEqual({ processed: 0, errors: 1 });
    });
});

describe('c) one provider call per thread per tick', () => {
  test('a null classification is final for the tick: exactly ONE call, no retry, no write', async () => {
    db.threads.push(thread(1, 'org-a', 1));
    classifyResult = null;
    const r = await runConversationTriageWorker();
    expect(classified).toEqual(['t0001']);
    expect(writes).toEqual([]);
    expect(r).toEqual({ processed: 0, errors: 1 });
  });

  test('a failing DB write is retried WITHOUT re-running the AI call', async () => {
    db.threads.push(thread(1, 'org-a', 1));
    db.failWrite = 2;
    const r = await runConversationTriageWorker();
    expect(classified).toEqual(['t0001']);
    expect(attempts).toEqual([3]);
    expect(r).toEqual({ processed: 1, errors: 0 });
  });
});

describe('b) engagement controls fail closed on a read error', () => {
  test('a failed controls read -> every control OFF (and the worker skips triage)', async () => {
    db.failRead.add('engagement_system_controls');
    const c = await getControls('org-a');
    expect(Object.values(c).every((v) => v === false)).toBe(true);
    db.threads.push(thread(1, 'org-a', 1));
    await runConversationTriageWorker();
    expect(classified).toEqual([]);
  });

  test('control: no row (not an error) still means the defaults (triage on)', async () => {
    const c = await getControls('org-a');
    expect(c.triage_engine_enabled).toBe(true);
  });
});
