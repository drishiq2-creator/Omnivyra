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
}));
// The base module owedRefunds is tested in its own suite (once, durable debt, the job pays). Here: what the blog does
// with each of its outcomes.
let mockCharge: any = { confirmTxnId: 'confirm-1', free: 30, paid: 10, incentive: 0 };
let mockChargeReadThrows = false;
let mockRefundOutcome: any = { status: 'granted', credits: 40 };
const mockRefundCalls: any[] = [];
jest.mock('../../services/billing/owedRefunds', () => ({
  readOriginalCharge: async (confirmKey: string) => { if (mockChargeReadThrows) throw new Error('timeout'); return confirmKey.startsWith(`${mockOrgId}:`) ? mockCharge : null; },
  refundOriginalCharge: async (a: any) => { mockRefundCalls.push(a); return mockRefundOutcome; },
}));
const mockOrgId = '11111111-1111-4111-8111-111111111111';
// the durable replay-failure counter (record_billed_result_replay_failure)
const mockReplayFailures = new Map<string, number>();
jest.mock('../../db/supabaseClient', () => ({
  supabase: { rpc: async (_fn: string, a: any) => {
    const k = `${a.p_scope}|${a.p_caller_id}|${a.p_key}`;
    const n = (mockReplayFailures.get(k) ?? 0) + 1; mockReplayFailures.set(k, n);
    return { data: [{ failures: n, first_failed_at: new Date().toISOString() }], error: null };
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
  blogUnavailableRefundsOriginalCharge, blogUnavailableRefundedText, blogUnavailableReturningText,
} from '../../services/blog/blogBilling';
import { getActiveCreditHandle } from '../../services/billing/aiGatewayBillingGuard';

const ORG = '11111111-1111-4111-8111-111111111111';
const REF = '22222222-2222-4222-8222-222222222222';
class QualityGate extends Error {}
/** Simulates the gateway: each provider dispatch inside the scope calls the handle's onProviderCall. */
const providerCalls = (n: number) => { for (let i = 0; i < n; i++) getActiveCreditHandle()?.onProviderCall?.(); };

beforeEach(() => { calls.length = 0; reserveResult = { status: 'reserved' }; settleThrows = false; mockSwitch = { enabled: true }; mockInfo.mockClear();
  mockStore.rows.length = 0; mockStore.failInsert = false; mockStore.failRead = false; mockAnomalies.length = 0;
  mockCharge = { confirmTxnId: 'confirm-1', free: 30, paid: 10, incentive: 0 }; mockChargeReadThrows = false;
  mockRefundOutcome = { status: 'granted', credits: 40 }; mockRefundCalls.length = 0; mockReplayFailures.clear(); mockAudits.length = 0; });

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
  // b3 rulings 2026-11-18: AUTO-REFUND = the system pays without the user acting. The blog records the debt through
  // owedRefunds (one row per ORIGINAL confirm; paid now or by the grant-only job) and tells the truth about its state.
  test('charged earlier, NO stored copy -> the ORIGINAL charge is refunded via the owed-refund record; 409 says it has been returned', async () => {
    reserveResult = { status: 'already_confirmed' };
    const r = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(r).toEqual({ ok: false, status: 409, code: 'BLOG_RESULT_UNAVAILABLE', retryable: false,
      error: "We couldn't recover this blog, so your 40 credits have been returned. You can write it again." });
    expect(mockRefundCalls).toEqual([expect.objectContaining({ orgId: ORG, performedBy: ORG, charge: mockCharge,
      reason: 'blog_result_unavailable', grantKeyPrefix: 'blog_refund', referenceId: REF })]);
    expect(mockAnomalies).toEqual([expect.objectContaining({ kind: 'blog_result_lost', severity: 'critical' })]);
  });
  test('the grant failed NOW but the debt is RECORDED -> the system pays it (job): 409 says the credits ARE BEING returned', async () => {
    reserveResult = { status: 'already_confirmed' };
    mockRefundOutcome = { status: 'owed', credits: 40 };
    const r: any = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(r).toMatchObject({ status: 409, code: 'BLOG_RESULT_UNAVAILABLE', retryable: false });
    expect(r.error).toBe(blogUnavailableReturningText(40));
    expect(r.error).not.toMatch(/have been returned/);
  });
  test('the debt cannot even be RECORDED -> 503 BLOG_REFUND_PENDING retryable, NO refund claim', async () => {
    reserveResult = { status: 'already_confirmed' };
    mockRefundOutcome = { status: 'unrecorded' };
    const r: any = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(r).toMatchObject({ status: 503, code: 'BLOG_REFUND_PENDING', retryable: true });
    expect(r.error).not.toMatch(/returned/);
  });
  test('the original charge cannot be READ -> 503 retryable, nothing recorded', async () => {
    reserveResult = { status: 'already_confirmed' };
    mockChargeReadThrows = true;
    expect(await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true })).toMatchObject({ status: 503, retryable: true });
    expect(mockRefundCalls).toEqual([]);
  });
  test('no confirmed charge under this key -> 409 "you were not charged", nothing recorded', async () => {
    reserveResult = { status: 'already_confirmed' };
    mockCharge = null;
    const r: any = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(r).toMatchObject({ status: 409, code: 'BLOG_RESULT_UNAVAILABLE' });
    expect(r.error).toMatch(/not charged/);
    expect(mockRefundCalls).toEqual([]);
  });
  test('a protected org (owedRefunds says protected) -> review text, no refund claim', async () => {
    reserveResult = { status: 'already_confirmed' };
    mockRefundOutcome = { status: 'protected' };
    const r: any = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(r).toMatchObject({ status: 409, code: 'BLOG_RESULT_UNAVAILABLE' });
    expect(r.error).not.toMatch(/returned/);
  });
  test('COUPLING (04/7c): a "returned" sentence is produced ONLY from a granted refund, with ITS credit figure', async () => {
    expect(blogUnavailableRefundsOriginalCharge()).toBe(true);
    reserveResult = { status: 'already_confirmed' };
    mockRefundOutcome = { status: 'granted', credits: 37 };
    const r: any = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(r.error).toBe(blogUnavailableRefundedText(37));
    for (const status of ['owed', 'unrecorded', 'protected']) {
      mockRefundOutcome = status === 'owed' ? { status, credits: 37 } : { status };
      const x: any = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
      expect([status, /have been returned/.test(x.error)]).toEqual([status, false]);
    }
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
    const r = await blogReplay(ORG, REF, { userId: ORG });
    expect(r).toEqual({ ok: true, body: { title: 'T', html: '<p>x</p>', billing: { charged: 0, released: 0, reason: 'replayed' } } });
  });
  test('TENANT-SCOPED: another org with the same key gets no replay', async () => {
    const h = await held();
    await runBlogWithBilling({ reservation: h, run: async () => ({ title: 'T' }), isQualityGateRefusal: () => false });
    expect(await blogReplay('99999999-9999-4999-8999-999999999999', REF, { userId: ORG })).toEqual({ ok: true, body: null });
  });
  test('no stored result -> null (proceed to hold)', async () => {
    expect(await blogReplay(ORG, REF, { userId: ORG })).toEqual({ ok: true, body: null });
  });
  test('a store READ error -> 503 retryable while the DURABLE count is below 3, never "start a new request"', async () => {
    mockStore.failRead = true;
    expect(await blogReplay(ORG, REF, { userId: ORG })).toMatchObject({ ok: false, status: 503, code: 'BLOG_RESULT_READ_FAILED', retryable: true });
    expect(await blogReplay(ORG, REF, { userId: ORG })).toMatchObject({ status: 503, retryable: true });
    expect(mockRefundCalls).toEqual([]);
  });
  test('b3: the 3rd durable read failure is TERMINAL -> the refund path (the loop ends; no endless "try again")', async () => {
    mockStore.failRead = true;
    await blogReplay(ORG, REF, { userId: ORG }); await blogReplay(ORG, REF, { userId: ORG });
    const r: any = await blogReplay(ORG, REF, { userId: ORG });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'BLOG_RESULT_UNAVAILABLE', retryable: false });
    expect(r.error).toBe(blogUnavailableRefundedText(40));
    expect(mockRefundCalls).toHaveLength(1);
  });
  test('terminal on the PLATFORM scope refunds nothing (nothing was charged)', async () => {
    mockStore.failRead = true;
    for (let i = 0; i < 2; i++) await blogReplay(ORG, REF, { scope: 'blog_post_platform', userId: ORG });
    const r: any = await blogReplay(ORG, REF, { scope: 'blog_post_platform', userId: ORG });
    expect(r).toMatchObject({ status: 409, code: 'BLOG_RESULT_UNAVAILABLE' });
    expect(mockRefundCalls).toEqual([]);
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
  // b3 2026-11-18 (adopting 7c) replaces "no switch row configured -> ALLOWED": migration 060 guarantees the row, so an
  // ABSENT row is a deliberate delete - the incident switch - and blogs FAIL CLOSED.
  test('the switch row ABSENT -> FAIL CLOSED (403), one alertable anomaly per PROCESS, not per request', async () => {
    __resetBlogSwitchAbsentReportForTests(); mockAnomalies.length = 0;
    mockSwitch = null;
    expect(await blogGenerationRefusal(ORG)).toMatchObject({ ok: false, status: 403, code: 'BLOG_GENERATION_DISABLED' });
    expect(await blogGenerationRefusal(ORG)).toMatchObject({ status: 403 });
    expect(await blogGenerationRefusal(null)).toMatchObject({ status: 403 });
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
  test('the super-admin public-blog route is PLATFORM spend: no hold, no settle, no wirePhase2Route (b3 4a)', () => {
    const s = read('pages/api/admin/blog/generate.ts');
    expect(s).not.toMatch(/holdBlog\(|runBlogWithBilling\(|wirePhase2Route\(/);
    expect(s).toMatch(/blogGenerationRefusal\(company_id\)/);
    expect(s).toMatch(/if \(isBlogRefusal\(ref\)\)/);
    expect(s).toMatch(/blogReplay\(company_id, referenceId, \{ scope: BLOG_PLATFORM_SCOPE, userId: roleGate\.userId \}\)/);
  });
  test.each(['pages/api/blogs/generate.ts'])('%s: one blog = one hold - blogBilling only, no wirePhase2Route', (f) => {
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
