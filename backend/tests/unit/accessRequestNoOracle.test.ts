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
/** A complete, valid body (the CI-309 cases predate the vetted-path contract: company name required, website required for a corporate email). */
const ok = (b: { email: string; name: string } & Record<string, unknown>) => ({ company_name: 'Fake Co', website: 'https://fake-co.test', ...b });
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
    replies.push(await submit(ok({ email: 'new@gmail.test', name: 'N' })));
    mockDb.access_requests.push({ id: 'req-pend', email: 'pend@gmail.test', status: 'pending' });
    replies.push(await submit(ok({ email: 'Pend@Gmail.test ', name: 'P' })));
    mockDb.access_requests.push({ id: 'req-appr', email: 'appr@gmail.test', status: 'approved', organization_id: 'org-1' });
    replies.push(await submit(ok({ email: 'appr@gmail.test', name: 'A' })));
    mockDb.access_requests.push({ id: 'req-rej', email: 'rej@gmail.test', status: 'rejected' });
    replies.push(await submit(ok({ email: 'rej@gmail.test', name: 'R' })));
    expect(replies[0].status).toBe(202);
    expect(replies[0].body).toEqual({ status: 'received', message: expect.any(String) });
    for (const r of replies.slice(1)) expect(r).toEqual(replies[0]);
    const all = JSON.stringify(replies);
    for (const leak of ['req-', 'requestId', 'pending', 'approved', 'rejected', 'org-1']) expect(all).not.toContain(leak);
  });

  it('a unique-violation on insert (a concurrent duplicate) is the same accepted reply, not an error', async () => {
    const fresh = await submit(ok({ email: 'x@gmail.test', name: 'X' }));
    mockInsertCode = '23505';
    const dup = await submit(ok({ email: 'y@gmail.test', name: 'Y' }));
    expect(dup).toEqual(fresh);
  });
});

describe('server-side idempotency stays', () => {
  it('a pending or approved request is never duplicated (no second row)', async () => {
    await submit(ok({ email: 'once@gmail.test', name: 'O' }));
    await submit(ok({ email: 'ONCE@gmail.test', name: 'O' }));
    expect(mockDb.access_requests.filter((r) => r.email === 'once@gmail.test')).toHaveLength(1);
    mockDb.access_requests.push({ id: 'req-ok', email: 'ok@gmail.test', status: 'approved' });
    await submit(ok({ email: 'ok@gmail.test', name: 'K' }));
    expect(mockWrites.filter((w) => w.email === 'ok@gmail.test')).toEqual([]);
  });

  it('several existing rows for one email still mean "exists" (never a duplicate because a read was ambiguous)', async () => {
    mockDb.access_requests.push({ id: 'r1', email: 'two@gmail.test', status: 'pending' }, { id: 'r2', email: 'two@gmail.test', status: 'approved' });
    await submit(ok({ email: 'two@gmail.test', name: 'T' }));
    expect(mockWrites).toEqual([]);
  });

  it('a failed existence read writes nothing and is not the accepted reply (fail closed)', async () => {
    mockReadFails = true;
    const r = await submit(ok({ email: 'z@gmail.test', name: 'Z' }));
    expect(r.status).toBe(503);
    expect(mockWrites).toEqual([]);
  });
});

describe('rate limits: per IP and per normalised email, fail-closed', () => {
  it('both limiters run, pinned onRedisFailure "closed", keyed by the trusted IP and the normalised email', async () => {
    await submit(ok({ email: '  Mixed@Gmail.TEST ', name: 'M' }));
    expect(mockRlCalls.map((c) => [c.id, c.cfg.onRedisFailure])).toEqual([
      ['203.0.113.7', 'closed'],
      ['mixed@gmail.test', 'closed'],
    ]);
    expect(new Set(mockRlCalls.map((c) => c.cfg.keyPrefix)).size).toBe(2);
  });

  it('per-IP limit hit -> 429 constant body, nothing read or written', async () => {
    mockRlAnswer[':ip'] = LIMITED;
    const r = await submit(ok({ email: 'a@gmail.test', name: 'A' }));
    expect(r).toEqual({ status: 429, body: { error: 'Too many requests. Please try again later.' } });
    expect(mockWrites).toEqual([]);
  });

  it('per-email limit hit -> 429 constant body, nothing written', async () => {
    mockRlAnswer[':email'] = LIMITED;
    const r = await submit(ok({ email: 'a@gmail.test', name: 'A' }));
    expect(r).toEqual({ status: 429, body: { error: 'Too many requests. Please try again later.' } });
    expect(mockWrites).toEqual([]);
  });

  it('limiter OUTAGE (fail-closed) -> 503 constant body, NOT let through, nothing written', async () => {
    for (const which of [':ip', ':email']) {
      for (const k of Object.keys(mockRlAnswer)) delete mockRlAnswer[k];
      mockRlAnswer[which] = OUTAGE;
      const r = await submit(ok({ email: 'b@gmail.test', name: 'B' }));
      expect([which, r]).toEqual([which, { status: 503, body: { error: 'Service temporarily unavailable. Please try again later.' } }]);
    }
    expect(mockWrites).toEqual([]);
  });
});

/**
 * Vetted path (owner ruling 2026-11-19): the ONE access-request endpoint takes the contract given to UI 04
 * (email, contact name, company name, website - required for a corporate email -, reason), validates it
 * with field errors only, normalises the website, maps every field onto access_requests and classifies
 * domain_status (it was hard-coded 'PUBLIC_EMAIL', even for corporate email).
 */
describe('vetted path: the access-request body contract', () => {
  const full = {
    email: '  A.Person@Shared.TEST ', name: ' A Person ', company_name: ' Beta Labs ',
    website: 'https://www.Beta.test/about?x=1', reason: ' we were acquired ',
  };

  it('maps every field onto access_requests (website normalised, email lower-cased) and classifies a mismatched corporate email', async () => {
    const r = await submit(full);
    expect(r.status).toBe(202);
    expect(mockWrites).toEqual([expect.objectContaining({
      email: 'a.person@shared.test', domain: 'shared.test', name: 'A Person', company_name: 'Beta Labs',
      website_url: 'https://beta.test', use_case: 'we were acquired', job_title: null,
      domain_status: 'DOMAIN_MISMATCH', status: 'pending',
    })]);
  });

  it('domain_status: free mail -> PUBLIC_EMAIL (website optional), matching corporate website -> CORPORATE_EMAIL', async () => {
    await submit({ email: 'someone@gmail.com', name: 'S', company_name: 'Solo Brand' });
    await submit({ email: 'boss@gamma.test', name: 'B', company_name: 'Gamma', website: 'gamma.test' });
    expect(mockWrites.map((w) => [w.email, w.domain_status, w.website_url])).toEqual([
      ['someone@gmail.com', 'PUBLIC_EMAIL', null],
      ['boss@gamma.test', 'CORPORATE_EMAIL', 'https://gamma.test'],
    ]);
  });

  it('400 with field errors only: required, too long, invalid - and nothing is read or written', async () => {
    const replies = [
      await submit({}),
      await submit({ ...full, email: 'not-an-email' }),
      await submit({ ...full, name: 'x'.repeat(121) }),
      await submit({ ...full, company_name: 'x'.repeat(161) }),
      await submit({ ...full, reason: 'x'.repeat(1001) }),
      await submit({ ...full, website: undefined }),
      await submit({ ...full, website: 'http://localhost:3000' }),
      await submit({ ...full, website: `https://beta.test/${'x'.repeat(2048)}` }),
      await submit({ ...full, email: `${'x'.repeat(250)}@a.test` }),
    ];
    expect(replies.map((r) => [r.status, r.body.fields])).toEqual([
      [400, { email: 'required', name: 'required', company_name: 'required' }],
      [400, { email: 'invalid' }],
      [400, { name: 'too_long' }],
      [400, { company_name: 'too_long' }],
      [400, { reason: 'too_long' }],
      [400, { website: 'required' }],
      [400, { website: 'invalid' }],
      [400, { website: 'too_long' }],
      [400, { email: 'too_long' }],
    ]);
    expect(mockWrites).toEqual([]);
    // Validation runs before the email limiter and the existence read: only the per-IP limiter was consulted.
    expect(mockRlCalls.every((c) => String(c.cfg.keyPrefix).endsWith(':ip'))).toBe(true);
  });

  it('a 400 never depends on existence: the same invalid body is answered identically whether or not the email has a request', async () => {
    const bad = { ...full, website: undefined };
    const miss = await submit(bad);
    mockDb.access_requests.push({ id: 'req-x', email: 'a.person@shared.test', status: 'approved', organization_id: 'org-x' });
    const hit = await submit(bad);
    expect(hit).toEqual(miss);
  });

  it('the legacy website_url key is accepted as the website', async () => {
    await submit({ email: 'c@delta.test', name: 'C', company_name: 'Delta', website_url: 'www.delta.test' });
    expect(mockWrites[0]).toEqual(expect.objectContaining({ website_url: 'https://delta.test', domain_status: 'CORPORATE_EMAIL' }));
  });
});

describe('503 only ever means "nothing was written"', () => {
  it('every 503 path writes nothing; the only failure after a write attempt is the 500', async () => {
    const answers: Array<[string, number, number]> = [];
    mockRlAnswer[':ip'] = OUTAGE;
    answers.push(['ip limiter down', (await submit(ok({ email: 'q@gmail.test', name: 'Q' }))).status, mockWrites.length]);
    delete mockRlAnswer[':ip'];
    mockRlAnswer[':email'] = OUTAGE;
    answers.push(['email limiter down', (await submit(ok({ email: 'q@gmail.test', name: 'Q' }))).status, mockWrites.length]);
    delete mockRlAnswer[':email'];
    mockReadFails = true;
    answers.push(['existence read failed', (await submit(ok({ email: 'q@gmail.test', name: 'Q' }))).status, mockWrites.length]);
    mockReadFails = false;
    mockInsertCode = 'XX000';
    answers.push(['insert failed', (await submit(ok({ email: 'q@gmail.test', name: 'Q' }))).status, mockWrites.length]);
    expect(answers).toEqual([
      ['ip limiter down', 503, 0],
      ['email limiter down', 503, 0],
      ['existence read failed', 503, 0],
      ['insert failed', 500, 0],
    ]);
  });
});

describe('vetted path: a malformed body is a 400, not a crash', () => {
  it('a body that is not JSON -> 400 with a field error, nothing written', async () => {
    const r = await submit('{not json' as unknown as Record<string, unknown>);
    expect([r.status, r.body]).toEqual([400, { error: 'Invalid request', fields: { body: 'invalid' } }]);
    expect(mockWrites).toEqual([]);
  });
});
