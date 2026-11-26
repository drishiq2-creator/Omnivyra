/**
 * Round 26 / T-1 (+ plan/cost gate on fallback) — credential policy rule P3:
 * a tenant BYOK LLM call NEVER falls back to the platform key on 429/529/network/auth
 * errors; it fails with a classified, value-free CredentialFailureError instead.
 * A PLATFORM-key call may still fall back, but only through the plan/cost gate.
 *
 * Drives the REAL callProviderWithRetry (aiGatewayProvidersRetry). Only the provider
 * dispatch (callOpenAi / callAnthropic), concurrency gates, DB and metrics are faked.
 *
 * FAILING CONTROL (recorded in the round-26 report): at origin/main 2bc52db7a the BYOK
 * cases make a SECOND dispatch to anthropic with apiKey === the platform ANTHROPIC key,
 * and resolve instead of rejecting.
 *
 * All keys are fake fixtures.
 */

const PLATFORM_OPENAI = 'sk-FAKE-PLATFORM-OPENAI-r26';
const PLATFORM_ANTHROPIC = 'sk-ant-FAKE-PLATFORM-ANTHROPIC-r26';
const TENANT_KEY = 'sk-FAKE-TENANT-A-BYOK-r26-0123456789';

jest.mock('@/config', () => ({
  config: {
    OPENAI_API_KEY: 'sk-FAKE-PLATFORM-OPENAI-r26',
    ANTHROPIC_API_KEY: 'sk-ant-FAKE-PLATFORM-ANTHROPIC-r26',
    OPENAI_MODEL: 'gpt-4o-mini',
    NODE_ENV: 'test',
  },
}));

const mockDispatch = jest.fn();
jest.mock('../../services/aiGatewayCore', () => {
  class GatewayAbortError extends Error { constructor(op: string) { super(`aborted ${op}`); this.name = 'GatewayAbortError'; } }
  return {
    UNKNOWN_ORG: '00000000-0000-0000-0000-000000000000',
    FEATURE_AREA_MAP: {},
    GatewayAbortError,
    isAbortError: (e: unknown) => e instanceof GatewayAbortError || (e as { name?: string })?.name === 'AbortError',
    _inFlight: new Map(),
    sleep: async () => undefined,
    resolveProviderTimeoutMs: () => 1000,
    _pools: { default: { activeCalls: 0, maxAllowed: 10 } },
    acquireSlot: async () => ({ waitMs: 0, pool: 'default', slotNumber: 1 }),
    releaseSlot: () => undefined,
    resolveLlmConfig: async () => ({}),
    callOpenAi: (ps: unknown) => mockDispatch('openai', ps),
    callAnthropic: (ps: unknown) => mockDispatch('anthropic', ps),
  };
});
jest.mock('../../services/distributedSemaphore', () => ({
  acquire: async () => null, release: async () => undefined, reloadPoolSizes: () => undefined,
}));
jest.mock('../../services/providerTokenBucket', () => ({
  acquire: async () => null, markRequestStarted: () => undefined, refund: () => undefined,
}));
jest.mock('../../services/distributedProviderTokenBucket', () => ({
  acquireDistributed: async () => ({ fellThrough: true }),
  markDistributedRequestStarted: () => undefined, refundDistributed: async () => undefined,
}));
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: async () => undefined, resolveLlmCost: () => null }));
jest.mock('../../services/aiUsageCollector', () => ({ recordProviderUsage: () => undefined }));
jest.mock('../../observability', () => ({ recordRawCounter: () => undefined, recordRawHistogram: () => undefined }));
const mockActiveProviders = jest.fn(async () => [{ name: 'openai' }, { name: 'anthropic' }]);
const mockModelsByProvider = jest.fn(async (p: string) => (p === 'anthropic' ? [{ model_key: 'claude-opus-premium' }, { model_key: 'claude-haiku-cheap' }] : [{ model_key: 'gpt-4o-mini' }]));
jest.mock('../../services/llmProviderService', () => ({
  getCompanyLlmConfig: async () => null,
  resolveCompanyApiKey: async () => ({ key: '', source: 'platform' }),
  getActiveProviders: () => mockActiveProviders(),
  getModelsByProvider: (p: string) => mockModelsByProvider(p),
}));
jest.mock('../../services/usageMeterService', () => ({ incrementUsageMeter: async () => undefined }));
jest.mock('../../services/usageEnforcementService', () => ({ checkUsageBeforeExecution: async () => ({ allowed: true }) }));
jest.mock('../../services/aiResponseCache', () => ({ getCachedCompletion: async () => null, setCachedCompletion: async () => undefined, buildNormalizedKey: () => 'k' }));
jest.mock('../../services/aiModelRouter', () => ({ resolveEffectiveModel: async (m: string) => m }));
jest.mock('../../services/metricsCollector', () => ({ recordGptCall: () => undefined, recordGptLatency: () => undefined, recordGptFailure: () => undefined }));
jest.mock('../../services/jobCostEstimator', () => ({ evaluateJobCost: async () => ({ action: 'allow' }) }));
jest.mock('../../../lib/redis/usageProtection', () => ({ trackLlmTokens: async () => undefined }));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: () => ({}) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));
jest.mock('../../services/providerAccountService', () => ({ getActiveAccountForApi: async () => null, resolveAccountCredentials: () => null }));

import { callProviderWithRetry, classifyTenantKeyFailure } from '../../services/aiGatewayProvidersRetry';
import { CredentialFailureError } from '../../services/providerCredentialResolver';

const ok = { content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
const httpErr = (status: number, message = `provider said ${status}`) => Object.assign(new Error(message), { status });
const params = (apiKey: string) => ({ apiKey, model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], operation: 'test' } as any);
const allowGate = async (m: string) => m;

let warnSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
let infoSpy: jest.SpyInstance;
beforeEach(() => {
  mockDispatch.mockReset();
  mockActiveProviders.mockClear();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => { warnSpy.mockRestore(); errSpy.mockRestore(); infoSpy.mockRestore(); });

const platformKeyDispatches = () => mockDispatch.mock.calls.filter(([, ps]) => ps.apiKey === PLATFORM_OPENAI || ps.apiKey === PLATFORM_ANTHROPIC);
const allLogged = () => JSON.stringify([...warnSpy.mock.calls, ...errSpy.mock.calls, ...infoSpy.mock.calls]);

describe('T-1: a tenant BYOK call never falls back to the platform key', () => {
  it.each([
    [429, 'tenant_key_rate_limited'],
    [529, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ])('status %s → classified %s, every dispatch on the tenant key, no other provider', async (status, code) => {
    mockDispatch.mockRejectedValue(httpErr(status));
    const p = callProviderWithRetry('openai', params(TENANT_KEY), true, undefined, { credential: 'company', gateFallbackModel: allowGate });
    await expect(p).rejects.toBeInstanceOf(CredentialFailureError);
    await expect(p).rejects.toMatchObject({ code, credentialOwner: 'company', status });
    // Pair: the BYOK call DID reach the provider (scenario exists) ...
    expect(mockDispatch).toHaveBeenCalled();
    // ... and every dispatch was the tenant's own key on the tenant's provider.
    for (const [prov, ps] of mockDispatch.mock.calls) {
      expect(prov).toBe('openai');
      expect(ps.apiKey).toBe(TENANT_KEY);
    }
    expect(platformKeyDispatches()).toEqual([]);
  });

  it('network error → provider_unavailable, no platform fallback', async () => {
    mockDispatch.mockRejectedValue(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }));
    await expect(
      callProviderWithRetry('openai', params(TENANT_KEY), true, undefined, { credential: 'company', gateFallbackModel: allowGate }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(platformKeyDispatches()).toEqual([]);
  });

  it('401 invalid tenant key → tenant_key_invalid; message never quotes the provider error (which can carry a key fragment)', async () => {
    mockDispatch.mockRejectedValue(httpErr(401, `Incorrect API key provided: ${TENANT_KEY.slice(0, 8)}****${TENANT_KEY.slice(-4)}`));
    const err = await callProviderWithRetry('openai', params(TENANT_KEY), true, undefined, { credential: 'company', gateFallbackModel: allowGate })
      .catch((e: unknown) => e as CredentialFailureError);
    expect(err).toBeInstanceOf(CredentialFailureError);
    expect((err as CredentialFailureError).code).toBe('tenant_key_invalid');
    expect((err as Error).message).not.toContain(TENANT_KEY.slice(0, 8));
    expect((err as Error).message).not.toContain(TENANT_KEY.slice(-4));
    expect((err as Error).message).toMatch(/platform key was not used/i);
    expect(mockDispatch).toHaveBeenCalledTimes(1); // auth is never retried
    expect(allLogged()).not.toContain(TENANT_KEY);
    expect(allLogged()).not.toContain(TENANT_KEY.slice(0, 8));
  });

  it('a same-provider retry that SUCCEEDS on the tenant key is still a success (no over-blocking)', async () => {
    mockDispatch.mockRejectedValueOnce(httpErr(429)).mockResolvedValueOnce(ok);
    const r = await callProviderWithRetry('openai', params(TENANT_KEY), true, undefined, { credential: 'company', gateFallbackModel: allowGate });
    expect(r.usedFallback).toBe(false);
    expect(mockDispatch.mock.calls.map(([, ps]) => ps.apiKey)).toEqual([TENANT_KEY, TENANT_KEY]);
  });

  it('a non-credential error (400 validation) is rethrown unchanged, still with no fallback', async () => {
    const e400 = httpErr(400);
    mockDispatch.mockRejectedValue(e400);
    await expect(
      callProviderWithRetry('openai', params(TENANT_KEY), true, undefined, { credential: 'company', gateFallbackModel: allowGate }),
    ).rejects.toBe(e400);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

describe('platform-key fallback stays available, but only through the plan/cost gate', () => {
  it('POSITIVE CONTROL: a platform-key 429 still falls back to the other provider on the platform key', async () => {
    mockDispatch.mockImplementation(async (prov: string) => { if (prov === 'openai') throw httpErr(429); return ok; });
    const r = await callProviderWithRetry('openai', params(PLATFORM_OPENAI), true, undefined, { credential: 'platform', gateFallbackModel: allowGate });
    expect(r.usedFallback).toBe(true);
    expect(r.fallbackProvider).toBe('anthropic');
    const last = mockDispatch.mock.calls[mockDispatch.mock.calls.length - 1];
    expect(last[0]).toBe('anthropic');
    expect(last[1].apiKey).toBe(PLATFORM_ANTHROPIC);
  });

  it('the gate decides the fallback model: a downgrade to a served model is used', async () => {
    mockDispatch.mockImplementation(async (prov: string) => { if (prov === 'openai') throw httpErr(429); return ok; });
    const r = await callProviderWithRetry('openai', params(PLATFORM_OPENAI), true, undefined, {
      credential: 'platform', gateFallbackModel: async () => 'claude-haiku-cheap',
    });
    expect(r.fallbackModel).toBe('claude-haiku-cheap');
  });

  it('the gate blocking the fallback model → no fallback (primary error thrown)', async () => {
    const e = httpErr(429);
    mockDispatch.mockRejectedValue(e);
    await expect(
      callProviderWithRetry('openai', params(PLATFORM_OPENAI), true, undefined, { credential: 'platform', gateFallbackModel: async () => null }),
    ).rejects.toBe(e);
    expect(mockDispatch.mock.calls.every(([prov]) => prov === 'openai')).toBe(true);
  });

  it('no gate supplied → no fallback (fail closed: an ungated fallback would bypass plan/cost)', async () => {
    mockDispatch.mockRejectedValue(httpErr(429));
    await expect(callProviderWithRetry('openai', params(PLATFORM_OPENAI), true)).rejects.toMatchObject({ status: 429 });
    expect(mockDispatch.mock.calls.every(([prov]) => prov === 'openai')).toBe(true);
  });
});

describe('classifyTenantKeyFailure (pure)', () => {
  it('distinguishes invalid / rate-limited / outage without reading any value', () => {
    expect(classifyTenantKeyFailure(httpErr(401))).toBe('tenant_key_invalid');
    expect(classifyTenantKeyFailure(httpErr(403))).toBe('tenant_key_invalid');
    expect(classifyTenantKeyFailure(httpErr(429))).toBe('tenant_key_rate_limited');
    expect(classifyTenantKeyFailure(httpErr(529))).toBe('provider_unavailable');
    expect(classifyTenantKeyFailure(httpErr(500))).toBe('provider_unavailable');
    expect(classifyTenantKeyFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('provider_unavailable');
    expect(classifyTenantKeyFailure(httpErr(400))).toBeNull();
  });
});
