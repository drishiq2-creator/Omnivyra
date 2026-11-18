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
  confirmCreditReservationToActual: async (h: any, n: number) => { if (settleThrows) throw new Error('ledger down'); calls.push({ fn: 'confirmToActual', args: [h, n] }); return { status: 'confirmed' }; },
  releaseCreditReservation: async (h: any) => { if (settleThrows) throw new Error('ledger down'); calls.push({ fn: 'release', args: [h] }); return { status: 'released' }; },
  makeIdempotencyKey: (...p: string[]) => p.join(':'),
}));
const mockInfo = jest.fn();
jest.mock('../../services/logger', () => ({ logger: { info: (...a: unknown[]) => mockInfo(...a), warn: jest.fn(), error: jest.fn() } }));
let mockSwitch: any = { enabled: true };
jest.mock('../../services/intelligenceConfigService', () => ({
  getResolvedConfigStrict: async (companyId: string | null, jobType: string) => {
    if (mockSwitch instanceof Error) throw mockSwitch;
    return mockSwitch ? { job_type: jobType, companyId, ...mockSwitch } : null;
  },
}));

import {
  BLOG_CREDITS, holdBlog, isBlogHoldRefusal, partialBlogCredits, runBlogWithBilling, blogBillingOf,
  blogReferenceId, blogGenerationRefusal, isBlogRefusal,
} from '../../services/blog/blogBilling';
import { getActiveCreditHandle } from '../../services/billing/aiGatewayBillingGuard';

const ORG = '11111111-1111-4111-8111-111111111111';
const REF = '22222222-2222-4222-8222-222222222222';
class QualityGate extends Error {}
/** Simulates the gateway: each provider dispatch inside the scope calls the handle's onProviderCall. */
const providerCalls = (n: number) => { for (let i = 0; i < n; i++) getActiveCreditHandle()?.onProviderCall?.(); };

beforeEach(() => { calls.length = 0; reserveResult = { status: 'reserved' }; settleThrows = false; mockSwitch = { enabled: true }; mockInfo.mockClear(); });

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
  test('a key already settled (already_confirmed) -> 409 RESERVATION_ALREADY_SETTLED (the same click is charged once)', async () => {
    reserveResult = { status: 'already_confirmed' };
    const r = await holdBlog({ orgId: ORG, userId: ORG, referenceId: REF, validateMembership: true });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'RESERVATION_ALREADY_SETTLED', retryable: false });
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
    expect(calls).toEqual([{ fn: 'confirmToActual', args: [expect.anything(), 40] }]);
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
    await runBlogWithBilling({ reservation: h, run: async () => { providerCalls(2); return 1; }, isQualityGateRefusal: () => false });
    expect(mockInfo).toHaveBeenCalledWith('blog_credit_settled', expect.objectContaining({ reason: 'completed', providerCalls: 2 }));
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
  test('no switch row configured -> allowed (logged)', async () => {
    mockSwitch = null;
    expect(await blogGenerationRefusal(ORG)).toBeNull();
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
