/**
 * A8 step 2 (b3 2026-11-20): render-inline's paid AI images are capped per company per UTC day and per request,
 * counted in Redis, FAIL CLOSED when the counter cannot be read. REAL: inlineImageBudget. FAKED: the Redis client
 * (in-memory INCR/DECR/PEXPIRE, or one that throws / is absent).
 */
import {
  admitInlineImage, runWithInlineImageBudget, __setInlineImageRedisForTests, dailyKey, dailyCap, requestCap,
  INLINE_IMAGE_REFUSALS, INLINE_IMAGE_REFUSAL_HTTP, DEFAULT_DAILY_CAP, DEFAULT_REQUEST_CAP,
} from '../../services/creator/inlineImageBudget';

const store = new Map<string, number>();
const fakeRedis = {
  incr: async (k: string) => { const n = (store.get(k) ?? 0) + 1; store.set(k, n); return n; },
  decr: async (k: string) => { const n = (store.get(k) ?? 0) - 1; store.set(k, n); return n; },
  pexpire: async () => 1,
};
const CO = 'c0a00000-0000-4000-8000-0000000000aa';

beforeEach(() => {
  store.clear();
  delete process.env.CREATOR_INLINE_IMAGE_DAILY_CAP;
  delete process.env.CREATOR_INLINE_IMAGE_REQUEST_CAP;
  __setInlineImageRedisForTests(async () => fakeRedis);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { __setInlineImageRedisForTests(null); jest.restoreAllMocks(); });

/** Admit `n` images inside ONE request scope; returns how many were admitted and the scope. */
async function request(n: number, company = CO) {
  let admitted = 0;
  const { scope } = await runWithInlineImageBudget(company, async () => {
    for (let i = 0; i < n; i++) if (await admitInlineImage()) admitted += 1;
  });
  return { admitted, scope };
}

describe('inline AI image budget', () => {
  it('OUTSIDE a render-inline scope nothing is counted (worker / render-image untouched)', async () => {
    expect(await admitInlineImage()).toBe(true);
    expect(store.size).toBe(0);
  });

  it('defaults: 40 per company per UTC day, 12 per request', () => {
    expect([dailyCap(), requestCap()]).toEqual([DEFAULT_DAILY_CAP, DEFAULT_REQUEST_CAP]);
    expect([DEFAULT_DAILY_CAP, DEFAULT_REQUEST_CAP]).toEqual([40, 12]);
  });

  it('the DAILY cap: the 41st image of the day is refused (no unit kept past the cap); another company is separate', async () => {
    for (let i = 0; i < 4; i++) expect((await request(10)).admitted).toBe(10);
    const over = await request(1);
    expect(over.admitted).toBe(0);
    expect(over.scope.refusal).toBe('IMAGE_DAILY_LIMIT_REACHED');
    expect(store.get(dailyKey(CO))).toBe(40); // the refused increment was rolled back
    expect((await request(1, 'c0b00000-0000-4000-8000-0000000000bb')).admitted).toBe(1); // CONTROL: per company
  });

  it('the REQUEST cap: a 13th image in one request is refused, and the request makes no further paid calls', async () => {
    const r = await request(15);
    expect(r.admitted).toBe(12);
    expect(r.scope.refusal).toBe('IMAGE_REQUEST_LIMIT_REACHED');
    expect(store.get(dailyKey(CO))).toBe(12);
  });

  it('cap 0 = AI images OFF; a malformed or negative cap falls back to the default, never unlimited', async () => {
    process.env.CREATOR_INLINE_IMAGE_DAILY_CAP = '0';
    expect((await request(1)).scope.refusal).toBe('IMAGE_DAILY_LIMIT_REACHED');
    for (const bad of ['abc', '-5', '2.5']) { process.env.CREATOR_INLINE_IMAGE_DAILY_CAP = bad; expect(dailyCap()).toBe(DEFAULT_DAILY_CAP); }
  });

  it('FAIL CLOSED: Redis not configured, or erroring, refuses with IMAGE_QUOTA_UNAVAILABLE (never allowed uncounted)', async () => {
    __setInlineImageRedisForTests(async () => null);
    expect((await request(1)).scope).toMatchObject({ refusal: 'IMAGE_QUOTA_UNAVAILABLE', used: 0 });
    __setInlineImageRedisForTests(async () => ({ ...fakeRedis, incr: async () => { throw new Error('ECONNRESET'); } }));
    expect((await request(1)).scope).toMatchObject({ refusal: 'IMAGE_QUOTA_UNAVAILABLE', used: 0 });
  });

  it('UNION COVERAGE: every refusal maps to a non-2xx answer and the map has no extra keys; unavailable carries Retry-After', () => {
    expect(Object.keys(INLINE_IMAGE_REFUSAL_HTTP).sort()).toEqual([...INLINE_IMAGE_REFUSALS].sort());
    for (const code of INLINE_IMAGE_REFUSALS) expect(INLINE_IMAGE_REFUSAL_HTTP[code].status).toBeGreaterThanOrEqual(400);
    expect(INLINE_IMAGE_REFUSAL_HTTP.IMAGE_QUOTA_UNAVAILABLE).toMatchObject({ status: 503, retryAfterSeconds: 30 });
    expect(INLINE_IMAGE_REFUSAL_HTTP.IMAGE_DAILY_LIMIT_REACHED.status).toBe(429);
  });
});
