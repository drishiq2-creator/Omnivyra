/**
 * OWNER 2026-11-18: the company blog route (/api/blogs/generate) bills a FIXED 40 credits per blog - executed, not pinned:
 * refusal -> 402 and NO generation; 'angles' is not billed; a full blog holds 40 and every AI call carries the blog's
 * reference id; a quality-gate 422 is refunded in full.
 * b3 BLOCKING (7c): no Idempotency-Key -> 400 with nothing held; the same key twice -> one charge; super-admin
 * 'Blog Create' switched off -> BOTH blog routes refuse with nothing held.
 */
const gens: any[] = [];
let genOutcome: 'ok' | 'quality' = 'ok';
const ledger: Array<{ fn: string; n?: number }> = [];
let reserveStatus = 'reserved';
const settledKeys = new Set<string>();
let mockSwitchEnabled = true;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockStore = require('../helpers/fakeIdempotencyStore').makeFakeIdempotencyStore();
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => mockStore.ownedDbTable(t) }));
jest.mock('../../services/billing/billingAuditEmitter', () => ({ emitAnomaly: jest.fn() }));
jest.mock('../../services/intelligenceConfigService', () => ({
  getResolvedConfigStrict: async () => ({ job_type: 'blog_generation', enabled: mockSwitchEnabled }),
}));
class QualityGateErr extends Error { report = {}; }
jest.mock('../../services/longForm/thoughtLeadershipQualityGate', () => ({ ThoughtLeadershipQualityGateError: QualityGateErr }));
jest.mock('../../../lib/content/unifiedLongFormEngine', () => ({
  runUnifiedLongFormGeneration: async (input: any) => { gens.push(input); if (genOutcome === 'quality') throw new QualityGateErr('blocked'); return { blog: 'ok' }; },
}));
jest.mock('../../services/userContextService', () => ({ enforceCompanyAccess: async () => ({ userId: 'u1' }) }));
jest.mock('../../services/rbacService', () => ({ Role: { COMPANY_ADMIN: 'COMPANY_ADMIN', CONTENT_CREATOR: 'CONTENT_CREATOR', CONTENT_REVIEWER: 'CONTENT_REVIEWER', CONTENT_PUBLISHER: 'CONTENT_PUBLISHER', SUPER_ADMIN: 'SUPER_ADMIN' }, enforceRole: async () => ({ userId: '33333333-3333-4333-8333-333333333333', role: 'COMPANY_ADMIN' }) }));
jest.mock('../../../lib/content/buildContentContext', () => ({ buildContentContext: async () => ({}) }));
const mockEnqueued: any[] = [];
jest.mock('../../queue/contentGenerationQueues', () => ({ getContentQueue: () => ({ name: 'content-blog' }) }));
jest.mock('../../adapters/commandCenter/blogContentAdapter', () => ({ generateBlogContent: async (...a: any[]) => { mockEnqueued.push(a); return {}; } }));
jest.mock('../../services/creditExecutionService', () => ({
  reserveCreditsForWork: async (o: any) => { ledger.push({ fn: 'reserve', n: o.amountOverride });
    if (settledKeys.has(o.idempotencyKey)) return { status: 'already_confirmed' };
    return reserveStatus === 'reserved'
    ? { status: 'reserved', orgId: o.orgId, userId: o.userId, action: o.action, referenceType: o.referenceType, referenceId: o.referenceId, idempotencyKey: o.idempotencyKey, holdTransactionId: 'h', creditsReserved: o.amountOverride, split: { free: 40, paid: 0, incentive: 0 } }
    : { status: 'insufficient_credits', required: 40, available: 5 }; },
  confirmCreditReservationToActual: async (h: any, n: number) => { ledger.push({ fn: 'confirm', n }); settledKeys.add(h.idempotencyKey); return { status: 'confirmed' }; },
  releaseCreditReservation: async () => { ledger.push({ fn: 'release' }); return { status: 'released' }; },
  makeIdempotencyKey: (...p: string[]) => p.join(':'),
}));

import route from '../../../pages/api/blogs/generate';
import adminRoute from '../../../pages/api/admin/blog/generate';

const CO = '11111111-1111-4111-8111-111111111111';
const KEY = { 'idempotency-key': 'click-key-0001' };
function call(body: any, headers: Record<string, string> = {}, handler: any = route) {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  res.setHeader = () => res; res.end = () => res;
  return Promise.resolve((handler as any)({ method: 'POST', body, headers, query: {}, url: '/api/blogs/generate', socket: {} }, res)).then(() => res);
}
beforeEach(() => { gens.length = 0; ledger.length = 0; genOutcome = 'ok'; reserveStatus = 'reserved'; settledKeys.clear(); mockSwitchEnabled = true; mockStore.rows.length = 0; mockStore.failRead = false; mockStore.failInsert = false; });

test('a refused hold -> 402 INSUFFICIENT_CREDITS and NO generation (no AI call)', async () => {
  reserveStatus = 'insufficient';
  const r = await call({ company_id: CO, topic: 'x', mode: 'full' }, KEY);
  expect(r.statusCode).toBe(402);
  expect(r.body).toMatchObject({ code: 'INSUFFICIENT_CREDITS', required: 40, available: 5 });
  expect(gens).toEqual([]);
});

test("'angles' is not a blog: no hold, generated without billing", async () => {
  const r = await call({ company_id: CO, topic: 'x', mode: 'angles' });
  expect(r.statusCode).toBe(200);
  expect(ledger).toEqual([]);
  expect(gens).toHaveLength(1);
});

test('a full blog holds 40, carries the blog reference id on every AI call, charges 40, returns billing', async () => {
  const r = await call({ company_id: CO, topic: 'x', mode: 'full' }, { 'idempotency-key': 'client-key-123456' });
  expect(ledger).toEqual([{ fn: 'reserve', n: 40 }, { fn: 'confirm', n: 40 }]);
  expect(gens[0].correlation).toEqual({ referenceType: 'blog_post', referenceId: 'client-key-123456', parentActivityId: null });
  expect(r.statusCode).toBe(200);
  expect(r.body.billing).toEqual({ charged: 40, released: 0, reason: 'completed' });
});

test('a quality-gate 422 is refunded in full and says so', async () => {
  genOutcome = 'quality';
  const r = await call({ company_id: CO, topic: 'x', mode: 'full' }, KEY);
  expect(r.statusCode).toBe(422);
  expect(ledger).toEqual([{ fn: 'reserve', n: 40 }, { fn: 'release' }]);
  expect(r.body.billing).toEqual({ charged: 0, released: 40, reason: 'quality_refund' });
});

describe.each([['company /api/blogs/generate', route], ['super-admin /api/admin/blog/generate', adminRoute]])('%s', (_n, handler) => {
  test('NO Idempotency-Key -> 400 IDEMPOTENCY_KEY_REQUIRED, nothing held, no AI call', async () => {
    const r = await call({ company_id: CO, topic: 'x', mode: 'full' }, {}, handler);
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED', retryable: false });
    expect(ledger).toEqual([]);
    expect(gens).toEqual([]);
  });
  test('LOST RESPONSE: a retry with the SAME key gets the SAME blog back (200), one 40 charge, one generation', async () => {
    const a = await call({ company_id: CO, topic: 'x', mode: 'full' }, KEY, handler);   // pretend this response was lost
    const b = await call({ company_id: CO, topic: 'x', mode: 'full' }, KEY, handler);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(b.body.blog).toEqual(a.body.blog);
    expect(b.body.billing).toEqual({ charged: 0, released: 0, reason: 'replayed' });
    expect(ledger.filter((l) => l.fn === 'confirm')).toEqual([{ fn: 'confirm', n: 40 }]);
    expect(ledger.filter((l) => l.fn === 'reserve')).toHaveLength(1);   // the replay takes no new hold
    expect(gens).toHaveLength(1);
  });
  test('a different org with the same key -> no replay: its own hold, generation and charge', async () => {
    const OTHER = '44444444-4444-4444-8444-444444444444';
    await call({ company_id: CO, topic: 'x', mode: 'full' }, KEY, handler);
    const b = await call({ company_id: OTHER, topic: 'x', mode: 'full' }, KEY, handler);
    expect(b.statusCode).toBe(200);
    expect(b.body.billing).toEqual({ charged: 40, released: 0, reason: 'completed' });
    expect(gens).toHaveLength(2);
  });
  test('the replay store cannot be read -> 503 retryable, nothing held, nothing generated', async () => {
    mockStore.failRead = true;
    const r = await call({ company_id: CO, topic: 'x', mode: 'full' }, KEY, handler);
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatchObject({ code: 'BLOG_RESULT_READ_FAILED', retryable: true });
    expect(ledger).toEqual([]);
    expect(gens).toEqual([]);
  });
  test("'Blog Create' switched OFF -> 403 BLOG_GENERATION_DISABLED, nothing held, no AI call (every mode)", async () => {
    mockSwitchEnabled = false;
    for (const mode of ['full', 'angles']) {
      const r = await call({ company_id: CO, topic: 'x', mode }, KEY, handler);
      expect([mode, r.statusCode, r.body?.code]).toEqual([mode, 403, 'BLOG_GENERATION_DISABLED']);
    }
    expect(ledger).toEqual([]);
    expect(gens).toEqual([]);
  });
});

test('b3: NO mode (the legacy unbilled queue path) -> 400 BLOG_MODE_REQUIRED, nothing enqueued, held or generated', async () => {
  for (const mode of [undefined, '', 'queue', 'FULL']) {
    const r = await call({ company_id: CO, topic: 'x', ...(mode === undefined ? {} : { mode }) }, KEY);
    expect([mode, r.statusCode, r.body?.code]).toEqual([mode, 400, 'BLOG_MODE_REQUIRED']);
  }
  expect(mockEnqueued).toEqual([]);
  expect(ledger).toEqual([]);
  expect(gens).toEqual([]);
});
