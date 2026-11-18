/**
 * OWNER rulings 2026-11-18 (via b3): a blog is a FIXED 40 credits on both blog routes.
 *   hold 40 BEFORE any AI call (refusal -> typed 402, nothing generated); success -> 40; quality-gate 422 -> refunded in
 *   full. OWNER general rule 2026-11-18: ANY failure on our side with nothing delivered -> released in full (was:
 *   min(40, ceil(40 x calls / 32)); that formula is now only the price of a DELIVERED partial blog, which no path
 *   produces). One blog = one hold. Every AI call carries the blog's reference id; the gateway's provider-call count
 *   is logged on every settle (b3: measure real cost per blog).
 *   b3 BLOCKING (7c): the Idempotency-Key is REQUIRED (no random fallback); a key still held by an in-flight run is
 *   409, never a second run; super-admin 'Blog Create' (job_type blog_generation) gates both routes.
 */
import * as fs from 'fs';
import * as path from 'path';

const calls: Array<{ fn: string; args: any[] }> = [];
let reserveResult: any = { status: 'reserved' };
let settleThrows = false;
jest.mock('../../services/creditExecutionService', () => ({
  reserveCreditsForWork: async (o: any) => { calls.push({ fn: 'reserve', args: [o] }); return reserveResult.status === 'reserved'
    ? { status: 'reserved', orgId: o.orgId, userId: o.userId, action: o.action, referenceType: o.referenceType, referenceId: o.referenceId,
        idempotencyKey: o.idempotencyKey, holdTransactionId: 'hold-1', creditsReserved: o.amountOverride, split: { free: o.amountOverride, paid: 0, incentive: 0 } }
    : reserveResult; },
  confirmCreditReservationToActual: async (h: any, n: number) => { if (settleThrows) throw new Error('ledger down'); calls.push({ fn: 'confirmToActual', args: [h, n], storedAtConfirm: mockStore.rows.length } as any); return { status: 'confirmed' }; },
  releaseCreditReservation: async (h: any) => { if (settleThrows) throw new Error('ledger down'); calls.push({ fn: 'release', args: [h] }); return { status: 'released' }; },
  makeIdempotencyKey: (...p: string[]) => p.join(':'),
  getReservationKeys: (k: string) => ({ holdKey: `${k}:hold`, confirmKey: `${k}:confirm`, releaseKey: `${k}:release` }),
  // ledger-faithful grant: idempotent on its key (a repeated key grants nothing more)
  createCredit: async (o: any) => {
    if (mockGrantThrows) throw new Error('[createCredit] grant failed: timeout');
    if (!mockGrants.some((g) => g.idempotencyKey === o.idempotencyKey)) mockGrants.push(o);
  },
}));
const mockGrants: any[] = [];
let mockGrantThrows = false;
// credit_transactions: the ORIGINAL confirm rows, by idempotency key
const mockConfirmRows = new Map<string, any>();
let mockLedgerReadFails = false;
jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: (t: string) => {
    if (t !== 'credit_transactions') throw new Error(`unexpected table ${t}`);
    const f: Record<string, unknown> = {};
    const chain: any = { select: () => chain, eq: (c: string, v: unknown) => { f[c] = v; return chain; },
      maybeSingle: async () => (mockLedgerReadFails ? { data: null, error: { message: 'timeout' } } : { data: mockConfirmRows.get(String(f.idempotency_key)) ?? null, error: null }) };
    return chain;
  } },
}));
const mockInfo = jest.fn();
jest.mock('../../services/logger', () => ({ logger: { info: (...a: unknown[]) => mockInfo(...a), warn: jest.fn(), error: jest.fn() } }));
let mockSwitch: any = { enabled: true };
const mockAnomalies: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockStore = require('../helpers/fakeIdempotencyStore').makeFakeIdempotencyStore();
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => mockStore.ownedDbTable(t) }));
const mockAudits: any[] = [];
jest.mock('../../services/billing/billingAuditEmitter', () => ({
  emitAnomaly: (a: unknown) => { mockAnomalies.push(a); },
  emitFinancialAudit: async (a: unknown) => { mockAudits.push(a); },
}));
jest.mock('../../services/intelligenceConfigService', () => ({
  getResolvedConfigStrict: async (companyId: string | null, jobType: string) => {
    if (mockSwitch instanceof Error) throw mockSwitch;
    return mockSwitch ? { job_type: jobType, companyId, ...mockSwitch } : null;
  },
}));

import {
  BLOG_CREDITS, holdBlog, isBlogHoldRefusal, partialBlogCredits, runBlogWithBilling, blogBillingOf,
  blogReferenceId, blogGenerationRefusal, isBlogRefusal, __resetBlogSwitchAbsentReportForTests, blogReplay,
  blogUnavailableRefundsOriginalCharge, blogUnavailableRefundedText,
} from '../../services/blog/blogBilling';
import { getActiveCreditHandle } from '../../services/billing/aiGatewayBillingGuard';

const ORG = '11111111-1111-4111-8111-111111111111';
const REF = '22222222-2222-4222-8222-222222222222';
class QualityGate extends Error {}
/** Simulates the gateway: each provider dispatch inside the scope calls the handle's onProviderCall. */
const providerCalls = (n: number) => { for (let i = 0; i < n; i++) getActiveCreditHandle()?.onProviderCall?.(); };

beforeEach(() => { calls.length = 0; reserveResult = { status: 'reserved' }; settleThrows = false; mockSwitch = { enabled: true }; mockInfo.mockClear();
  mockStore.rows.length = 0; mockStore.failInsert = false; mockStore.failRead = false; mockAnomalies.length = 0;
  mockGrants.length = 0; mockGrantThrows = false; mockConfirmRows.clear(); mockLedgerReadFails = false; mockAudits.length = 0; });

async function held() {
  const h = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: false });
  if (isBlogHoldRefusal(h)) throw new Error('expected a hold');
  calls.length = 0;
  return h.reservation;
}

describe('hold', () => {
  test('holds exactly 40 as blog_post, keyed on the request reference', async () => {
    await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(calls[0].args[0]).toMatchObject({ action: 'blog_post', amountOverride: 40, referenceId: REF, referenceType: 'blog_post' });
  });
  test('a key still HELD by an in-flight run (already_reserved) -> 409 BLOG_ALREADY_IN_PROGRESS, never a second run', async () => {
    reserveResult = { status: 'already_reserved' };
    const r = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'BLOG_ALREADY_IN_PROGRESS', retryable: true });
  });
  // b3 ruling 2026-11-18 replaces "-> 409 BLOG_RESULT_UNAVAILABLE + contact support": AUTO-REFUND, exactly once.
  const ORIGINAL_CONFIRM_KEY = `${ORG}:blog_post:${REF}:confirm`;
  const armOriginalCharge = () => mockConfirmRows.set(ORIGINAL_CONFIRM_KEY,
    { id: 'confirm-1', execution_phase: 'confirm_partial', free_delta: -30, paid_delta: -10, incentive_delta: 0 });
  test('charged earlier, NO stored copy -> the ORIGINAL charge is credited back per category, keyed on the original confirm; 409 says so', async () => {
    armOriginalCharge();
    reserveResult = { status: 'already_confirmed' };
    const r = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(r).toEqual({ ok: false, status: 409, code: 'BLOG_RESULT_UNAVAILABLE', retryable: false,
      error: "We couldn't recover this blog, so your 40 credits have been returned. You can write it again." });
    expect(mockGrants.map((g) => [g.category, g.amount, g.idempotencyKey, g.referenceType, g.referenceId])).toEqual([
      ['free', 30, 'blog_refund:confirm-1:free', 'blog_refund', 'confirm-1'],
      ['paid', 10, 'blog_refund:confirm-1:paid', 'blog_refund', 'confirm-1'],
    ]);
    expect(mockAudits).toEqual([expect.objectContaining({ actionType: 'system_refund', reason: 'blog_result_unavailable', amountCredits: 40 })]);
    expect(mockAnomalies).toEqual([expect.objectContaining({ kind: 'blog_result_lost', severity: 'critical' })]);
  });
  test('N retries of the same key -> ONE refund (the grant keys are the original confirm)', async () => {
    armOriginalCharge();
    reserveResult = { status: 'already_confirmed' };
    for (let i = 0; i < 4; i++) await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(mockGrants.reduce((n, g) => n + g.amount, 0)).toBe(40);
  });
  test('another org with the same key -> its own (absent) original charge: nothing refunded, 503 retryable', async () => {
    armOriginalCharge();
    reserveResult = { status: 'already_confirmed' };
    const OTHER = '99999999-9999-4999-8999-999999999999';
    const r = await holdBlog({ orgId: OTHER, userId: OTHER, referenceId: REF, validateMembership: true });
    expect(r).toMatchObject({ ok: false, status: 503, code: 'BLOG_REFUND_PENDING', retryable: true });
    expect(mockGrants).toEqual([]);
  });
  test('a refund WRITE failure -> 503 retryable, and the text claims NO refund (never a promise not kept)', async () => {
    armOriginalCharge(); mockGrantThrows = true;
    reserveResult = { status: 'already_confirmed' };
    const r = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(r).toMatchObject({ ok: false, status: 503, code: 'BLOG_REFUND_PENDING', retryable: true });
    expect((r as any).error).not.toMatch(/have been returned/);
    expect(mockAudits).toEqual([]);
  });
  test('the original charge cannot be READ -> 503 retryable, nothing granted', async () => {
    armOriginalCharge(); mockLedgerReadFails = true;
    reserveResult = { status: 'already_confirmed' };
    expect(await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true })).toMatchObject({ status: 503, retryable: true });
    expect(mockGrants).toEqual([]);
  });
  test('a protected org (Embrosales) is never auto-refunded - review text, no grant', async () => {
    const EMB = '73e5fa6f-0000-4000-8000-000000000000';
    mockConfirmRows.set(`${EMB}:blog_post:${REF}:confirm`, { id: 'c-emb', execution_phase: 'confirm', free_delta: -40, paid_delta: 0, incentive_delta: 0 });
    reserveResult = { status: 'already_confirmed' };
    const r = await holdBlog({ orgId: EMB, userId: EMB, referenceId: REF, validateMembership: true });
    expect(r).toMatchObject({ status: 409, code: 'BLOG_RESULT_UNAVAILABLE' });
    expect((r as any).error).not.toMatch(/returned/);
    expect(mockGrants).toEqual([]);
  });
  test('COUPLING (04/7c): the user-facing refund sentence is produced ONLY with a written refund equal to the charge', async () => {
    expect(blogUnavailableRefundsOriginalCharge()).toBe(true);
    armOriginalCharge();
    reserveResult = { status: 'already_confirmed' };
    const r: any = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    const claimed = Number(/your (\d+) credits have been returned/.exec(r.error)?.[1]);
    expect(claimed).toBe(mockGrants.reduce((n, g) => n + g.amount, 0));
    expect(blogUnavailableRefundedText(claimed)).toBe(r.error);
  });
  test('a key whose run failed and was released -> 409 BLOG_REQUEST_ENDED (not charged)', async () => {
    reserveResult = { status: 'already_released' };
    const r = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'BLOG_REQUEST_ENDED', retryable: false });
  });
  test('a refused hold is a typed 402 with required/available', async () => {
    reserveResult = { status: 'insufficient_credits', required: 40, available: 12 };
    const r = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(r).toMatchObject({ ok: false, status: 402, code: 'INSUFFICIENT_CREDITS', retryable: false, required: 40, available: 12 });
  });
});

describe('settle', () => {
  test.each([[0, 0], [1, 2], [8, 10], [16, 20], [31, 39], [32, 40], [50, 40]])('%i provider calls -> %i credits (min(40, ceil(40c/32)))', (c, n) => {
    expect(partialBlogCredits(c)).toBe(n);
  });

  test('success -> 40 charged, whatever the call count', async () => {
    const h = await held();
    const r = await runBlogWithBilling({ reservation: h, run: async () => { providerCalls(3); return { ok: 1 }; }, isQualityGateRefusal: () => false });
    expect(r.billing).toEqual({ charged: 40, released: 0, reason: 'completed' });
    expect(calls).toEqual([{ fn: 'confirmToActual', args: [expect.anything(), 40], storedAtConfirm: 1 }]);   // PERSISTED before the charge
  });

  test('7c/b3: written but NOT READABLE back -> NOT charged (released)', async () => {
    const h = await held();
    mockStore.failRead = true;
    const r = await runBlogWithBilling({ reservation: h, run: async () => ({ ok: 1 }), isQualityGateRefusal: () => false });
    expect(r.billing).toEqual({ charged: 0, released: 40, reason: 'unpersisted' });
    expect(calls.map((c) => c.fn)).toEqual(['release']);
  });
  test('b3 invariant: the blog cannot be persisted -> NOT charged (released), still returned', async () => {
    const h = await held();
    mockStore.failInsert = true;
    const r = await runBlogWithBilling({ reservation: h, run: async () => ({ ok: 1 }), isQualityGateRefusal: () => false });
    expect(r.result).toEqual({ ok: 1 });
    expect(r.billing).toEqual({ charged: 0, released: 40, reason: 'unpersisted' });
    expect(calls.map((c) => c.fn)).toEqual(['release']);
  });

  test('quality-gate 422 -> REFUNDED IN FULL (owner), the error re-thrown carrying the summary', async () => {
    const h = await held();
    let caught: unknown;
    try { await runBlogWithBilling({ reservation: h, run: async () => { providerCalls(32); throw new QualityGate('blocked'); }, isQualityGateRefusal: (e) => e instanceof QualityGate }); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(QualityGate);
    expect(blogBillingOf(caught)).toEqual({ charged: 0, released: 40, reason: 'quality_refund' });
    expect(calls.map((c) => c.fn)).toEqual(['release']);
  });

  test('OWNER: a failure AFTER 8 provider calls (nothing delivered) -> released in full, nothing charged', async () => {
    const h = await held();
    let caught: unknown;
    try { await runBlogWithBilling({ reservation: h, run: async () => { providerCalls(8); throw new Error('provider 500'); }, isQualityGateRefusal: () => false }); }
    catch (e) { caught = e; }
    expect(blogBillingOf(caught)).toEqual({ charged: 0, released: 40, reason: 'failed' });
    expect(calls.map((c) => c.fn)).toEqual(['release']);
    expect(mockInfo).toHaveBeenCalledWith('blog_credit_settled', expect.objectContaining({ reason: 'failed', charged: 0, providerCalls: 8 }));
  });

  test('a failure before any provider call -> released, nothing charged', async () => {
    const h = await held();
    let caught: unknown;
    try { await runBlogWithBilling({ reservation: h, run: async () => { throw new Error('boom'); }, isQualityGateRefusal: () => false }); }
    catch (e) { caught = e; }
    expect(blogBillingOf(caught)).toEqual({ charged: 0, released: 40, reason: 'failed' });
    expect(calls.map((c) => c.fn)).toEqual(['release']);
  });

  test('an ambiguous settle leaves the hold held (charged 0, released 0) - never released on doubt', async () => {
    const h = await held();
    settleThrows = true;
    const r = await runBlogWithBilling({ reservation: h, run: async () => ({ ok: 1 }), isQualityGateRefusal: () => false });
    expect(r.billing).toEqual({ charged: 0, released: 0, reason: 'completed', settlementPending: { code: 'CREDIT_SETTLE_AMBIGUOUS' } });
  });

  test('the counting scope is per blog: calls outside it are not counted', async () => {
    const h = await held();
    providerCalls(10);   // no active handle here
    await runBlogWithBilling({ reservation: h, run: async () => { providerCalls(2); return { ok: 1 }; }, isQualityGateRefusal: () => false });
    expect(mockInfo).toHaveBeenCalledWith('blog_credit_settled', expect.objectContaining({ reason: 'completed', providerCalls: 2 }));
  });
});

describe('replay store (b3 BLOCKING)', () => {
  test('a charged blog is replayed for the same org + key: same content, billing says nothing new was charged', async () => {
    const h = await held();
    await runBlogWithBilling({ reservation: h, run: async () => ({ title: 'T', html: '<p>x</p>' }), isQualityGateRefusal: () => false });
    const r = await blogReplay(ORG, REF);
    expect(r).toEqual({ ok: true, body: { title: 'T', html: '<p>x</p>', billing: { charged: 0, released: 0, reason: 'replayed' } } });
  });
  test('TENANT-SCOPED: another org with the same key gets no replay', async () => {
    const h = await held();
    await runBlogWithBilling({ reservation: h, run: async () => ({ title: 'T' }), isQualityGateRefusal: () => false });
    expect(await blogReplay('99999999-9999-4999-8999-999999999999', REF)).toEqual({ ok: true, body: null });
  });
  test('no stored result -> null (proceed to hold)', async () => {
    expect(await blogReplay(ORG, REF)).toEqual({ ok: true, body: null });
  });
  test('a store READ error -> 503 retryable, never "start a new request"', async () => {
    mockStore.failRead = true;
    expect(await blogReplay(ORG, REF)).toMatchObject({ ok: false, status: 503, code: 'BLOG_RESULT_READ_FAILED', retryable: true });
  });
  test('a failed run stores nothing (nothing to replay)', async () => {
    const h = await held();
    await runBlogWithBilling({ reservation: h, run: async () => { throw new Error('x'); }, isQualityGateRefusal: () => false }).catch(() => undefined);
    expect(mockStore.rows).toEqual([]);
  });
});

describe('Idempotency-Key required (b3 BLOCKING)', () => {
  test.each([[undefined], [''], ['short'], [['   ']]])('%p -> 400 IDEMPOTENCY_KEY_REQUIRED (no random fallback)', (h) => {
    const r = blogReferenceId(h);
    expect(isBlogRefusal(r)).toBe(true);
    expect(r).toMatchObject({ ok: false, status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED', retryable: false });
  });
  test('a sent key is the reference (trimmed), deterministic across calls', () => {
    expect(blogReferenceId('  click-key-123  ')).toEqual({ ok: true, referenceId: 'click-key-123' });
    expect(blogReferenceId(['click-key-123'])).toEqual(blogReferenceId('click-key-123'));
  });
});

describe("kill-switch: super-admin 'Blog Create' (job_type blog_generation)", () => {
  test('switched off -> 403 BLOG_GENERATION_DISABLED', async () => {
    mockSwitch = { enabled: false };
    expect(await blogGenerationRefusal(ORG)).toMatchObject({ ok: false, status: 403, code: 'BLOG_GENERATION_DISABLED', retryable: false });
  });
  test('on -> allowed (null)', async () => { expect(await blogGenerationRefusal(ORG)).toBeNull(); });
  test('a read error REFUSES (503, retryable) - never read as "on"', async () => {
    mockSwitch = new Error('db down');
    expect(await blogGenerationRefusal(ORG)).toMatchObject({ ok: false, status: 503, code: 'BLOG_SWITCH_UNAVAILABLE', retryable: true });
  });
  test('no switch row configured -> ALLOWED (b3), one alertable anomaly per PROCESS, not per request', async () => {
    __resetBlogSwitchAbsentReportForTests(); mockAnomalies.length = 0;
    mockSwitch = null;
    expect(await blogGenerationRefusal(ORG)).toBeNull();
    expect(await blogGenerationRefusal(ORG)).toBeNull();
    expect(await blogGenerationRefusal(null)).toBeNull();
    expect(mockAnomalies).toEqual([expect.objectContaining({ kind: 'blog_kill_switch_row_absent', severity: 'critical' })]);
  });
  test('control: a present row never reports the anomaly', async () => {
    __resetBlogSwitchAbsentReportForTests(); mockAnomalies.length = 0;
    await blogGenerationRefusal(ORG);
    expect(mockAnomalies).toEqual([]);
  });
});

describe('source pins', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
  test('the gateway counts a provider dispatch AFTER the cache / coalescing returns (recordGptCall site)', () => {
    const s = read('backend/services/aiGatewayProvidersOps.ts');
    const hook = s.indexOf('getActiveCreditHandle()?.onProviderCall?.()');
    expect(hook).toBeGreaterThan(s.indexOf('if (cachedContent !== null)'));
    expect(hook).toBeGreaterThan(s.indexOf('recordGptCall();'));
    expect(hook).toBeLessThan(s.indexOf('callProviderWithRetry(activeProvider'));
  });
  test.each(['pages/api/blogs/generate.ts', 'pages/api/admin/blog/generate.ts'])('%s: one blog = one hold - blogBilling only, no wirePhase2Route', (f) => {
    const s = read(f);
    expect(s).toMatch(/holdBlog\(/);
    expect(s).toMatch(/runBlogWithBilling\(/);
    expect(s).not.toMatch(/wirePhase2Route\(/);
    expect(s).toMatch(/referenceType: 'blog_post', referenceId/);   // every AI call carries the blog's reference id
    expect(s).toMatch(/blogGenerationRefusal\(company_id\)/);        // the kill-switch gates the route
    expect(s).toMatch(/if \(isBlogRefusal\(ref\)\)/);                 // no key -> refused before the hold
    expect(s.indexOf('isBlogRefusal(ref)')).toBeLessThan(s.indexOf('holdBlog('));
  });
  test('the customer billing page prices the CHARGED key blog_post, never blog_generation (price shown = price charged)', () => {
    const s = read('pages/company/billing/index.tsx');
    const list = s.slice(s.indexOf('const COST_REFERENCE_ACTIONS'), s.indexOf('];', s.indexOf('const COST_REFERENCE_ACTIONS')));
    expect(list).toContain("'blog_post'");
    expect(list).not.toContain("'blog_generation'");
  });
  test('BLOG_CREDITS is the owner price 40', () => { expect(BLOG_CREDITS).toBe(40); });
});
