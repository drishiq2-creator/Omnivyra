/**
 * E4 — authoritative server-side engagement portal counts + resolve.
 *
 * Exercises the real routes (platform-counts, work-queue, bulk-resolve) over an
 * in-memory PostgREST stand-in that honours eq/in/gte/or/order/range, so the
 * paging, tenant scope and failure paths of the ONE count definition are what
 * is under test. Every assertion has a control that the same fixture can fail.
 */

interface Row { [k: string]: unknown }
const db: Record<string, Row[]> = {};
const TABLES = [
  'engagement_threads', 'engagement_messages', 'engagement_authors', 'social_accounts',
  'user_company_roles', 'engagement_thread_classification', 'engagement_opportunities',
  'engagement_thread_events', 'community_ai_actions',
];
const failReads = new Map<string, 'error' | 'null'>();
const failWrites = new Set<string>();
let rangeCalls = 0;

function cmp(a: unknown, b: unknown) {
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function makeBuilder(table: string) {
  type F = (r: Row) => boolean;
  const filters: F[] = [];
  let orderCol: string | null = null;
  let range: [number, number] | null = null;
  let mode: 'select' | 'update' | 'insert' = 'select';
  let patch: Row = {};
  let inserted: Row[] = [];
  const run = () => {
    if (mode === 'insert') {
      if (failWrites.has(table)) return { data: null, error: { message: `${table} insert failed` } };
      for (const r of inserted) (db[table] = db[table] ?? []).push({ created_at: new Date().toISOString(), ...r });
      return { data: inserted, error: null };
    }
    if (mode === 'update') {
      if (failWrites.has(table)) return { data: null, error: { message: `${table} update failed` } };
      for (const r of db[table] ?? []) if (filters.every((f) => f(r))) Object.assign(r, patch);
      return { data: null, error: null };
    }
    const failure = failReads.get(table);
    if (failure === 'error') return { data: null, error: { message: `${table} read failed` } };
    if (failure === 'null') return { data: null, error: null };
    let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (orderCol) rows = [...rows].sort((a, b) => cmp(a[orderCol!], b[orderCol!]));
    if (range) { rangeCalls += 1; rows = rows.slice(range[0], range[1] + 1); }
    return { data: rows, error: null };
  };
  const api: any = {
    select() { return api; },
    eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return api; },
    neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return api; },
    in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return api; },
    gte(c: string, v: unknown) { filters.push((r) => r[c] != null && String(r[c]) >= String(v)); return api; },
    or(expr: string) {
      const parts = expr.split(',').map((p) => { const [col, op, ...rest] = p.split('.'); return { col, op, val: rest.join('.') }; });
      filters.push((r) => parts.some((p) => p.op === 'gte' && r[p.col] != null && String(r[p.col]) >= p.val));
      return api;
    },
    order(c: string) { orderCol = orderCol ?? c; return api; },
    range(from: number, to: number) { range = [from, to]; return api; },
    limit() { return api; },
    update(p: Row) { mode = 'update'; patch = p; return api; },
    insert(rows: Row | Row[]) { mode = 'insert'; inserted = Array.isArray(rows) ? rows : [rows]; return api; },
    maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }); },
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
  };
  return api;
}
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => makeBuilder(t) } }));

const COMPANY_A = 'company_a';
const COMPANY_B = 'company_b';
let userCompanies = new Set<string>([COMPANY_A]);
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: async () => ({ userId: 'user_a1', defaultCompanyId: 'company_a' }),
  enforceCompanyAccess: async ({ res, companyId }: { res: any; companyId: string }) => {
    if (!userCompanies.has(companyId)) { res.status(403).json({ error: 'FORBIDDEN' }); return null; }
    return { userId: 'user_a1' };
  },
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

import countsHandler from '../../../pages/api/engagement/platform-counts';
import workQueueHandler from '../../../pages/api/engagement/work-queue';
import resolveHandler from '../../../pages/api/engagement/thread/bulk-resolve';
import { selectPeopleReactionThreads, selectNeedsResponseThreads } from '../../../lib/engagement/queueRules';

function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => res;
  return res;
}
async function getCounts(query: Record<string, unknown> = { organization_id: COMPANY_A }, body?: unknown) {
  const res = mockRes();
  await (countsHandler as any)({ method: 'GET', query, body, headers: {} }, res);
  return res;
}
async function getWorkQueue(query: Record<string, unknown> = { organization_id: COMPANY_A }) {
  const res = mockRes();
  await (workQueueHandler as any)({ method: 'GET', query, headers: {} }, res);
  return res;
}
async function resolve(threadIds: string[], org = COMPANY_A) {
  const res = mockRes();
  await (resolveHandler as any)({ method: 'POST', query: {}, body: { organization_id: org, thread_ids: threadIds }, headers: {} }, res);
  return res;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
let seq = 0;

// Company A owns LinkedIn member li-A1 (engagement author auth_a1).
function seedIdentity() {
  db.user_company_roles = [
    { user_id: 'user_a1', company_id: COMPANY_A, status: 'active' },
    { user_id: 'user_b1', company_id: COMPANY_B, status: 'active' },
  ];
  db.social_accounts = [
    { user_id: 'user_a1', company_id: 'company_a', platform: 'linkedin', platform_user_id: 'li-A1', is_active: true },
    { user_id: 'user_b1', company_id: 'company_b', platform: 'linkedin', platform_user_id: 'li-B1', is_active: true },
  ];
  db.engagement_authors = [
    { id: 'auth_a1', platform: 'linkedin', platform_user_id: 'li-A1', display_name: 'Company A' },
    { id: 'auth_b1', platform: 'linkedin', platform_user_id: 'li-B1', display_name: 'Company B' },
  ];
}
function thread(id: string, org: string, platform = 'linkedin', extra: Row = {}) {
  db.engagement_threads.push({ id, organization_id: org, platform, ignored: false, platform_thread_id: `urn:li:activity:${id}`, raw_payload: null, ...extra });
}
function dmThread(id: string, org: string, extra: Row = {}) {
  thread(id, org, 'linkedin', { platform_thread_id: `dm-${id}`, ...extra });
}
function msg(threadId: string, type: 'comment' | 'dm', author: string, at: string, extra: Row = {}) {
  seq += 1;
  const id = `m${String(seq).padStart(6, '0')}`;
  db.engagement_messages.push({
    id, thread_id: threadId, platform: 'linkedin', platform_message_id: `pm-${id}`, message_type: type,
    direction: null, content: `body ${id}`, author_id: author, raw_payload: null,
    platform_created_at: at, created_at: at, ...extra,
  });
  if (!db.engagement_authors.some((a) => a.id === author)) {
    db.engagement_authors.push({ id: author, platform: 'linkedin', platform_user_id: `li-${author}`, display_name: `Person ${author}` });
  }
  return id;
}

beforeEach(() => {
  TABLES.forEach((t) => { db[t] = []; });
  failReads.clear();
  failWrites.clear();
  rangeCalls = 0;
  userCompanies = new Set([COMPANY_A]);
  seedIdentity();
});

describe('E4 counts — true totals, per item', () => {
  it('more than 10 needs-response DM conversations are all counted (no visible-limit cap)', async () => {
    for (let i = 0; i < 12; i += 1) { dmThread(`dm${i}`, COMPANY_A); msg(`dm${i}`, 'dm', `ext${i}`, minutesAgo(30 + i)); }
    const res = await getCounts();
    expect(res.statusCode).toBe(200);
    expect(res.body.counts.linkedin.needs_response).toBe(12);
    expect(res.body.totals.needs_response).toBe(12);
  });

  it('CONTROL: the same 12 conversations answered by the company count 0', async () => {
    for (let i = 0; i < 12; i += 1) {
      dmThread(`dm${i}`, COMPANY_A);
      msg(`dm${i}`, 'dm', `ext${i}`, minutesAgo(30 + i));
      msg(`dm${i}`, 'dm', 'auth_a1', minutesAgo(10)); // company account replied last
    }
    const res = await getCounts();
    expect(res.statusCode).toBe(200);
    expect(res.body.totals.needs_response).toBe(0);
  });

  it('two inbound comments on one post count 2, not 1', async () => {
    thread('post1', COMPANY_A);
    msg('post1', 'comment', 'ext1', minutesAgo(20));
    msg('post1', 'comment', 'ext2', minutesAgo(10));
    const res = await getCounts();
    expect(res.body.counts.linkedin.people_reaction).toBe(2);
    expect(res.body.counts.linkedin.actionable_items).toBe(2);
  });

  it('CONTROL: a company comment between them leaves 1; after both leaves 0', async () => {
    thread('post1', COMPANY_A);
    msg('post1', 'comment', 'ext1', minutesAgo(30));
    msg('post1', 'comment', 'auth_a1', minutesAgo(20));
    msg('post1', 'comment', 'ext2', minutesAgo(10));
    expect((await getCounts()).body.counts.linkedin.people_reaction).toBe(1);
    msg('post1', 'comment', 'auth_a1', minutesAgo(5));
    expect((await getCounts()).body.counts.linkedin?.people_reaction ?? 0).toBe(0);
  });

  it('1,005 comments on one post are counted fully across read pages', async () => {
    thread('big', COMPANY_A);
    for (let i = 0; i < 1005; i += 1) msg('big', 'comment', `ext${i % 7}`, minutesAgo(1 + (i % 500)));
    const res = await getCounts();
    expect(res.body.counts.linkedin.people_reaction).toBe(1005);
    expect(rangeCalls).toBeGreaterThan(2); // paged, not one capped read
  });

  it('counts are identical whatever platform tab the caller has selected', async () => {
    thread('li', COMPANY_A); msg('li', 'comment', 'ext1', minutesAgo(10));
    thread('tw', COMPANY_A, 'twitter'); msg('tw', 'comment', 'ext2', minutesAgo(10), { platform: 'twitter' });
    const all = await getCounts({ organization_id: COMPANY_A });
    const li = await getCounts({ organization_id: COMPANY_A, platform: 'linkedin' });
    const tw = await getCounts({ organization_id: COMPANY_A, platform: 'twitter' });
    expect(all.body.counts.twitter.people_reaction).toBe(1);
    expect(li.body.counts).toEqual(all.body.counts);
    expect(tw.body.counts).toEqual(all.body.counts);
    expect(li.body.totals).toEqual(all.body.totals);
  });

  it('work-queue serves the same numbers from the same definition', async () => {
    thread('post1', COMPANY_A);
    msg('post1', 'comment', 'ext1', minutesAgo(20));
    msg('post1', 'comment', 'ext2', minutesAgo(10));
    const counts = await getCounts();
    const queue = await getWorkQueue();
    expect(queue.statusCode).toBe(200);
    expect(queue.body.total_actionable_threads).toBe(counts.body.totals.actionable_items);
    expect(queue.body.total_actionable_threads).toBe(2);
  });
});

describe('E4 resolve — leaves both the count and the list', () => {
  function listItem(threadId: string, latest: string) {
    return {
      thread_id: threadId, latest_message_type: 'comment', latest_message_direction: null,
      latest_message_author_self: false, latest_message_time: latest,
      has_completed_outbound_action: false, has_pending_outbound_action: false,
    };
  }

  it('a resolved thread drops out of the count and the People Reaction list', async () => {
    thread('post1', COMPANY_A);
    msg('post1', 'comment', 'ext1', minutesAgo(20));
    const latest = minutesAgo(10);
    msg('post1', 'comment', 'ext2', latest);
    expect((await getCounts()).body.counts.linkedin.people_reaction).toBe(2);

    const r = await resolve(['post1']);
    expect(r.statusCode).toBe(200);
    expect(r.body.resolved).toBe(1);

    const after = await getCounts();
    expect(after.body.totals.people_reaction).toBe(0);
    const handled = after.body.handled_threads;
    expect(handled.post1).toBeDefined();
    expect(selectPeopleReactionThreads([listItem('post1', latest)], Date.now(), handled)).toHaveLength(0);
    // CONTROL: the same list item without the server's handled map is visible.
    expect(selectPeopleReactionThreads([listItem('post1', latest)], Date.now())).toHaveLength(1);
  });

  it('CONTROL: a new inbound comment after the resolve re-opens it (count and list)', async () => {
    thread('post1', COMPANY_A);
    msg('post1', 'comment', 'ext1', minutesAgo(20));
    await resolve(['post1']);
    const newer = new Date(Date.now() + 60_000).toISOString();
    msg('post1', 'comment', 'ext3', newer);
    const after = await getCounts();
    expect(after.body.counts.linkedin.people_reaction).toBe(1);
    expect(selectPeopleReactionThreads([listItem('post1', newer)], Date.now(), after.body.handled_threads)).toHaveLength(1);
  });

  it('a resolved DM conversation leaves Needs Response (count and list)', async () => {
    dmThread('dm1', COMPANY_A);
    const at = minutesAgo(5);
    msg('dm1', 'dm', 'ext1', at);
    expect((await getCounts()).body.totals.needs_response).toBe(1);
    await resolve(['dm1']);
    const after = await getCounts();
    expect(after.body.totals.needs_response).toBe(0);
    const item = { ...listItem('dm1', at), latest_message_type: 'dm' };
    expect(selectNeedsResponseThreads([item], Date.now(), after.body.handled_threads)).toHaveLength(0);
    expect(selectNeedsResponseThreads([item], Date.now())).toHaveLength(1); // CONTROL
  });

  it('a resolve whose marker cannot be written fails the request and resolves nothing', async () => {
    thread('post1', COMPANY_A);
    msg('post1', 'comment', 'ext1', minutesAgo(20));
    db.engagement_opportunities.push({ id: 'o1', organization_id: COMPANY_A, source_thread_id: 'post1', resolved: false });
    failWrites.add('engagement_thread_events');
    const r = await resolve(['post1']);
    expect(r.statusCode).toBe(500);
    expect(r.body.code).toBe('RESOLVE_NOT_RECORDED');
    expect(db.engagement_opportunities[0].resolved).toBe(false);
    failWrites.clear();
    expect((await getCounts()).body.totals.people_reaction).toBe(1);
    // CONTROL: the same request with a writable marker resolves both.
    const ok = await resolve(['post1']);
    expect(ok.statusCode).toBe(200);
    expect(db.engagement_opportunities[0].resolved).toBe(true);
    expect((await getCounts()).body.totals.people_reaction).toBe(0);
  });
});

describe('E4 tenant scope', () => {
  beforeEach(() => {
    thread('a_post', COMPANY_A); msg('a_post', 'comment', 'ext1', minutesAgo(10));
    thread('b_post', COMPANY_B); for (let i = 0; i < 3; i += 1) msg('b_post', 'comment', `extb${i}`, minutesAgo(10 + i));
    dmThread('b_dm', COMPANY_B); msg('b_dm', 'dm', 'extb9', minutesAgo(3));
  });

  it("company A's counts never include company B's threads; a body org id is ignored", async () => {
    const res = await getCounts({ organization_id: COMPANY_A }, { organization_id: COMPANY_B });
    expect(res.statusCode).toBe(200);
    expect(res.body.totals).toEqual({ needs_response: 0, people_reaction: 1, actionable_items: 1, high_priority: 0 });
    expect(Object.keys(res.body.handled_threads)).not.toContain('b_post');
  });

  it('CONTROL: company B (when the caller may read it) does show its own 4 items', async () => {
    userCompanies = new Set([COMPANY_A, COMPANY_B]);
    const res = await getCounts({ organization_id: COMPANY_B });
    expect(res.body.totals.actionable_items).toBe(4);
  });

  it('a company the caller cannot access is refused, not counted', async () => {
    const res = await getCounts({ organization_id: COMPANY_B });
    expect(res.statusCode).toBe(403);
    expect(res.body.totals).toBeUndefined();
  });
});

describe('E4 read failure → unknown, never 0', () => {
  beforeEach(() => { thread('post1', COMPANY_A); msg('post1', 'comment', 'ext1', minutesAgo(10)); });

  it.each([
    ['engagement_threads', 'error'],
    ['engagement_messages', 'error'],
    ['engagement_messages', 'null'],
    ['engagement_thread_events', 'error'],
    ['community_ai_actions', 'error'],
    ['user_company_roles', 'error'],
  ] as const)('%s read %s → 503 with no counts', async (table, kind) => {
    failReads.set(table, kind);
    const res = await getCounts();
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('ENGAGEMENT_COUNTS_UNAVAILABLE');
    expect(res.body.counts).toBeUndefined();
    expect(res.body.totals).toBeUndefined();
    const queue = await getWorkQueue();
    expect(queue.statusCode).toBe(503);
    expect(queue.body.total_actionable_threads).toBeUndefined();
  });

  it('CONTROL: the same fixture with every read succeeding is 200 with the count', async () => {
    const res = await getCounts();
    expect(res.statusCode).toBe(200);
    expect(res.body.totals.people_reaction).toBe(1);
  });
});

describe('E4 LinkedIn behaviour preserved in the definition', () => {
  it('legacy-split DM threads for one counterparty are one conversation', async () => {
    dmThread('s1', COMPANY_A); msg('s1', 'dm', 'ext1', minutesAgo(30));
    dmThread('s2', COMPANY_A); msg('s2', 'dm', 'ext1', minutesAgo(20));
    expect((await getCounts()).body.totals.needs_response).toBe(1);
    // CONTROL: a different counterparty is a second conversation.
    dmThread('s3', COMPANY_A); msg('s3', 'dm', 'ext2', minutesAgo(20));
    expect((await getCounts()).body.totals.needs_response).toBe(2);
  });

  it('only an EXECUTED reply covers; a dispatched one does not', async () => {
    dmThread('dm1', COMPANY_A, { raw_payload: { participant_profile_url: 'https://linkedin.com/in/ext1' } });
    msg('dm1', 'dm', 'ext1', minutesAgo(30));
    db.community_ai_actions.push({ organization_id: COMPANY_A, target_id: 'https://linkedin.com/in/ext1', action_type: 'dm', status: 'dispatched', created_at: minutesAgo(5), updated_at: minutesAgo(5) });
    expect((await getCounts()).body.totals.needs_response).toBe(1);
    db.community_ai_actions[0].status = 'executed';
    expect((await getCounts()).body.totals.needs_response).toBe(0);
  });

  it('a LinkedIn preview marked last_message_self is not waiting on us', async () => {
    dmThread('pv', COMPANY_A, { raw_payload: { last_message_preview: 'You: thanks!', last_message_at: minutesAgo(2), last_message_self: true, thread_url: 'https://www.linkedin.com/messaging/thread/1/' } });
    msg('pv', 'dm', 'ext1', minutesAgo(30));
    expect((await getCounts()).body.totals.needs_response).toBe(0);
    // CONTROL: the same thread without the self flag is waiting on us.
    (db.engagement_threads[0].raw_payload as Row).last_message_self = false;
    (db.engagement_threads[0].raw_payload as Row).last_message_preview = 'Ext: hello?';
    expect((await getCounts()).body.totals.needs_response).toBe(1);
  });

  it('ignored threads and items older than the 60-day window are not counted', async () => {
    thread('old', COMPANY_A); msg('old', 'comment', 'ext1', minutesAgo(61 * 24 * 60));
    thread('ign', COMPANY_A, 'linkedin', { ignored: true }); msg('ign', 'comment', 'ext2', minutesAgo(5));
    expect((await getCounts()).body.totals.actionable_items).toBe(0);
    thread('new', COMPANY_A); msg('new', 'comment', 'ext3', minutesAgo(5)); // CONTROL
    expect((await getCounts()).body.totals.actionable_items).toBe(1);
  });
});
