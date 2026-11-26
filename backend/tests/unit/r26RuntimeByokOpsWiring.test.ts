/**
 * Round 26 / T-1 — the gateway WIRES the credential policy into the retry layer:
 * a BYOK call is dispatched with `credential: 'company'` (no platform fallback), a
 * platform call with `credential: 'platform'` and the SAME plan/cost gate as the primary.
 * The mock/infra setup is copied from sec91DGatewaySpend.test.ts (REAL runCompletion,
 * REAL resolveLlmConfig; provider dispatch captured).
 *
 * FAILING CONTROL: at origin/main 2bc52db7a the 5th argument is absent, so
 * callProviderWithRetry is called with allowFallback=true and no credential policy.
 */

jest.mock('@/config', () => ({
  config: {
    OPENAI_API_KEY: 'sk-PLATFORM-OPENAI',
    ANTHROPIC_API_KEY: 'sk-ant-PLATFORM-ANTHROPIC',
    OPENAI_MODEL: 'gpt-4o-mini',
    NODE_ENV: 'test',
    DEV_USER_ID: '',
  },
}));

// ── OpenAI SDK (only reached by the direct callOpenAi test below) ───────────
const mockSdkCreate = jest.fn(async (..._a: unknown[]) => ({ choices: [{ message: { content: 'sdk' }, finish_reason: 'stop' }], usage: null }));
jest.mock('openai', () => {
  class FakeOpenAI {
    chat = { completions: { create: (...a: unknown[]) => mockSdkCreate(...a) } };
    constructor(_opts: unknown) { /* no network */ }
  }
  return { __esModule: true, default: FakeOpenAI, OpenAI: FakeOpenAI };
});

// ── provider dispatch: captured, never real ─────────────────────────────────
const mockCallProvider = jest.fn();
jest.mock('../../services/aiGatewayProvidersRetry', () => ({
  callProviderWithRetry: (...a: unknown[]) => mockCallProvider(...a),
  buildMetadata: (provider: string, model: string, usage: unknown) => ({
    provider: provider === 'anthropic' ? 'direct-anthropic' : 'direct-openai', model, token_usage: usage, reasoning_trace_id: 't',
  }),
}));

// ── company LLM config (DB) ─────────────────────────────────────────────────
type CfgRow = { provider_name: string; model_key: string; is_active: boolean };
const mockConfigs: Record<string, CfgRow> = {};
const mockKeys: Record<string, { key: string; source: 'company' | 'platform'; byokUnavailable?: boolean }> = {};
jest.mock('../../services/llmProviderService', () => ({
  getCompanyLlmConfig: async (companyId: string) => mockConfigs[companyId] ?? null,
  resolveCompanyApiKey: async (companyId: string) => mockKeys[companyId],
  getActiveProviders: async () => [],
  getModelsByProvider: async () => [],
}));

// ── plan-tier router + cost estimator (the gates D4 must not skip) ──────────
const mockPlanModel = jest.fn(async (requested: string, _op: string, _org: unknown) => requested);
jest.mock('../../services/aiModelRouter', () => ({ resolveEffectiveModel: (...a: [string, string, unknown]) => mockPlanModel(...a) }));
const mockCost = jest.fn(async (..._a: unknown[]) => ({ action: 'allow' as string, effectiveModel: undefined as string | undefined, reason: '' }));
jest.mock('../../services/jobCostEstimator', () => ({ evaluateJobCost: (...a: unknown[]) => mockCost(...a) }));

// ── cache: REAL key construction, in-memory storage ─────────────────────────
const mockCacheStore = new Map<string, string>();
jest.mock('../../services/aiResponseCache', () => {
  const actual = jest.requireActual('../../services/aiResponseCache');
  return {
    ...actual,
    getCachedCompletion: async (_op: string, model: string, messages: any, v?: string | null, _t?: string | null, scope?: string | null) =>
      mockCacheStore.get(actual.buildNormalizedKey(model, messages, v, scope)) ?? null,
    setCachedCompletion: async (_op: string, model: string, messages: any, response: string, v?: string | null, _t?: string | null, scope?: string | null) => {
      mockCacheStore.set(actual.buildNormalizedKey(model, messages, v, scope), response);
    },
  };
});

// ── inert infrastructure ────────────────────────────────────────────────────
jest.mock('../../services/ai/aiRequestGuard', () => ({
  guardAiRequest: jest.fn(async () => undefined),
  providerFromModel: () => 'openai',
  AiGuardError: class AiGuardError extends Error {},
}));
jest.mock('../../services/usageEnforcementService', () => ({ checkUsageBeforeExecution: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: jest.fn(async () => undefined), resolveLlmCost: jest.fn(async () => null) }));
jest.mock('../../services/usageMeterService', () => ({ incrementUsageMeter: jest.fn(async () => undefined) }));
jest.mock('../../services/pricingService', () => ({ assertModelPricingExists: jest.fn(async () => undefined), recordCostAnomaly: jest.fn(async () => undefined) }));
jest.mock('../../../lib/redis/usageProtection', () => ({ trackLlmTokens: jest.fn() }));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: () => ({ insert: jest.fn(async () => ({ error: null })) }) }));
const mockAllowlistRows: Array<{ action_key: string; expires_at: string | null }> = [];
jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: () => ({ select: async () => ({ data: mockAllowlistRows, error: null }) }) },
}));
const mockCounter = jest.fn();
jest.mock('../../observability', () => {
  const actual = jest.requireActual('../../observability');
  return { ...actual, recordRawCounter: (...a: unknown[]) => { mockCounter(...a); } };
});
const mockRunBilledOperation = jest.fn(async (args: any) => {
  const r = await args.executor();
  return {
    operationId: 'op-1', correlationId: 'c-1', idempotencyKey: 'k-1',
    // TOKEN mode's executor returns {result, usage}; FIXED mode's returns the value itself.
    result: { status: 'executed', result: args.llmPricing ? r.result : r, settlement: { actualUsage: { inputTokens: 1, outputTokens: 1 } } },
  };
});
jest.mock('../../services/billing/enterpriseBillingOrchestrator', () => ({ runBilledOperation: (a: unknown) => mockRunBilledOperation(a) }));

/* eslint-disable @typescript-eslint/no-var-requires */
const ops = require('../../services/aiGatewayProvidersOps');
const { invalidateAllowlistCache } = require('../../services/billing/aiGatewayBillingGuard');
const { runBilledAiCompletion } = require('../../services/billing/runBilledAiCompletion');
const { buildNormalizedKey } = jest.requireActual('../../services/aiResponseCache');
const { resolveOpenAiSdkMaxRetries } = require('../../services/aiGatewayCore');
/* eslint-enable @typescript-eslint/no-var-requires */

const CO_BYOK = '22222222-2222-2222-2222-222222222222';
const CO_PLATFORM = '33333333-3333-3333-3333-333333333333';
const req = (companyId: string | null) => ({
  companyId, model: 'gpt-4o-mini', temperature: 0.2, messages: [{ role: 'user' as const, content: `r26 ${companyId}` }], operation: 'generateContentForDay',
});

beforeEach(() => {
  for (const k of Object.keys(mockConfigs)) delete mockConfigs[k];
  for (const k of Object.keys(mockKeys)) delete mockKeys[k];
  mockCacheStore.clear();
  mockCallProvider.mockReset();
  mockCallProvider.mockImplementation(async () => ({ content: 'x', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, usedFallback: false, retry_attempt: 1 }));
  mockPlanModel.mockReset();
  mockPlanModel.mockImplementation(async (m: string) => m);
  mockCost.mockReset();
  mockCost.mockImplementation(async () => ({ action: 'allow', effectiveModel: undefined, reason: '' }));
  invalidateAllowlistCache();
  mockConfigs[CO_BYOK] = { provider_name: 'openai', model_key: 'gpt-4-turbo', is_active: true };
  mockKeys[CO_BYOK] = { key: 'sk-COMPANY-BYOK', source: 'company' };
  mockConfigs[CO_PLATFORM] = { provider_name: 'openai', model_key: 'gpt-4o-mini', is_active: true };
  mockKeys[CO_PLATFORM] = { key: 'sk-PLATFORM-OPENAI', source: 'platform' };
});

describe('runCompletion passes the credential policy to callProviderWithRetry', () => {
  it('BYOK → credential "company" (the retry layer then refuses any platform fallback)', async () => {
    await ops.runCompletion(req(CO_BYOK));
    expect(mockCallProvider).toHaveBeenCalledTimes(1); // scenario exists
    const args = mockCallProvider.mock.calls[0];
    expect(args[1].apiKey).toBe('sk-COMPANY-BYOK');
    expect(args[4]).toMatchObject({ credential: 'company' });
  });

  it('platform key → credential "platform" with the plan/cost gate attached', async () => {
    await ops.runCompletion(req(CO_PLATFORM));
    const policy = mockCallProvider.mock.calls[0][4];
    expect(policy).toMatchObject({ credential: 'platform' });
    expect(typeof policy.gateFallbackModel).toBe('function');
  });

  it('the attached fallback gate IS the plan/cost gate (blocked by the cost estimator → null; downgraded → downgrade)', async () => {
    await ops.runCompletion(req(CO_PLATFORM));
    const gate = mockCallProvider.mock.calls[0][4].gateFallbackModel as (m: string) => Promise<string | null>;
    mockCost.mockImplementation(async (model: unknown) => (model === 'claude-opus-premium'
      ? { action: 'block', effectiveModel: undefined, reason: 'over plan cost' }
      : { action: 'downgrade', effectiveModel: 'claude-haiku-cheap', reason: 'cheaper' }));
    await expect(gate('claude-opus-premium')).resolves.toBeNull();
    await expect(gate('claude-sonnet')).resolves.toBe('claude-haiku-cheap');
    mockPlanModel.mockImplementation(async () => 'gpt-4o-mini');
    mockCost.mockImplementation(async () => ({ action: 'allow', effectiveModel: undefined, reason: '' }));
    await expect(gate('claude-opus-premium')).resolves.toBe('gpt-4o-mini');
  });
});
