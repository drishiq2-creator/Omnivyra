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

export interface RunBilledAiCompletionArgs {
  module:        string;
  userId:        string;
  orgId:         string;
  action:        CreditAction;
  referenceType: string;
  referenceId:   string;
  /** TOKEN mode: settle on actual tokens via the model rate card. Exactly one of llmPricing / fixedPricing. */
  llmPricing?: {
    provider:        string;
    model:           string;
    maxInputTokens:  number;
    maxOutputTokens: number;
    actionKey:       string;
    timestamp?:      string | Date;
  };
  /**
   * FIXED mode (c6 2026-11-20, owner's pricing hold: no new rate-priced billing): the charge is the action's own
   * credit_cost_config row (getCreditCost via runBilledOperation's fixed path), whatever the tokens. provider/model
   * only label the result.
   */
  fixedPricing?: { provider: string; model: string };
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
  text:            string;
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
  if ((args.llmPricing ? 1 : 0) + (args.fixedPricing ? 1 : 0) !== 1) {
    throw new Error('[runBilledAiCompletion] exactly one of llmPricing / fixedPricing is required');
  }
  const base = {
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
  };
  // The AI call, identical in both modes: guard check + the credit handle visible to the gateway (SEC91-D2).
  const callAi = async () => {
    const creditHandle: CreditHandle = {
      operationId:    'in-flight',
      idempotencyKey: 'in-flight',
      orgId:          args.orgId,
      action:         args.action,
      source:         'orchestrator',
    };
    await checkAiBillingGuard({ operation: args.completion.operation, creditHandle, orgId: args.orgId });
    return runWithCreditHandle(creditHandle, () => runCompletionWithOperation({ ...args.completion }));
  };

  if (args.fixedPricing) {
    let used = { inputTokens: 0, outputTokens: 0, provider: args.fixedPricing.provider, model: args.fixedPricing.model };
    const fixed: OrchestratorResult<string> = await runBilledOperation<string>({
      ...base,
      executor: async (): Promise<string> => {
        const gatewayResp = await callAi();
        const usage = gatewayResp.metadata?.token_usage ?? {};
        used = {
          inputTokens:  Number(usage.prompt_tokens ?? 0),
          outputTokens: Number(usage.completion_tokens ?? 0),
          provider:     gatewayResp.metadata.provider === 'direct-anthropic' ? 'anthropic' : 'openai',
          model:        gatewayResp.metadata.model ?? args.completion.model,
        };
        return typeof gatewayResp.output === 'string' ? gatewayResp.output : '';
      },
    });
    if (fixed.result.status !== 'executed') {
      throw new Error(`[runBilledAiCompletion] orchestrator did not execute: status=${fixed.result.status}`);
    }
    return {
      text:             fixed.result.result,
      operationId:      fixed.operationId,
      correlationId:    fixed.correlationId,
      idempotencyKey:   fixed.idempotencyKey,
      promptTokens:     used.inputTokens,
      completionTokens: used.outputTokens,
      provider:         used.provider,
      model:            used.model,
    };
  }

  const llm = args.llmPricing!;
  const orchestratorResult: OrchestratorResult<string> = await runBilledOperation<string>({
    ...base,
    llmPricing: {
      provider:        llm.provider,
      model:           llm.model,
      actionKey:       llm.actionKey,
      maxInputTokens:  llm.maxInputTokens,
      maxOutputTokens: llm.maxOutputTokens,
      timestamp:       llm.timestamp,
    },
    executor: async (): Promise<LlmExecutorResult<string>> => {
      const gatewayResp = await callAi();
      const text = typeof gatewayResp.output === 'string' ? gatewayResp.output : '';
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
    provider:         settlement?.provider ?? llm.provider,
    model:            settlement?.model    ?? llm.model,
  };
}
