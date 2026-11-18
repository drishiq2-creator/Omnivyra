/**
 * c6 2026-11-18 (F2 a/b/c/d - independent of the triage pricing decision):
 *   a) selection pages newest-first with a per-company cap: a first page of already-classified threads no longer starves
 *      unclassified threads behind it, and one busy company cannot take the whole tick;
 *   b) a FAILED engagement-controls read fails CLOSED (every control off), a missing row still means the defaults;
 *   c) one provider call per thread per tick: a null result is final, only the DB write is retried;
 *   d) a failed messages / classifications read ends the tick with no AI call.
 */
type Row = Record<string, any>;
const db: { threads: Row[]; messages: Row[]; classifications: Row[]; controls: Row[]; failRead: Set<string>; failWrite: number; optInAll: boolean } = {
  threads: [], messages: [], classifications: [], controls: [], failRead: new Set(), failWrite: 0, optInAll: true,
};
const writes: Array<{ table: string; op: string }> = [];

function query(table: string) {
  const st: { filters: Array<(r: Row) => boolean>; order: Array<[string, boolean]>; range?: [number, number]; limit?: number } = { filters: [], order: [] };
  const rows = () => (table === 'engagement_threads' ? db.threads : table === 'engagement_messages' ? db.messages
    : table === 'engagement_thread_classification' ? db.classifications : table === 'engagement_system_controls' ? db.controls : []);
  const run = () => {
    if (db.failRead.has(table)) return { data: null, error: { message: `read ${table} failed` } };
    // Owner 2026-11-18: triage is OPT-IN. Most cases model companies that opted in; the opt-in cases turn this off.
    if (table === 'engagement_system_controls' && db.optInAll) return { data: [{ triage_engine_enabled: true }], error: null };
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
    update: (row: Row) => {
      const conds: Array<[string, unknown]> = [];
      const u: any = {
        eq: (c: string, v: unknown) => { conds.push([c, v]); return u; },
        select: async () => {
          writes.push({ table, op: 'update' });
          const hit = db.classifications.filter((r) => conds.every(([c, v]) => r[c] === v));
          for (const r of hit) Object.assign(r, row);
          return { data: hit.map(() => ({ id: 'x' })), error: null };
        },
        then: (ok: any, ko: any) => u.select().then(() => ({ error: null })).then(ok, ko),
      };
      return u;
    },
    insert: async (row: Row) => {
      writes.push({ table, op: 'insert' });
      if (db.failWrite > 0) { db.failWrite--; return { error: { message: 'write failed' } }; }
      if (table === 'engagement_thread_classification') {
        if (db.classifications.some((r) => r.thread_id === row.thread_id && r.organization_id === row.organization_id)) {
          return { error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_thread_classification_thread_org"' } };
        }
        db.classifications.push({ ...row });
      }
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
const ewc: any[] = [];
const charged: string[] = [];
const released: string[] = [];
const refuseOrgs = new Set<string>();
jest.mock('../../services/creditExecutionService', () => ({
  makeIdempotencyKey: (...p: string[]) => p.join(':'),
  executeWithCredits: async (o: any) => {
    ewc.push(o);
    if (refuseOrgs.has(o.orgId)) return { status: 'insufficient_credits', available: 0, required: o.amountOverride };
    try { const r = await o.executor(); charged.push(o.referenceId); return { status: 'executed', result: r }; }
    catch (e) { released.push(o.referenceId); throw e; }   // executeWithCredits releases the hold, then rethrows
  },
}));
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
  db.threads = []; db.messages = []; db.classifications = []; db.controls = []; db.failRead = new Set(); db.failWrite = 0; db.optInAll = true;
  writes.length = 0; attempts.length = 0; classified.length = 0; ewc.length = 0; charged.length = 0; released.length = 0; refuseOrgs.clear();
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
    expect(r).toEqual({ processed: 3, errors: 0, refused: 0 });
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
      expect(r).toEqual({ processed: 0, errors: 1, refused: 0 });
    });
});

describe('c) one provider call per thread per tick', () => {
  test('a null classification is final for the tick: exactly ONE call, no retry, no write', async () => {
    db.threads.push(thread(1, 'org-a', 1));
    classifyResult = null;
    const r = await runConversationTriageWorker();
    expect(classified).toEqual(['t0001']);
    expect(writes).toEqual([]);
    expect(r).toEqual({ processed: 0, errors: 1, refused: 0 });
  });

  test('a failing DB write is retried WITHOUT re-running the AI call', async () => {
    db.threads.push(thread(1, 'org-a', 1));
    db.failWrite = 2;
    const r = await runConversationTriageWorker();
    expect(classified).toEqual(['t0001']);
    expect(attempts).toEqual([3]);
    expect(r).toEqual({ processed: 1, errors: 0, refused: 0 });
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

  test('owner 2026-11-18 OPT-IN (inbox AI): no row (not an error) -> EVERY engagement AI control OFF', async () => {
    db.optInAll = false;
    const c = await getControls('org-a');
    expect(c).toEqual({
      auto_reply_enabled: false, bulk_reply_enabled: false, ai_suggestions_enabled: false, triage_engine_enabled: false,
      opportunity_detection_enabled: false, response_strategy_learning_enabled: false, digest_generation_enabled: false,
    });
  });

  test('OPT-IN: switching ONE control on does not switch the others on', async () => {
    db.optInAll = false;
    db.controls.push({ organization_id: 'org-a', ai_suggestions_enabled: true });
    const c = await getControls('org-a');
    expect(c.ai_suggestions_enabled).toBe(true);
    expect(c.auto_reply_enabled).toBe(false);
    expect(c.triage_engine_enabled).toBe(false);
  });

  test('OPT-IN: a row written for ANOTHER setting (triage column absent from the read) is still triage OFF', async () => {
    db.optInAll = false;
    db.controls.push({ organization_id: 'org-a', auto_reply_enabled: false });
    expect((await getControls('org-a')).triage_engine_enabled).toBe(false);
  });
});

describe('billing (owner 2026-11-18: fixed 1 credit per classified conversation, opt-in)', () => {
  test('a company that has NOT opted in is never classified or charged', async () => {
    db.optInAll = false;
    db.threads.push(thread(1, 'org-a', 1));
    await runConversationTriageWorker();
    expect(classified).toEqual([]);
    expect(ewc).toEqual([]);
  });

  test('an opted-in thread is classified inside executeWithCredits: conversation_triage, 1 credit, per-attempt key, system-initiated', async () => {
    db.threads.push(thread(1, 'org-a', 1));
    await runConversationTriageWorker();
    expect(ewc).toHaveLength(1);
    expect(ewc[0]).toMatchObject({ action: 'conversation_triage', amountOverride: 1, orgId: 'org-a', userId: 'org-a',
      referenceType: 'conversation_triage', referenceId: 't0001', validateMembership: false });
    expect(ewc[0].idempotencyKey).toMatch(/^org-a:conversation_triage:t0001:tick:\d+$/);
    expect(charged).toEqual(['t0001']);
  });

  test('a null classification is NOT charged (released) - one AI call, no write', async () => {
    db.threads.push(thread(1, 'org-a', 1));
    classifyResult = null;
    const r = await runConversationTriageWorker();
    expect(classified).toEqual(['t0001']);
    expect(charged).toEqual([]);
    expect(released).toEqual(['t0001']);
    expect(r).toEqual({ processed: 0, errors: 1, refused: 0 });
  });

  test('a write that keeps failing is NOT charged (released) - the AI ran once, the write was retried', async () => {
    db.threads.push(thread(1, 'org-a', 1));
    db.failWrite = 5;
    await runConversationTriageWorker();
    expect(classified).toEqual(['t0001']);
    expect(attempts).toEqual([3]);
    expect(charged).toEqual([]);
    expect(released).toEqual(['t0001']);
  });

  test('a refused hold (no credits) skips that company for the rest of the tick; other companies continue', async () => {
    for (let i = 0; i < 3; i++) db.threads.push(thread(i, 'org-poor', i));
    db.threads.push(thread(10, 'org-rich', 5));
    refuseOrgs.add('org-poor');
    await runConversationTriageWorker();
    expect(ewc.filter((o) => o.orgId === 'org-poor')).toHaveLength(1);   // one refusal, then skipped
    expect(classified).toEqual(['t0010']);
    expect(charged).toEqual(['t0010']);
  });
});

describe('7c/b3: exactly one winner per selection state; one clock', () => {
  test('first classification: a concurrent winner already inserted -> unique violation -> released, NOT charged, not retried', async () => {
    db.threads.push(thread(1, 'org-a', 1));
    // Another replica classifies the thread between our selection read and our insert.
    const orig = classifyResult;
    classifyResult = orig;
    const mod = require('../../services/conversationTriageService');
    const real = mod.classifyThread;
    mod.classifyThread = async (id: string) => {
      db.classifications.push({ thread_id: id, organization_id: 'org-a', classified_at: iso(0) });
      return real(id);
    };
    try {
      const r = await runConversationTriageWorker();
      expect(charged).toEqual([]);
      expect(released).toEqual(['t0001']);
      expect(writes.filter((w) => w.op === 'insert')).toHaveLength(1);   // the lost race is not retried
      expect(r.errors).toBe(1);
    } finally { mod.classifyThread = real; }
  });

  test('re-classification is a compare-and-swap on classified_at: a concurrent re-classification wins -> we are NOT charged', async () => {
    db.threads.push(thread(1, 'org-a', 1));
    db.messages.push({ thread_id: 't0001', platform_created_at: iso(5) });
    db.classifications.push({ thread_id: 't0001', organization_id: 'org-a', classified_at: iso(60) });   // stale
    const mod = require('../../services/conversationTriageService');
    const real = mod.classifyThread;
    mod.classifyThread = async (id: string) => {
      db.classifications[0].classified_at = iso(4);   // the other replica swapped first
      return real(id);
    };
    try {
      await runConversationTriageWorker();
      expect(charged).toEqual([]);
      expect(released).toEqual(['t0001']);
    } finally { mod.classifyThread = real; }
  });

  test('re-classification that wins the swap is charged once and stores the newest MESSAGE time (no app clock)', async () => {
    db.threads.push(thread(1, 'org-a', 1));
    db.messages.push({ thread_id: 't0001', platform_created_at: iso(5) });
    db.classifications.push({ thread_id: 't0001', organization_id: 'org-a', classified_at: iso(60) });
    await runConversationTriageWorker();
    expect(charged).toEqual(['t0001']);
    expect(db.classifications[0].classified_at).toBe(iso(5));
  });

  test('a platform clock ahead of ours cannot re-select the thread next tick (message time vs message time)', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();   // platform stamps 1h ahead of the worker
    db.threads.push(thread(1, 'org-a', 1));
    db.messages.push({ thread_id: 't0001', platform_created_at: future });
    await runConversationTriageWorker();
    expect(charged).toEqual(['t0001']);
    charged.length = 0; ewc.length = 0;
    await runConversationTriageWorker();   // no new message: must not be re-selected or re-charged
    expect(ewc).toEqual([]);
    expect(charged).toEqual([]);
  });

  test('a refused company is counted, not silent', async () => {
    db.threads.push(thread(1, 'org-poor', 1));
    refuseOrgs.add('org-poor');
    const r = await runConversationTriageWorker();
    expect(r).toEqual({ processed: 0, errors: 0, refused: 1 });
  });
});
