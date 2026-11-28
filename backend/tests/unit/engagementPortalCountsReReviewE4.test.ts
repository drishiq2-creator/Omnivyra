/**
 * E4 re-review follow-ups (re-review of b53298bd2):
 *  #1 bulk-resolve authenticates before any read (no existence oracle);
 *  #2 list and count agree when an older-dated item is ingested after a resolve
 *     (comments and DMs);
 *  #3 inbox dates are validated as ISO before reaching a PostgREST filter;
 *  #4 company identities come only from accounts bound to the company;
 *  #5 companies with >= 1000 members are paged, not refused.
 * The PostgREST stand-in caps every response at 1000 rows (default max-rows).
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
const reads: string[] = [];
const orFilters: string[] = [];

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
    reads.push(table);
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
      orFilters.push(expr);
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
let signedIn = true;
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: async () => (signedIn
    ? { userId: 'user_a1', defaultCompanyId: 'company_a', authenticated: true }
    : { userId: '', defaultCompanyId: '', authenticated: false }),
  enforceCompanyAccess: async ({ res, companyId }: { res: any; companyId: string }) => {
    if (!signedIn) { res.status(401).json({ error: 'UNAUTHENTICATED' }); return null; }
    if (!userCompanies.has(companyId)) { res.status(403).json({ error: 'FORBIDDEN' }); return null; }
    return { userId: 'user_a1' };
  },
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

import countsHandler from '../../../pages/api/engagement/platform-counts';
import inboxHandler from '../../../pages/api/engagement/inbox';
import resolveHandler from '../../../pages/api/engagement/thread/bulk-resolve';
import { selectNeedsResponseThreads, selectPeopleReactionThreads } from '../../../lib/engagement/queueRules';

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
const resolve = (ids: string[]) => call(resolveHandler, 'POST', {}, { thread_ids: ids });

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
let seq = 0;

function author(id: string, platformUserId: string) {
  db.engagement_authors.push({ id, platform: 'linkedin', platform_user_id: platformUserId, display_name: id, username: id });
}
function thread(id: string, kind: 'post' | 'dm' = 'post', org = A) {
  db.engagement_threads.push({
    id, organization_id: org, platform: 'linkedin', ignored: false,
    platform_thread_id: kind === 'post' ? `urn:li:activity:${id}` : `dm-${id}`,
    raw_payload: null, priority_score: 0, unread_count: 1, created_at: ago(90 * MIN), updated_at: ago(0),
  });
}
function msg(threadId: string, type: 'comment' | 'dm', authorId: string, providerAt: string, ingestedAt = providerAt) {
  seq += 1;
  const id = `m${String(seq).padStart(6, '0')}`;
  db.engagement_messages.push({
    id, thread_id: threadId, organization_id: A, platform: 'linkedin', platform_message_id: `pm-${id}`,
    message_type: type, direction: null, content: `body ${id}`, author_id: authorId, raw_payload: null,
    platform_created_at: providerAt, created_at: ingestedAt, sentiment_score: null,
  });
}
const listItem = (threadId: string, type: string, latest: string) => ({
  thread_id: threadId, latest_message_type: type, latest_message_direction: null,
  latest_message_author_self: false, latest_message_time: latest,
  has_completed_outbound_action: false, has_pending_outbound_action: false,
});

beforeEach(() => {
  TABLES.forEach((t) => { db[t] = []; });
  reads.length = 0;
  orFilters.length = 0;
  userCompanies = new Set([A]);
  signedIn = true;
  db.user_company_roles = [{ user_id: 'user_a1', company_id: A, status: 'active' }];
  db.social_accounts = [{ user_id: 'user_a1', company_id: A, platform: 'linkedin', platform_user_id: 'li-A1', is_active: true }];
  author('auth_a1', 'li-A1');
  author('ext1', 'li-ext1');
  author('ext2', 'li-ext2');
});

describe('#1 bulk-resolve authenticates before any read', () => {
  beforeEach(() => { thread('post1'); msg('post1', 'comment', 'ext1', ago(10 * MIN)); });

  it('an unauthenticated caller gets 401 and the threads table is never read', async () => {
    signedIn = false;
    const res = await resolve(['post1']);
    expect(res.statusCode).toBe(401);
    expect(reads).not.toContain('engagement_threads');
    expect(db.engagement_thread_events).toHaveLength(0);
  });

  it('CONTROL: the authenticated owner resolves (200)', async () => {
    const res = await resolve(['post1']);
    expect(res.statusCode).toBe(200);
    expect(res.body.resolved).toBe(1);
  });
});

describe('#2 an older-dated item ingested after the resolve re-opens list AND count', () => {
  it('comments: badge 1 and the post is in the list', async () => {
    thread('post1');
    const c1 = ago(60 * MIN);
    msg('post1', 'comment', 'ext1', c1);
    await resolve(['post1']);
    msg('post1', 'comment', 'ext2', ago(120 * MIN), later(MIN)); // provider earlier, received later
    const res = await counts();
    expect(res.body.totals.people_reaction).toBe(1);
    // The list's latest_message_time is c1 (newest provider time).
    expect(selectPeopleReactionThreads([listItem('post1', 'comment', c1)], Date.now(), res.body.handled_threads)).toHaveLength(1);
  });

  it('CONTROL (comments): nothing re-opened — badge 0 and the post leaves the list', async () => {
    thread('post1');
    const c1 = ago(60 * MIN);
    msg('post1', 'comment', 'ext1', c1);
    msg('post1', 'comment', 'ext2', ago(120 * MIN), ago(30 * MIN)); // received before the resolve
    await resolve(['post1']);
    const res = await counts();
    expect(res.body.totals.people_reaction).toBe(0);
    expect(selectPeopleReactionThreads([listItem('post1', 'comment', c1)], Date.now(), res.body.handled_threads)).toHaveLength(0);
  });

  it('DMs: badge 1 and the conversation is in the list', async () => {
    thread('dm1', 'dm');
    const d1 = ago(60 * MIN);
    msg('dm1', 'dm', 'ext1', d1);
    await resolve(['dm1']);
    msg('dm1', 'dm', 'ext1', ago(120 * MIN), later(MIN));
    const res = await counts();
    expect(res.body.totals.needs_response).toBe(1);
    expect(selectNeedsResponseThreads([listItem('dm1', 'dm', d1)], Date.now(), res.body.handled_threads)).toHaveLength(1);
  });

  it('CONTROL (DMs): nothing re-opened — badge 0 and the conversation leaves the list', async () => {
    thread('dm1', 'dm');
    const d1 = ago(60 * MIN);
    msg('dm1', 'dm', 'ext1', d1);
    msg('dm1', 'dm', 'ext1', ago(120 * MIN), ago(30 * MIN));
    await resolve(['dm1']);
    const res = await counts();
    expect(res.body.totals.needs_response).toBe(0);
    expect(selectNeedsResponseThreads([listItem('dm1', 'dm', d1)], Date.now(), res.body.handled_threads)).toHaveLength(0);
  });
});

describe('#3 inbox dates are validated before reaching a filter string', () => {
  beforeEach(() => { thread('post1'); msg('post1', 'comment', 'ext1', ago(10 * MIN)); });

  it.each([
    ['a PostgREST filter injection', '2026-01-01T00:00:00Z,created_at.gte.1970-01-01'],
    ['an or() group', '2026-01-01),or(id.neq.0'],
    ['free text', 'yesterday'],
  ])('start_date = %s → 400, no filter built', async (_n, value) => {
    const res = await call(inboxHandler, 'GET', { organization_id: A, start_date: value });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(orFilters.some((f) => f.includes('1970') || f.includes('neq'))).toBe(false);
  });

  it('CONTROL: a valid ISO date is accepted and canonicalised', async () => {
    const res = await call(inboxHandler, 'GET', { organization_id: A, start_date: '2026-01-01' });
    expect(res.statusCode).toBe(200);
    expect(orFilters.some((f) => f.includes('2026-01-01T00:00:00.000Z'))).toBe(true);
  });
});

describe('#4 company identities come only from accounts bound to the company', () => {
  function seed(accountCompany: string) {
    // user_x is an active member of BOTH companies; the account belongs to accountCompany.
    db.user_company_roles.push({ user_id: 'user_x', company_id: A, status: 'active' }, { user_id: 'user_x', company_id: B, status: 'active' });
    db.social_accounts.push({ user_id: 'user_x', company_id: accountCompany, platform: 'linkedin', platform_user_id: 'li-X', is_active: true });
    author('auth_x', 'li-X');
    thread('post1');
    msg('post1', 'comment', 'ext1', ago(20 * MIN));
    msg('post1', 'comment', 'auth_x', ago(10 * MIN));
  }

  it("a two-company member's company-B account is not company A's author", async () => {
    seed(B);
    expect((await counts()).body.totals.people_reaction).toBe(2);
  });

  it("CONTROL: the same member's company-A account is company A's author", async () => {
    seed(A);
    expect((await counts()).body.totals.people_reaction).toBe(0);
  });
});

describe('#5 a company with >= 1000 members is paged, not refused', () => {
  function seed(withReply: boolean) {
    for (let i = 0; i < 1200; i += 1) {
      const u = `user_m${String(i).padStart(4, '0')}`;
      db.user_company_roles.push({ user_id: u, company_id: A, status: 'active' });
      db.social_accounts.push({ user_id: u, company_id: A, platform: 'linkedin', platform_user_id: `li-m${i}`, is_active: true });
    }
    author('auth_m1150', 'li-m1150');
    thread('post1');
    msg('post1', 'comment', 'ext1', ago(20 * MIN));
    if (withReply) msg('post1', 'comment', 'auth_m1150', ago(10 * MIN)); // member #1150 replied
  }

  it('1,200 members: member #1150 replying closes the post', async () => {
    seed(true);
    const res = await counts();
    expect(res.statusCode).toBe(200);
    expect(res.body.totals.people_reaction).toBe(0);
  });

  it('CONTROL: without the reply the post counts 1', async () => {
    seed(false);
    const res = await counts();
    expect(res.statusCode).toBe(200);
    expect(res.body.totals.people_reaction).toBe(1);
  });
});
