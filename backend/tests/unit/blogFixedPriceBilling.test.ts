/**
 * OWNER rulings 2026-11-18 (via b3): a blog is a FIXED 40 credits on both blog routes.
 *   hold 40 BEFORE any AI call (refusal -> typed 402, nothing generated); success -> 40; quality-gate 422 -> refunded in
 *   full; any other failure -> min(40, ceil(40 x provider calls / 32)) counted by the gateway inside the blog's credit
 *   scope; 0 calls -> released. One blog = one hold (the routes no longer use wirePhase2Route('blog_generation')).
 *   Every AI call carries the blog's reference id (b3: measure real cost per blog).
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
jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import {
  BLOG_CREDITS, holdBlog, isBlogHoldRefusal, partialBlogCredits, runBlogWithBilling, blogBillingOf,
} from '../../services/blog/blogBilling';
import { getActiveCreditHandle } from '../../services/billing/aiGatewayBillingGuard';

const ORG = '11111111-1111-4111-8111-111111111111';
const REF = '22222222-2222-4222-8222-222222222222';
class QualityGate extends Error {}
/** Simulates the gateway: each provider dispatch inside the scope calls the handle's onProviderCall. */
const providerCalls = (n: number) => { for (let i = 0; i < n; i++) getActiveCreditHandle()?.onProviderCall?.(); };

beforeEach(() => { calls.length = 0; reserveResult = { status: 'reserved' }; settleThrows = false; });

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

  test('a run stopped after 8 provider calls -> charged 10, the rest released', async () => {
    const h = await held();
    let caught: unknown;
    try { await runBlogWithBilling({ reservation: h, run: async () => { providerCalls(8); throw new Error('boom'); }, isQualityGateRefusal: () => false }); }
    catch (e) { caught = e; }
    expect(blogBillingOf(caught)).toEqual({ charged: 10, released: 30, reason: 'partial' });
    expect(calls).toEqual([{ fn: 'confirmToActual', args: [expect.anything(), 10] }]);
  });

  test('a failure before any provider call -> released, nothing charged', async () => {
    const h = await held();
    let caught: unknown;
    try { await runBlogWithBilling({ reservation: h, run: async () => { throw new Error('boom'); }, isQualityGateRefusal: () => false }); }
    catch (e) { caught = e; }
    expect(blogBillingOf(caught)).toEqual({ charged: 0, released: 40, reason: 'not_started' });
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
    const r = await runBlogWithBilling({ reservation: h, run: async () => { throw new Error('x'); }, isQualityGateRefusal: () => false }).catch((e) => e);
    expect(blogBillingOf(r)).toMatchObject({ reason: 'not_started' });
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
  });
  test('BLOG_CREDITS is the owner price 40', () => { expect(BLOG_CREDITS).toBe(40); });
});
