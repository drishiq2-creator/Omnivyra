/**
 * E4 review follow-ups (independent review of 2cd835396):
 *  #1 company author identities are read by the company's own platform ids, so
 *     other tenants' engagement_authors volume cannot truncate them away;
 *     strict reads fail closed on a cap-sized (possibly truncated) page;
 *  #2 the inbox list and the count share ONE executed-action coverage source
 *     (same window, same paging, same failure semantics);
 *  #3 resolve re-open compares against INGESTION time, not provider time;
 *  #4 bulk-resolve resolves the company on the server; a differing body org is refused.
 *
 * The PostgREST stand-in enforces a 1000-row cap on un-ranged reads, exactly
 * like the default max-rows.
 */

interface Row { [k: string]: unknown }
const db: Record<string, Row[]> = {};
const TABLES = [
  'engagement_threads', 'engagement_messages', 'engagement_authors', 'social_accounts',
  'user_company_roles', 'engagement_thread_classification', 'engagement_opportunities',
  'engagement_thread_events', 'community_ai_actions', 'engagement_thread_intelligence',
  'lead_signals', 'engagement_message_intelligence',
];
const ROW_CAP = 1000;
const failReads = new Set<string>();

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
      for (const r of inserted) (db[table] = db[table] ?? []).push({ created_at: new Date().toISOString(), ...r });
      return { data: inserted, error: null };
    }
    if (mode === 'update') {
      for (const r of db[table] ?? []) if (filters.every((f) => f(r))) Object.assign(r, patch);
      return { data: null, error: null };
    }
    if (failReads.has(table)) return { data: null, error: { message: `${table} read failed` } };
    let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (orderCol) rows = [...rows].sort((a, b) => String(a[orderCol!] ?? '').localeCompare(String(b[orderCol!] ?? '')));
    rows = range ? rows.slice(range[0], Math.min(range[1] + 1, range[0] + ROW_CAP)) : rows.slice(0, ROW_CAP);
    return { data: rows, error: null };
  };
  const api: any = {
    select() { return api; },
    eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return api; },
    neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return api; },
    in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return api; },
    gte(c: string, v: unknown) { filters.push((r) => r[c] != null && String(r[c]) >= String(v)); return api; },
    lte(c: string, v: unknown) { filters.push((r) => r[c] != null && String(r[c]) <= String(v)); return api; },
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

const A = 'company_a';
const B = 'company_b';
let userCompanies = new Set<string>([A]);
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: async () => ({ userId: 'user_a1', defaultCompanyId: 'company_a' }),
  enforceCompanyAccess: async ({ res, companyId }: { res: any; companyId: string }) => {
    if (!userCompanies.has(companyId)) { res.status(403).json({ error: 'FORBIDDEN' }); return null; }
    return { userId: 'user_a1' };
  },
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

import countsHandler from '../../../pages/api/engagement/platform-counts';
import inboxHandler from '../../../pages/api/engagement/inbox';
import resolveHandler from '../../../pages/api/engagement/thread/bulk-resolve';
import { selectPeopleReactionThreads } from '../../../lib/engagement/queueRules';

function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => res;
  return res;
}
async function call(handler: unknown, method: string, query: Row, body?: Row) {
  const res = mockRes();
  await (handler as any)({ method, query, body, headers: {} }, res);
  return res;
}
const counts = () => call(countsHandler, 'GET', { organization_id: A });
const inbox = () => call(inboxHandler, 'GET', { organization_id: A, limit: '500' });
const resolve = (ids: string[], org?: string) =>
  call(resolveHandler, 'POST', {}, org === undefined ? { thread_ids: ids } : { thread_ids: ids, organization_id: org });

const DAY = 24 * 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
let seq = 0;

function seedIdentity() {
  db.user_company_roles = [
    { user_id: 'user_a1', company_id: A, status: 'active' },
    { user_id: 'user_b1', company_id: B, status: 'active' },
  ];
  db.social_accounts = [
    { user_id: 'user_a1', company_id: 'company_a', platform: 'linkedin', platform_user_id: 'li-A1', is_active: true },
    { user_id: 'user_b1', company_id: 'company_b', platform: 'linkedin', platform_user_id: 'li-B1', is_active: true },
  ];
}
function author(id: string, platformUserId: string) {
  db.engagement_authors.push({ id, platform: 'linkedin', platform_user_id: platformUserId, display_name: id, username: id });
}
function thread(id: string, org = A) {
  db.engagement_threads.push({
    id, organization_id: org, platform: 'linkedin', ignored: false, platform_thread_id: `urn:li:activity:${id}`,
    raw_payload: null, priority_score: 0, unread_count: 1, created_at: ago(DAY * 70), updated_at: ago(0),
  });
}
function comment(threadId: string, authorId: string, providerAt: string, ingestedAt = providerAt, content?: string) {
  seq += 1;
  const id = `m${String(seq).padStart(6, '0')}`;
  db.engagement_messages.push({
    id, thread_id: threadId, organization_id: A, platform: 'linkedin', platform_message_id: `urn:li:comment:${id}`,
    message_type: 'comment', direction: null, content: content ?? `body ${id}`, author_id: authorId,
    raw_payload: null, platform_created_at: providerAt, created_at: ingestedAt, sentiment_score: null,
  });
  return id;
}

beforeEach(() => {
  TABLES.forEach((t) => { db[t] = []; });
  failReads.clear();
  userCompanies = new Set([A]);
  seedIdentity();
});

describe('#1 company author identities survive other tenants\' author volume', () => {
  function seed(otherTenantAuthors: number) {
    for (let i = 0; i < otherTenantAuthors; i += 1) author(`other_${String(i).padStart(5, '0')}`, `li-other-${i}`);
    author('zz_auth_a1', 'li-A1'); // company A's own author, AFTER the other tenants' rows
    author('ext1', 'li-ext1');
    thread('post1');
    comment('post1', 'ext1', ago(20 * 60_000));
    comment('post1', 'zz_auth_a1', ago(10 * 60_000)); // company replied last
  }

  it('1,500 other-tenant authors on the platform do not inflate company A\'s count', async () => {
    seed(1500);
    const res = await counts();
    expect(res.statusCode).toBe(200);
    expect(res.body.totals.people_reaction).toBe(0);
  });

  it('CONTROL: the same thread without the company reply counts 1', async () => {
    seed(1500);
    db.engagement_messages = db.engagement_messages.filter((m) => m.author_id !== 'zz_auth_a1');
    expect((await counts()).body.totals.people_reaction).toBe(1);
  });

  // Re-review #5 superseded "fail closed on a full page" with PAGING: a
  // cap-sized identity read is now read to the end, not refused.
  it('more than a page of company accounts is read completely (paged), not truncated', async () => {
    seed(0);
    // 1,001 accounts BEFORE the replying one in read order: a single capped read would miss it.
    db.social_accounts = db.social_accounts.filter((a) => a.platform_user_id !== 'li-A1');
    for (let i = 0; i < 1001; i += 1) db.social_accounts.push({ user_id: 'user_a1', company_id: A, platform: 'linkedin', platform_user_id: `li-A-0-extra-${String(i).padStart(4, '0')}`, is_active: true });
    db.social_accounts.push({ user_id: 'user_a1', company_id: A, platform: 'linkedin', platform_user_id: 'li-A1', is_active: true });
    const res = await counts();
    expect(res.statusCode).toBe(200);
    expect(res.body.totals.people_reaction).toBe(0);
  });

  it('CONTROL: an identity read error fails closed (503), never "no company authors"', async () => {
    seed(0);
    failReads.add('social_accounts');
    expect((await counts()).statusCode).toBe(503);
  });
});

describe('#2 inbox list and count share one coverage source', () => {
  function seed(actionAgeDays: number) {
    author('ext1', 'li-ext1');
    thread('post1');
    comment('post1', 'ext1', ago(59 * DAY), ago(59 * DAY), 'same text');
    db.community_ai_actions.push({
      id: 'act1', organization_id: A, target_id: 'urn:li:activity:post1', action_type: 'reply', status: 'executed',
      final_text: 'same text', created_at: ago(actionAgeDays * DAY), updated_at: ago(actionAgeDays * DAY),
    });
  }
  const inboxCovered = async () => {
    const res = await inbox();
    expect(res.statusCode).toBe(200);
    const item = res.body.items.find((i: Row) => i.thread_id === 'post1');
    return item.has_completed_outbound_action === true;
  };

  it('59-day comment, 61-day text-matching action: list and count agree (both open)', async () => {
    seed(61);
    const countOpen = (await counts()).body.totals.people_reaction === 1;
    expect(countOpen).toBe(true);
    expect(await inboxCovered()).toBe(false);
  });

  it('CONTROL: the same action at 58 days is inside the window — both covered', async () => {
    seed(58);
    expect((await counts()).body.totals.people_reaction).toBe(0);
    expect(await inboxCovered()).toBe(true);
  });

  it('an action read failure fails the list (503) like the count, instead of showing it open', async () => {
    seed(58);
    failReads.add('community_ai_actions');
    expect((await inbox()).statusCode).toBe(503);
    expect((await counts()).statusCode).toBe(503);
  });
});

describe('#3 resolve re-open uses ingestion time', () => {
  const listItem = (latest: string) => ({
    thread_id: 'post1', latest_message_type: 'comment', latest_message_direction: null,
    latest_message_author_self: false, latest_message_time: latest,
    has_completed_outbound_action: false, has_pending_outbound_action: false,
  });

  it('a comment ingested after the resolve re-opens even with an earlier provider time', async () => {
    author('ext1', 'li-ext1'); author('ext2', 'li-ext2');
    thread('post1');
    comment('post1', 'ext1', ago(20 * 60_000));
    expect((await resolve(['post1'])).statusCode).toBe(200);
    const provider = ago(10 * 60_000); // platform says: before the resolve
    comment('post1', 'ext2', provider, new Date(Date.now() + 60_000).toISOString()); // we received it after
    const after = await counts();
    expect(after.body.totals.people_reaction).toBe(1);
    expect(selectPeopleReactionThreads([listItem(provider)], Date.now(), after.body.handled_threads)).toHaveLength(1);
  });

  it('CONTROL: the same comment ingested before the resolve stays resolved (count and list)', async () => {
    author('ext1', 'li-ext1'); author('ext2', 'li-ext2');
    thread('post1');
    comment('post1', 'ext1', ago(20 * 60_000));
    const provider = ago(10 * 60_000);
    comment('post1', 'ext2', provider, ago(5 * 60_000));
    expect((await resolve(['post1'])).statusCode).toBe(200);
    const after = await counts();
    expect(after.body.totals.people_reaction).toBe(0);
    expect(selectPeopleReactionThreads([listItem(provider)], Date.now(), after.body.handled_threads)).toHaveLength(0);
  });
});

describe('#4 bulk-resolve takes the company from the server', () => {
  beforeEach(() => {
    author('ext1', 'li-ext1');
    thread('post1', A);
    comment('post1', 'ext1', ago(10 * 60_000));
    userCompanies = new Set([A, B]);
  });

  it('a body organization_id differing from the threads\' company is refused and writes nothing', async () => {
    const res = await resolve(['post1'], B);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('COMPANY_MISMATCH');
    expect(db.engagement_thread_events).toHaveLength(0);
  });

  it('CONTROL: the matching body org, or none, resolves the thread', async () => {
    expect((await resolve(['post1'], A)).body.resolved).toBe(1);
    expect((await resolve(['post1'])).body.resolved).toBe(1);
    expect(db.engagement_thread_events).toHaveLength(2);
  });

  it('a caller without access to the threads\' company is refused by the access check', async () => {
    userCompanies = new Set([B]);
    const res = await resolve(['post1']);
    expect(res.statusCode).toBe(403);
    expect(db.engagement_thread_events).toHaveLength(0);
  });
});
