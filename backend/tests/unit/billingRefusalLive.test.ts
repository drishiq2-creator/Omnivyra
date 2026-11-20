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
jest.mock('../../services/billing/enterpriseBillingOrchestrator', () => ({
  runBilledOperation: jest.fn(async () => ({
    operationId: 'op', correlationId: 'c', idempotencyKey: 'k',
    result: orchestratorStatus === 'executed'
      ? { status: 'executed', result: 'text', settlement: { actualUsage: { inputTokens: 1, outputTokens: 1 } } }
      : { status: orchestratorStatus },
  })),
}));
jest.mock('../../services/aiGateway', () => ({ runCompletionWithOperation: jest.fn() }));
jest.mock('../../services/billing/aiGatewayBillingGuard', () => ({
  checkAiBillingGuard: jest.fn(), runWithCreditHandle: (_h: unknown, fn: () => unknown) => fn(),
}));

import {
  runBilledAiCompletion, BillingRefusalError, isBillingRefusalError,
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
