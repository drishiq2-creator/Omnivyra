/**
 * runBilledAiCompletion — C-2 binding helper
 *
 * Convenience entry point for callers that today call
 * `aiGateway.runCompletionWithOperation()` directly. Wraps the call in the
 * billing orchestrator so the LLM cost is reserved, executed, and confirmed
 * atomically.
 *
 * Usage:
 *
 *   const out = await runBilledAiCompletion({
 *     module:        'http:refine_variant',
 *     userId:        user.id,
 *     orgId:         company.id,
 *     action:        'content_rewrite',
 *     referenceType: 'variant',
 *     referenceId:   variantId,
 *     llmPricing: {
 *       provider:        'openai',
 *       model:           'gpt-4o-mini',
 *       maxInputTokens:  4000,
 *       maxOutputTokens: 1000,
 *       actionKey:       'content_rewrite',
 *     },
 *     idempotency: {
 *       kind:       'http',
 *       actorUserId: user.id,
 *       action:     'content_rewrite',
 *       referenceId: variantId,
 *       requestBody: req.body,
 *     },
 *     completion: {
 *       model:       'gpt-4o-mini',
 *       temperature: 0.6,
 *       messages:    [{ role: 'user', content: prompt }],
 *       max_tokens:  1000,
 *       operation:   'refineVariant',
 *     },
 *   });
 *
 * On the happy path:
 *   1. HOLD = estimateLlmHoldCredits(provider, model, maxTokens)
 *   2. EXECUTE = aiGateway.runCompletionWithOperation(...)
 *   3. CONFIRM (partial) = apply_credit_partial_confirm using actual token counts
 *
 * On insufficient credits, the executor never runs.
 */

import { runCompletionWithOperation } from '../aiGateway';
import { runBilledOperation, type OrchestratorResult } from './enterpriseBillingOrchestrator';
import { idempotencyReference, type BillingIdempotencyArgs } from './billingIdempotencyService';
import type { CreditAction, LlmExecutorResult } from '../creditExecutionService';
import { checkAiBillingGuard, runWithCreditHandle, type CreditHandle } from './aiGatewayBillingGuard';
import {
  BILLING_REFUSAL_HTTP_STATUS, billingRefusalCodeForOrchestratorStatus, type BillingRefusalCode,
} from '../../../shared/billing/billingRefusalCodes';

/**
 * Billing REFUSED the call (04, 2026-11-20): the executor never ran and nothing was charged.
 * Before, this was a plain Error whose only signal was "status=insufficient_credits" inside its message, so each route
 * mangled it differently: chat-brief showed the internal message, field/campaign assist silently fell back, and
 * refine_variant answered a generic 500. Routes map this to `res.status(err.httpStatus).json({ error, code })`.
 */
export class BillingRefusalError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: BillingRefusalCode, readonly orchestratorStatus: string) {
    super(`billing refused: ${code}`);
    this.name = 'BillingRefusalError';
    this.httpStatus = BILLING_REFUSAL_HTTP_STATUS[code];
  }
}

/**
 * Did resolving the PRICE fail? Matches pricingService's typed PricingMissingError and the price-lookup errors thrown
 * by pricingService and creditDeductionService.getCreditCost (by their stable message prefixes). Validation errors
 * ("… is required", model limits) are NOT price errors. A source contract test pins these messages.
 */
const PRICE_RESOLUTION_MESSAGE = /^\[pricingService\] (Model pricing lookup failed|Action pricing lookup failed|Missing action_pricing_config row|Missing valid credit_rate_usd|credit_rate_usd lookup failed|credit_cost_config lookup failed)|^\[creditDeduction\] (missing credit cost config|credit cost lookup failed)/;
export function isPriceResolutionError(e: unknown): boolean {
  // By name, not instanceof: importing pricingService here would load its DB client into every caller of this module.
  if ((e as { name?: unknown } | null)?.name === 'PricingMissingError') return true;
  return e instanceof Error && PRICE_RESOLUTION_MESSAGE.test(e.message);
}

export function isBillingRefusalError(e: unknown): e is BillingRefusalError {
  return e instanceof BillingRefusalError || (e as { name?: unknown } | null)?.name === 'BillingRefusalError';
}

export interface RunBilledAiCompletionArgs {
  module:        string;
  userId:        string;
  orgId:         string;
  action:        CreditAction;
  referenceType: string;
  referenceId:   string;
  llmPricing: {
    provider:        string;
    model:           string;
    maxInputTokens:  number;
    maxOutputTokens: number;
    actionKey:       string;
    timestamp?:      string | Date;
  };
  idempotency:   BillingIdempotencyArgs;
  note?:         string;
  metadata?:     Record<string, unknown>;
  completion: {
    model:        string;
    temperature:  number;
    messages:     Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    max_tokens?:  number;
    operation:    string;
    response_format?: { type: 'json_object' };
    companyId?:   string | null;
    campaignId?:  string | null;
    prompt_template_name?:    string | null;
    prompt_template_version?: string | null;
    prompt_template_hash?:    string | null;
    cache_version?: string | null;
  };
  validateMembership?: boolean;
}

export interface BilledAiCompletionResult {
  /**
   * true = the provider call RAN and produced `text`, but pricing the actual usage failed at settlement, so the
   * charge is unsettled (logged for reconciliation). The work is delivered; it must never be answered with a retry
   * (7c, 2026-11-20).
   */
  settlementUnpriced?: true;
  text:            string;
  /** null ONLY when settlementUnpriced: no settled operation exists. A '' would be type-identical to a real id (7c NB-B). */
  operationId:     string | null;
  correlationId:   string | null;
  idempotencyKey:  string | null;
  /** null ONLY when settlementUnpriced: usage was consumed but never settled; 0 would under-report silently. */
  promptTokens:    number | null;
  completionTokens: number | null;
  provider:        string;
  model:           string;
}

export async function runBilledAiCompletion(
  args: RunBilledAiCompletionArgs,
): Promise<BilledAiCompletionResult> {
  // 7c on 306b8498c: a PRICE that cannot be resolved (missing row, or the lookup itself failed) is
  // PRICING_UNAVAILABLE, the union's one retryable "unknown" (503 + Retry-After). It used to leave as a generic 500.
  // It is raised while the hold is being computed, before any reservation or provider call, so nothing was charged.
  let orchestratorResult: OrchestratorResult<string>;
  // TIME AXIS (7c BLOCKING on 8ff86fd72): a price failure BEFORE the provider call means nothing happened (retry is
  // right); AFTER it, the AI work exists and was paid for, so the answer must never invite a repeat.
  let providerCallStarted = false;
  let producedText: string | null = null;
  try {
    orchestratorResult = await runBilledOperation<string>({
      module:         args.module,
      action:         args.action,
      userId:         args.userId,
      orgId:          args.orgId,
      referenceType:  args.referenceType,
      referenceId:    args.referenceId,
      idempotency:    args.idempotency,
      note:           args.note,
      metadata:       args.metadata,
      validateMembership: args.validateMembership,
      llmPricing: {
        provider:        args.llmPricing.provider,
        model:           args.llmPricing.model,
        actionKey:       args.llmPricing.actionKey,
        maxInputTokens:  args.llmPricing.maxInputTokens,
        maxOutputTokens: args.llmPricing.maxOutputTokens,
        timestamp:       args.llmPricing.timestamp,
      },
      executor: async (): Promise<LlmExecutorResult<string>> => {
        // We have a handle by virtue of being inside the orchestrator. Notify the
        // guard so violations cannot accidentally proliferate at this seam.
        const creditHandle: CreditHandle = {
          operationId:    'in-flight',
          idempotencyKey: 'in-flight',
          orgId:          args.orgId,
          action:         args.action,
          source:         'orchestrator',
        };
        await checkAiBillingGuard({
          operation: args.completion.operation,
          creditHandle,
          orgId: args.orgId,
        });
  
        // SEC91-D2: the gateway re-checks the billing guard; the handle must be
        // visible there too, or this billed call is recorded as an untracked
        // violation (and blocked outright once BILLING_REQUIRE_AI_HANDLE=true).
        providerCallStarted = true;
        const gatewayResp = await runWithCreditHandle(creditHandle, () => runCompletionWithOperation({
          ...args.completion,
        }));
  
        const text = typeof gatewayResp.output === 'string' ? gatewayResp.output : '';
        producedText = text;
        const usage = gatewayResp.metadata?.token_usage ?? {};
  
        return {
          result: text,
          usage: {
            inputTokens:  Number(usage.prompt_tokens ?? 0),
            outputTokens: Number(usage.completion_tokens ?? 0),
            source:       (Number(usage.total_tokens ?? 0) > 0 ? 'provider' : 'cache'),
          },
          provider: gatewayResp.metadata.provider === 'direct-anthropic' ? 'anthropic' : 'openai',
          model:    gatewayResp.metadata.model ?? args.completion.model,
        };
      },
    });
  } catch (err) {
    if (isPriceResolutionError(err)) {
      // BEFORE the provider call (the hold could not be priced): nothing ran, nothing was charged, retry is right.
      if (!providerCallStarted) throw new BillingRefusalError('PRICING_UNAVAILABLE', 'pricing_unavailable');
      // AFTER it (settlement could not price the actual usage): deliver the work that was done, flag it, and log it
      // for reconciliation. NOT a refusal and no Retry-After: answering "try again" would spend on the provider twice.
      if (producedText !== null) {
        // Join keys (7c NB-A): referenceId + the idempotency referenceId tie this line to the request and its ledger
        // attempt; without them it is an alarm, not a record. (A durable DB row is a registered follow-up; Redis
        // settlement observations expire, so they are deliberately NOT used here.)
        console.error('[runBilledAiCompletion] billed_ai_settlement_unpriced', JSON.stringify({
          module: args.module, orgId: args.orgId, userId: args.userId, action: args.action,
          referenceType: args.referenceType, referenceId: args.referenceId,
          // BillingIdempotencyArgs is a union (CI-798 typecheck): every kind has its own reference (7c's total helper),
          // so a queue- or cron-driven call still logs its ledger join key, never null.
          idempotencyKind: args.idempotency.kind,
          idempotencyReference: idempotencyReference(args.idempotency),
          provider: args.llmPricing.provider, model: args.llmPricing.model,
          error: err instanceof Error ? err.message : String(err),
        }));
        return {
          settlementUnpriced: true,
          text:             producedText,
          operationId:      null,
          correlationId:    null,
          idempotencyKey:   null,
          promptTokens:     null,
          completionTokens: null,
          provider:         args.llmPricing.provider,
          model:            args.llmPricing.model,
        };
      }
      // The provider call started but produced nothing: not a pricing problem we can answer for, so propagate it
      // (never PRICING_UNAVAILABLE, never a retry instruction).
    }
    throw err;
  }

  if (orchestratorResult.result.status !== 'executed') {
    const refusal = billingRefusalCodeForOrchestratorStatus(String(orchestratorResult.result.status));
    if (refusal) throw new BillingRefusalError(refusal, String(orchestratorResult.result.status));
    // Not a billing refusal (already settled / internal error): unchanged.
    throw new Error(
      `[runBilledAiCompletion] orchestrator did not execute: status=${orchestratorResult.result.status}`,
    );
  }

  const settlement = orchestratorResult.result.settlement as {
    creditsCharged?: number;
    actualUsage?: { inputTokens?: number; outputTokens?: number };
    provider?: string;
    model?: string;
  } | undefined;
  const actualUsage = settlement?.actualUsage ?? { inputTokens: 0, outputTokens: 0 };

  return {
    text:             orchestratorResult.result.result,
    operationId:      orchestratorResult.operationId,
    correlationId:    orchestratorResult.correlationId,
    idempotencyKey:   orchestratorResult.idempotencyKey,
    promptTokens:     Number(actualUsage.inputTokens ?? 0),
    completionTokens: Number(actualUsage.outputTokens ?? 0),
    provider:         settlement?.provider ?? args.llmPricing.provider,
    model:            settlement?.model    ?? args.llmPricing.model,
  };
}
