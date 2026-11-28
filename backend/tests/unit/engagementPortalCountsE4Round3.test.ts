/**
 * E4 round-3 follow-ups (re-review of 7c93eb996):
 *  #1 getThreads (inbox list / work queue / AI labelling) uses the SAME
 *     company-only identity set as the count: a member of A and B whose
 *     account is bound to B is external on A's threads in both;
 *  #2 every paged read has a unique tiebreaker, so rows tied on the sort key
 *     cannot be skipped or duplicated across a page boundary.
 * The stand-in caps responses at 1000 rows and returns ties in an unstable order.
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
let callNo = 0;

function makeBuilder(table: string) {
  type F = (r: Row) => boolean;
  const filters: F[] = [];
  const orderCols: string[] = [];
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
    if (orderCols.length) {
      // Like Postgres, rows equal on every ORDER BY key come back in no
      // guaranteed order: this stand-in flips tie order on alternate reads.
      callNo += 1;
      const flip = callNo % 2 === 0;
      const indexed = rows.map((r, i) => ({ r, i }));
      indexed.sort((a, b) => {
        for (const c of orderCols) {
          const d = String(a.r[c] ?? '').localeCompare(String(b.r[c] ?? ''));
          if (d !== 0) return d;
        }
        return flip ? b.i - a.i : a.i - b.i;
      });
      rows = indexed.map((x) => x.r);
    }
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
    order(c: string) { orderCols.push(c); return api; },
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
import { selectPeopleReactionThreads } from '../../../lib/engagement/queueRules';
import { getThreads } from '../../services/engagementThreadService';

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

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
let seq = 0;

function author(id: string, platformUserId: string, platform = 'linkedin') {
  db.engagement_authors.push({ id, platform, platform_user_id: platformUserId, display_name: id, username: id });
}
function thread(id: string) {
  db.engagement_threads.push({
    id, organization_id: A, platform: 'linkedin', ignored: false, platform_thread_id: `urn:li:activity:${id}`,
    raw_payload: null, priority_score: 0, unread_count: 1, created_at: ago(90 * MIN), updated_at: ago(0),
  });
}
function comment(threadId: string, authorId: string, at: string) {
  seq += 1;
  const id = `m${String(seq).padStart(6, '0')}`;
  db.engagement_messages.push({
    id, thread_id: threadId, organization_id: A, platform: 'linkedin', platform_message_id: `pm-${id}`,
    message_type: 'comment', direction: null, content: `body ${id}`, author_id: authorId, raw_payload: null,
    platform_created_at: at, created_at: at, sentiment_score: null,
  });
}

beforeEach(() => {
  TABLES.forEach((t) => { db[t] = []; });
  reads.length = 0;
  orFilters.length = 0;
  callNo = 0;
  userCompanies = new Set([A]);
  signedIn = true;
  db.user_company_roles = [{ id: 'r-a1', user_id: 'user_a1', company_id: A, status: 'active' }];
  db.social_accounts = [{ id: 'sa-a1', user_id: 'user_a1', company_id: A, platform: 'linkedin', platform_user_id: 'li-A1', is_active: true }];
  author('auth_a1', 'li-A1');
  author('ext1', 'li-ext1');
});

describe('#1 list surfaces and count share the company-only identity set', () => {
  function seed(accountCompany: string) {
    db.user_company_roles.push(
      { id: 'r-xa', user_id: 'user_x', company_id: A, status: 'active' },
      { id: 'r-xb', user_id: 'user_x', company_id: B, status: 'active' },
    );
    db.social_accounts.push({ id: 'sa-x', user_id: 'user_x', company_id: accountCompany, platform: 'linkedin', platform_user_id: 'li-X', is_active: true });
    author('auth_x', 'li-X');
    thread('post1');
    comment('post1', 'ext1', ago(20 * MIN));
    comment('post1', 'auth_x', ago(10 * MIN)); // user_x's account comments last
  }
  async function surfaces() {
    const c = await counts();
    const listRes = await inbox();
    const visible = selectPeopleReactionThreads(listRes.body.items, Date.now(), c.body.handled_threads).length;
    const canonical = (await getThreads({ organization_id: A, limit: 100, exclude_ignored: true }))
      .find((t) => t.thread_id === 'post1')?.actionable;
    return { count: c.body.totals.people_reaction as number, visible, canonical };
  }

  it("a member of A+B commenting with B's account: count, list and getThreads all say open", async () => {
    seed(B);
    const s = await surfaces();
    expect(s.count).toBe(2);
    expect(s.visible).toBe(1);
    expect(s.canonical).toBe(true);
  });

  it("CONTROL: the same member commenting with A's account: all three say answered", async () => {
    seed(A);
    const s = await surfaces();
    expect(s.count).toBe(0);
    expect(s.visible).toBe(0);
    expect(s.canonical).toBe(false);
  });
});

describe('#2 paged reads have a unique tiebreaker', () => {
  function seed(withCompanyReply: boolean) {
    // 1,200 accounts of one member that ALL share platform_user_id 'same-id'
    // (one per platform), so they tie on the platform_user_id sort key across
    // the 1000-row page boundary. The company's replying author is #0100 (on the page that an unstable tie order skips).
    db.social_accounts = [];
    for (let i = 0; i < 1200; i += 1) {
      db.social_accounts.push({ id: `sa-${String(i).padStart(4, '0')}`, user_id: 'user_a1', company_id: A, platform: `p${String(i).padStart(4, '0')}`, platform_user_id: 'same-id', is_active: true });
    }
    author('auth_c', 'same-id', 'p0100');
    thread('post1');
    comment('post1', 'ext1', ago(20 * MIN));
    if (withCompanyReply) comment('post1', 'auth_c', ago(10 * MIN));
  }

  it('an account tied on the sort key just past the page boundary is not skipped', async () => {
    seed(true);
    const res = await counts();
    expect(res.statusCode).toBe(200);
    expect(res.body.totals.people_reaction).toBe(0);
  });

  it('CONTROL: without the company reply the post counts 1', async () => {
    seed(false);
    expect((await counts()).body.totals.people_reaction).toBe(1);
  });
});
