/**
 * LIVE billing refusals (04, 2026-11-20; b3: money, ahead of the 18 wired routes). The routes that bill TODAY go
 * through runBilledAiCompletion, which threw a plain Error ("status=insufficient_credits" only in its message), so
 * chat-brief showed the internal text, field/campaign assist fell back silently, and refine_variant answered a
 * generic 500.
 *
 * Now:
 *   - a billing refusal is a typed BillingRefusalError carrying a CODE from shared/billing/billingRefusalCodes.ts;
 *   - routes answer its status + code;
 *   - the assist routes keep their deterministic fallback but flag it (billing_refusal_code);
 *   - clients map the code to client copy (lib/billing/billingRefusalCopy.ts).
 */
let orchestratorStatus = 'executed';
let orchestratorThrows: Error | null = null;
/** When set, the mock runs the REAL executor (the provider call) first, then throws this: a SETTLEMENT-time failure. */
let throwAfterExecutor: Error | null = null;
jest.mock('../../services/billing/enterpriseBillingOrchestrator', () => ({
  runBilledOperation: jest.fn(async (opts: any) => {
    if (orchestratorThrows) throw orchestratorThrows;
    if (throwAfterExecutor) { await opts.executor(); throw throwAfterExecutor; }
    return ({
    operationId: 'op', correlationId: 'c', idempotencyKey: 'k',
    result: orchestratorStatus === 'executed'
      ? { status: 'executed', result: 'text', settlement: { actualUsage: { inputTokens: 1, outputTokens: 1 } } }
      : { status: orchestratorStatus },
  }); }),
}));
const providerCalls: number[] = [];
jest.mock('../../services/aiGateway', () => ({
  runCompletionWithOperation: jest.fn(async () => {
    providerCalls.push(1);
    return { output: 'AI TEXT', metadata: { token_usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, provider: 'openai', model: 'gpt-4o-mini' } };
  }),
}));
jest.mock('../../services/billing/aiGatewayBillingGuard', () => ({
  checkAiBillingGuard: jest.fn(), runWithCreditHandle: (_h: unknown, fn: () => unknown) => fn(),
}));

import fs from 'fs';
import path from 'path';
import {
  runBilledAiCompletion, BillingRefusalError, isBillingRefusalError, isPriceResolutionError,
} from '../../services/billing/runBilledAiCompletion';
import {
  BILLING_REFUSAL_CODES, BILLING_REFUSAL_HTTP_STATUS, billingRefusalCodeForOrchestratorStatus,
} from '../../../shared/billing/billingRefusalCodes';
import {
  BILLING_FALLBACK_NOTE, BILLING_REFUSAL_COPY, billingFallbackNote, describeBillingRefusal, userErrorMessage,
  BillingRefusalNotice, throwIfBillingRefusal,
} from '../../../lib/billing/billingRefusalCopy';

const ARGS = {
  module: 'test', userId: 'u', orgId: 'o', action: 'content_rewrite', referenceType: 't', referenceId: 'r',
  llmPricing: { provider: 'openai', model: 'gpt-4o-mini', maxInputTokens: 10, maxOutputTokens: 10, actionKey: 'content_rewrite' },
  idempotency: { kind: 'http', actorUserId: 'u', action: 'content_rewrite', referenceId: 'r', requestBody: {} },
  completion: { model: 'gpt-4o-mini', messages: [], max_tokens: 10, operation: 'x' },
} as any;

describe('runBilledAiCompletion: a billing refusal is TYPED, anything else is unchanged', () => {
  it.each<[string, string, number]>([
    ['insufficient_credits', 'INSUFFICIENT_CREDITS', 402],
    ['no_credit_account', 'NO_CREDIT_ACCOUNT', 402],
    ['not_a_member', 'ORG_SCOPE_VIOLATION', 403],
    ['org_control_blocked', 'ORG_CONTROL_BLOCKED', 403],
  ])('orchestrator %s → BillingRefusalError(%s, %d)', async (status, code, http) => {
    orchestratorStatus = status;
    const err = await runBilledAiCompletion(ARGS).catch((e) => e);
    expect(isBillingRefusalError(err)).toBe(true);
    expect(err).toBeInstanceOf(BillingRefusalError);
    expect(err).toMatchObject({ code, httpStatus: http, orchestratorStatus: status });
  });

  it.each(['error', 'already_confirmed', 'already_released'])('orchestrator %s is NOT a billing refusal (a plain Error, as before)', async (status) => {
    orchestratorStatus = status;
    const err = await runBilledAiCompletion(ARGS).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isBillingRefusalError(err)).toBe(false);
  });

  it('control: executed returns the text', async () => {
    orchestratorStatus = 'executed';
    await expect(runBilledAiCompletion(ARGS)).resolves.toMatchObject({ text: 'text' });
  });
});

describe('a PRICE that cannot be resolved is PRICING_UNAVAILABLE (503 + Retry-After), never a generic 500 (7c)', () => {
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });
  afterEach(() => { orchestratorThrows = null; throwAfterExecutor = null; providerCalls.length = 0; });

  it.each<[string, Error]>([
    ['PricingMissingError at settlement', Object.assign(new Error("No active pricing for provider='openai' model='gpt-4o-mini' kind='output'."), { name: 'PricingMissingError' })],
    ['a model-pricing lookup error at settlement', new Error('[pricingService] Model pricing lookup failed for openai/gpt-4o-mini/output: timeout')],
  ])('BLOCKING (7c): %s AFTER the provider call → the work is DELIVERED (settlementUnpriced), NEVER a retryable refusal', async (_n, err) => {
    throwAfterExecutor = err;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const out = await runBilledAiCompletion(ARGS).catch((x) => x);
    expect(isBillingRefusalError(out)).toBe(false);          // no 503 / Retry-After / "try again"
    expect(out).toMatchObject({ settlementUnpriced: true, text: 'AI TEXT' });
    // NB-B: no fake ids or zero usage on an unsettled call.
    expect(out).toMatchObject({ operationId: null, correlationId: null, idempotencyKey: null, promptTokens: null, completionTokens: null });
    expect(providerCalls).toHaveLength(1);                   // the provider ran exactly once
    const line = errSpy.mock.calls.find((c) => String(c[0]).includes('billed_ai_settlement_unpriced'));
    expect(line).toBeDefined(); // reconciliation signal
    // NB-A: it carries the JOIN KEYS, so it can be reconciled against the request and its ledger attempt.
    expect(JSON.parse(String(line![1]))).toMatchObject({ referenceId: 'r', idempotencyReferenceId: 'r', orgId: 'o', action: 'content_rewrite' });
    errSpy.mockRestore();
  });

  it('control: the SAME error BEFORE the provider call is still PRICING_UNAVAILABLE (nothing ran)', async () => {
    orchestratorThrows = Object.assign(new Error('x'), { name: 'PricingMissingError' });
    const e = await runBilledAiCompletion(ARGS).catch((x) => x);
    expect(e).toMatchObject({ code: 'PRICING_UNAVAILABLE' });
    expect(providerCalls).toHaveLength(0);
  });

  it.each<[string, Error]>([
    ['PricingMissingError (no active model price)', named('PricingMissingError', "No active pricing for provider='openai' model='x' kind='input'.")],
    ['a model-pricing lookup error', new Error('[pricingService] Model pricing lookup failed for openai/gpt-4o-mini/input: timeout')],
    ['a missing action_pricing_config row', new Error("[pricingService] Missing action_pricing_config row for actionKey='content_rewrite'")],
    ['a credit_rate_usd lookup error', new Error('[pricingService] credit_rate_usd lookup failed for org o: timeout')],
    ['getCreditCost: missing row', new Error('[creditDeduction] missing credit cost config for blog')],
    ['getCreditCost: lookup failed', new Error('[creditDeduction] credit cost lookup failed for blog: timeout')],
  ])('%s → BillingRefusalError(PRICING_UNAVAILABLE, 503)', async (_n, err) => {
    orchestratorThrows = err;
    const e = await runBilledAiCompletion(ARGS).catch((x) => x);
    expect(e).toBeInstanceOf(BillingRefusalError);
    expect(e).toMatchObject({ code: 'PRICING_UNAVAILABLE', httpStatus: 503 });
  });

  it.each<[string, Error]>([
    ['a validation error ("… is required")', new Error('[pricingService] provider is required')],
    ['the AI call itself failing', new Error('openai 500 upstream')],
  ])('control: %s is NOT a price failure (propagates unchanged)', async (_n, err) => {
    orchestratorThrows = err;
    const e = await runBilledAiCompletion(ARGS).catch((x) => x);
    expect(isBillingRefusalError(e)).toBe(false);
    expect(e).toBe(err);
  });

  it('source contract: pricingService and getCreditCost still throw the messages the classifier matches', () => {
    const ROOT = path.resolve(__dirname, '../../..');
    const ps = fs.readFileSync(path.join(ROOT, 'backend/services/pricingService.ts'), 'utf8');
    const cd = fs.readFileSync(path.join(ROOT, 'backend/services/creditDeductionService.ts'), 'utf8');
    for (const prefix of ['Model pricing lookup failed', 'Action pricing lookup failed', 'Missing action_pricing_config row', 'Missing valid credit_rate_usd', 'credit_rate_usd lookup failed', 'credit_cost_config lookup failed']) {
      expect(ps).toContain('[pricingService] ' + prefix);
      expect(isPriceResolutionError(new Error('[pricingService] ' + prefix + ' x'))).toBe(true);
    }
    for (const prefix of ['missing credit cost config', 'credit cost lookup failed']) {
      expect(cd).toContain('[creditDeduction] ' + prefix);
    }
    expect(ps).toMatch(/this\.name = 'PricingMissingError'/);
  });
});

describe('shared vocabulary (union-coverage pattern)', () => {
  it('BILLING_REFUSAL_HTTP_STATUS, BILLING_REFUSAL_COPY and BILLING_FALLBACK_NOTE all cover the union in both directions', () => {
    const codes = [...BILLING_REFUSAL_CODES].sort();
    expect(Object.keys(BILLING_REFUSAL_HTTP_STATUS).sort()).toEqual(codes);
    expect(Object.keys(BILLING_REFUSAL_COPY).sort()).toEqual(codes);
    expect(Object.keys(BILLING_FALLBACK_NOTE).sort()).toEqual(codes);
  });

  it('the orchestrator mapping lands only on members, and an unknown status is NOT a refusal', () => {
    for (const s of ['insufficient_credits', 'no_credit_account', 'not_a_member', 'org_control_blocked']) {
      expect(BILLING_REFUSAL_CODES).toContain(billingRefusalCodeForOrchestratorStatus(s));
    }
    expect(billingRefusalCodeForOrchestratorStatus('error')).toBeNull();
    expect(billingRefusalCodeForOrchestratorStatus('some_future_status')).toBeNull();
  });

  it('no client copy promises a top-up (no real top-up can complete in prod yet; cb PL-147)', () => {
    for (const s of [...Object.values(BILLING_REFUSAL_COPY), ...Object.values(BILLING_FALLBACK_NOTE)]) {
      expect(s).not.toMatch(/top.?up|buy|purchase/i);
    }
  });
});

describe('describeBillingRefusal / billingFallbackNote (client)', () => {
  it('a known code on 402/403/503 → its copy; never the server error text', () => {
    expect(describeBillingRefusal(402, { error: 'Insufficient credits to generate content', code: 'INSUFFICIENT_CREDITS' }))
      .toEqual({ code: 'INSUFFICIENT_CREDITS', message: BILLING_REFUSAL_COPY.INSUFFICIENT_CREDITS });
    expect(describeBillingRefusal(403, { code: 'ORG_CONTROL_BLOCKED' })?.message).toBe(BILLING_REFUSAL_COPY.ORG_CONTROL_BLOCKED);
    expect(describeBillingRefusal(503, { code: 'PRICING_UNAVAILABLE' })?.code).toBe('PRICING_UNAVAILABLE');
  });

  it('a 402 with an unknown or missing code is still billing → BILLING_REFUSED', () => {
    expect(describeBillingRefusal(402, { code: 'ADMISSION_BLOCKED' })?.code).toBe('BILLING_REFUSED');
    expect(describeBillingRefusal(402, {})?.code).toBe('BILLING_REFUSED');
  });

  it('a 403/503 WITHOUT a billing code is not billing (auth / outage keep their own handling); 500 is never billing', () => {
    expect(describeBillingRefusal(403, { error: 'Forbidden' })).toBeNull();
    expect(describeBillingRefusal(503, { code: 'ACTIVITY_LOOKUP_ERROR' })).toBeNull();
    expect(describeBillingRefusal(500, { code: 'INSUFFICIENT_CREDITS' })).toBeNull();
  });

  it('a fallback flagged by the server is labelled; an unflagged fallback is not', () => {
    expect(billingFallbackNote({ used_fallback: true, billing_refusal_code: 'INSUFFICIENT_CREDITS' })).toBe(BILLING_FALLBACK_NOTE.INSUFFICIENT_CREDITS);
    expect(billingFallbackNote({ used_fallback: true, billing_refusal_code: 'SOMETHING_NEW' })).toBe(BILLING_FALLBACK_NOTE.BILLING_REFUSED);
    expect(billingFallbackNote({ used_fallback: true })).toBeNull();
  });

  it('throwIfBillingRefusal + userErrorMessage: billing copy shows as-is; other errors keep the caller prefix', () => {
    let caught: unknown;
    try { throwIfBillingRefusal(402, { code: 'INSUFFICIENT_CREDITS' }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BillingRefusalNotice);
    expect(userErrorMessage(caught, 'Failed to refine content')).toBe(BILLING_REFUSAL_COPY.INSUFFICIENT_CREDITS);
    expect(() => throwIfBillingRefusal(500, { error: 'x' })).not.toThrow();
    expect(userErrorMessage(new Error('boom'), 'Failed to refine content')).toBe('Failed to refine content: boom');
  });
});
