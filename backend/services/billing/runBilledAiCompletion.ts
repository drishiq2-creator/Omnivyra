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
import type { BillingIdempotencyArgs } from './billingIdempotencyService';
import type { CreditAction, LlmExecutorResult } from '../creditExecutionService';
import { checkAiBillingGuard, runWithCreditHandle, type CreditHandle } from './aiGatewayBillingGuard';
import { buildBillingIdempotencyKey } from './billingIdempotencyService';
import {
  BilledResultUnpersistedError, BilledRouteKeyRequiredError, BilledRouteRequestEndedError,
  clientIdempotencyKey, persistBilledResultOrThrow, replayOrRefund,
} from './billedRequestRecovery';

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
  /**
   * b3 rulings 2026-11-18 (BLOCKING-launch) - opt in to billed-request recovery (billedRequestRecovery). Requires an
   * 'http' idempotency with the client's Idempotency-Key (refused without one - never synthesised). The completion is
   * post-processed and PERSISTED (durableWrite, then billedResultStore, read back) INSIDE the charge: a result that
   * cannot be persisted is released and returned free; a same-key retry replays the stored value; a durably
   * unreadable replay refunds the original charge (system-paid).
   */
  recovery?: {
    surface: string;
    scope: string;
    postProcess?: (text: string) => Promise<unknown> | unknown;
    durableWrite?: (value: unknown) => Promise<void>;
  };
}

export interface BilledAiCompletionResult {
  text:            string;
  /** With `recovery`: the post-processed (and persisted) value - or the replayed one. */
  value?:          unknown;
  /** With `recovery`: true when this response replays an earlier, already-charged result (nothing new charged). */
  replayed?:       boolean;
  /** With `recovery`: true when the result could not be persisted, so the charge was released (returned free). */
  unbilled?:       boolean;
  operationId:     string;
  correlationId:   string;
  idempotencyKey:  string;
  promptTokens:    number;
  completionTokens: number;
  provider:        string;
  model:           string;
}

export async function runBilledAiCompletion(
  args: RunBilledAiCompletionArgs,
): Promise<BilledAiCompletionResult> {
  // ── Recovery (opt-in): required client key, replay before any charge ──
  let recoveredValue: unknown;
  if (args.recovery) {
    const idem = args.idempotency;
    if (idem.kind !== 'http' || !clientIdempotencyKey(idem.requestHeaderIdempotency)) {
      throw new BilledRouteKeyRequiredError(args.recovery.surface);
    }
    const root = buildBillingIdempotencyKey(idem);
    const replay = await replayOrRefund({
      surface: args.recovery.surface, scope: args.recovery.scope, orgId: args.orgId, key: root.root, performedBy: args.userId,
      confirmKeys: [root.confirm], referenceId: args.referenceId,
    });
    if (replay) {
      return { text: typeof replay.value === 'string' ? replay.value : '', value: replay.value, replayed: true,
        operationId: '', correlationId: '', idempotencyKey: root.root, promptTokens: 0, completionTokens: 0, provider: '', model: '' };
    }
  }

  let orchestratorResult: OrchestratorResult<string>;
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
      const gatewayResp = await runWithCreditHandle(creditHandle, () => runCompletionWithOperation({
        ...args.completion,
      }));

      const text = typeof gatewayResp.output === 'string' ? gatewayResp.output : '';
      const usage = gatewayResp.metadata?.token_usage ?? {};
      if (args.recovery) {
        // PERSIST INSIDE the charge (b3/7c): throws BilledResultUnpersistedError -> the engine releases.
        const recovery = args.recovery;
        const value = recovery.postProcess ? await recovery.postProcess(text) : text;
        await persistBilledResultOrThrow({
          scope: recovery.scope, orgId: args.orgId, key: buildBillingIdempotencyKey(args.idempotency).root, value,
          durableWrite: recovery.durableWrite ? () => recovery.durableWrite!(value) : undefined,
        });
        recoveredValue = value;
      }

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
    // Delivered in this response but not durably stored: released, NOT charged (the work is still returned).
    if (err instanceof BilledResultUnpersistedError) {
      return { text: typeof err.result === 'string' ? err.result : '', value: err.result, unbilled: true,
        operationId: '', correlationId: '', idempotencyKey: '', promptTokens: 0, completionTokens: 0, provider: '', model: '' };
    }
    throw err;
  }

  if (args.recovery && orchestratorResult.result.status === 'already_released') {
    throw new BilledRouteRequestEndedError(args.recovery.surface);
  }
  if (orchestratorResult.result.status !== 'executed') {
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
    ...(args.recovery ? { value: recoveredValue } : {}),
  };
}
