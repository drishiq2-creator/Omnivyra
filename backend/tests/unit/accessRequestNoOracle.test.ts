/**
 * POST /api/access-request is PUBLIC (no auth). On main it had no rate limit and an EXISTENCE ORACLE:
 * 200 { requestId, status } for an existing pending/approved request vs 201 for a new one, so anyone
 * could learn whether an email had a request and its approval state (b3, 2026-11-19).
 *
 * Pinned here:
 *   - every ACCEPTED submission (new, duplicate-pending, already-approved, previously-rejected) gets the
 *     SAME status (202) and the SAME body - no requestId, no status, nothing about existence;
 *   - server-side idempotency stays: a pending/approved request is never duplicated;
 *   - per-IP AND per-normalised-email limits, both FAIL-CLOSED (onRedisFailure 'closed'): over the
 *     limit -> 429, limiter outage -> 503, both with a constant body, and nothing is written.
 */
export {};
type Row = Record<string, any>;

const mockDb: { access_requests: Row[] } = { access_requests: [] };
const mockWrites: Row[] = [];
let mockReadFails = false;
let mockInsertCode: string | null = null;
function mockTable(table: string) {
  if (table !== 'access_requests') throw new Error(`unexpected table ${table}`);
  const tests: Array<(r: Row) => boolean> = []; let op: 'select' | 'insert' = 'select'; let payload: Row | null = null;
  let cap = Infinity; let one = false;
  const run = () => {
    if (op === 'insert') {
      if (mockInsertCode) return { data: null, error: { message: 'duplicate key value violates unique constraint "access_requests_email_pending"', code: mockInsertCode } };
      const row = { id: `req-${mockDb.access_requests.length + 1}`, ...payload };
      mockDb.access_requests.push(row); mockWrites.push(row);
      return { data: one ? { id: row.id } : [{ id: row.id }], error: null };
    }
    if (mockReadFails) return { data: null, error: { message: 'boom' } };
    const hit = mockDb.access_requests.filter((r) => tests.every((t) => t(r))).slice(0, cap);
    if (one && hit.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
    return { data: one ? hit[0] ?? null : hit, error: null };
  };
  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => { tests.push((r) => r[c] === v); return b; },
    in: (c: string, v: unknown[]) => { tests.push((r) => v.includes(r[c])); return b; },
    limit: (n: number) => { cap = n; return b; },
    insert: (p: Row) => { op = 'insert'; payload = p; return b; },
    maybeSingle: () => { one = true; return b; },
    single: () => { one = true; return b; },
    then: (ok: any, ko: any) => Promise.resolve(run()).then(ok, ko),
  };
  return b;
}
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => mockTable(t) } }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../../lib/security/clientIp', () => ({ getTrustedClientIp: () => '203.0.113.7' }));

type Rl = { allowed: boolean; remaining: number; resetAt: number; bypassed: boolean; degradedMode?: string };
const mockRlCalls: Array<{ id: string; cfg: Record<string, unknown> }> = [];
/** keyPrefix fragment -> the answer for that limiter (default: allowed). */
const mockRlAnswer: Record<string, Rl> = {};
jest.mock('../../../lib/auth/rateLimit', () => ({
  checkRateLimit: async (id: string, cfg: Record<string, unknown>) => {
    mockRlCalls.push({ id, cfg });
    const key = Object.keys(mockRlAnswer).find((k) => String(cfg.keyPrefix).includes(k));
    return key ? mockRlAnswer[key] : { allowed: true, remaining: 1, resetAt: 0, bypassed: false };
  },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const route = require('../../../pages/api/access-request').default;
/* eslint-enable @typescript-eslint/no-var-requires */

async function submit(body: Record<string, unknown>) {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (x: unknown) => { res.body = x; return res; };
  res.end = () => res;
  await route({ method: 'POST', headers: {}, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
}
const LIMITED: Rl = { allowed: false, remaining: 0, resetAt: 0, bypassed: false };
const OUTAGE: Rl = { allowed: false, remaining: 0, resetAt: 0, bypassed: true, degradedMode: 'closed' };

beforeEach(() => {
  mockDb.access_requests = [];
  mockWrites.length = 0;
  mockRlCalls.length = 0;
  for (const k of Object.keys(mockRlAnswer)) delete mockRlAnswer[k];
  mockReadFails = false;
  mockInsertCode = null;
});

describe('no existence oracle: every accepted submission gets the identical reply', () => {
  it('new / duplicate-pending / already-approved / previously-rejected: same status, same body, nothing identifying', async () => {
    const replies: Array<{ status: number; body: unknown }> = [];
    replies.push(await submit({ email: 'new@gmail.test', name: 'N' }));
    mockDb.access_requests.push({ id: 'req-pend', email: 'pend@gmail.test', status: 'pending' });
    replies.push(await submit({ email: 'Pend@Gmail.test ', name: 'P' }));
    mockDb.access_requests.push({ id: 'req-appr', email: 'appr@gmail.test', status: 'approved', organization_id: 'org-1' });
    replies.push(await submit({ email: 'appr@gmail.test', name: 'A' }));
    mockDb.access_requests.push({ id: 'req-rej', email: 'rej@gmail.test', status: 'rejected' });
    replies.push(await submit({ email: 'rej@gmail.test', name: 'R' }));
    expect(replies[0].status).toBe(202);
    expect(replies[0].body).toEqual({ status: 'received', message: expect.any(String) });
    for (const r of replies.slice(1)) expect(r).toEqual(replies[0]);
    const all = JSON.stringify(replies);
    for (const leak of ['req-', 'requestId', 'pending', 'approved', 'rejected', 'org-1']) expect(all).not.toContain(leak);
  });

  it('a unique-violation on insert (a concurrent duplicate) is the same accepted reply, not an error', async () => {
    const fresh = await submit({ email: 'x@gmail.test', name: 'X' });
    mockInsertCode = '23505';
    const dup = await submit({ email: 'y@gmail.test', name: 'Y' });
    expect(dup).toEqual(fresh);
  });
});

describe('server-side idempotency stays', () => {
  it('a pending or approved request is never duplicated (no second row)', async () => {
    await submit({ email: 'once@gmail.test', name: 'O' });
    await submit({ email: 'ONCE@gmail.test', name: 'O' });
    expect(mockDb.access_requests.filter((r) => r.email === 'once@gmail.test')).toHaveLength(1);
    mockDb.access_requests.push({ id: 'req-ok', email: 'ok@gmail.test', status: 'approved' });
    await submit({ email: 'ok@gmail.test', name: 'K' });
    expect(mockWrites.filter((w) => w.email === 'ok@gmail.test')).toEqual([]);
  });

  it('several existing rows for one email still mean "exists" (never a duplicate because a read was ambiguous)', async () => {
    mockDb.access_requests.push({ id: 'r1', email: 'two@gmail.test', status: 'pending' }, { id: 'r2', email: 'two@gmail.test', status: 'approved' });
    await submit({ email: 'two@gmail.test', name: 'T' });
    expect(mockWrites).toEqual([]);
  });

  it('a failed existence read writes nothing and is not the accepted reply (fail closed)', async () => {
    mockReadFails = true;
    const r = await submit({ email: 'z@gmail.test', name: 'Z' });
    expect(r.status).toBe(503);
    expect(mockWrites).toEqual([]);
  });
});

describe('rate limits: per IP and per normalised email, fail-closed', () => {
  it('both limiters run, pinned onRedisFailure "closed", keyed by the trusted IP and the normalised email', async () => {
    await submit({ email: '  Mixed@Gmail.TEST ', name: 'M' });
    expect(mockRlCalls.map((c) => [c.id, c.cfg.onRedisFailure])).toEqual([
      ['203.0.113.7', 'closed'],
      ['mixed@gmail.test', 'closed'],
    ]);
    expect(new Set(mockRlCalls.map((c) => c.cfg.keyPrefix)).size).toBe(2);
  });

  it('per-IP limit hit -> 429 constant body, nothing read or written', async () => {
    mockRlAnswer[':ip'] = LIMITED;
    const r = await submit({ email: 'a@gmail.test', name: 'A' });
    expect(r).toEqual({ status: 429, body: { error: 'Too many requests. Please try again later.' } });
    expect(mockWrites).toEqual([]);
  });

  it('per-email limit hit -> 429 constant body, nothing written', async () => {
    mockRlAnswer[':email'] = LIMITED;
    const r = await submit({ email: 'a@gmail.test', name: 'A' });
    expect(r).toEqual({ status: 429, body: { error: 'Too many requests. Please try again later.' } });
    expect(mockWrites).toEqual([]);
  });

  it('limiter OUTAGE (fail-closed) -> 503 constant body, NOT let through, nothing written', async () => {
    for (const which of [':ip', ':email']) {
      for (const k of Object.keys(mockRlAnswer)) delete mockRlAnswer[k];
      mockRlAnswer[which] = OUTAGE;
      const r = await submit({ email: 'b@gmail.test', name: 'B' });
      expect([which, r]).toEqual([which, { status: 503, body: { error: 'Service temporarily unavailable. Please try again later.' } }]);
    }
    expect(mockWrites).toEqual([]);
  });
});
