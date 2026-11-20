/**
 * A8 step 2: the budget is enforced at the PAID call. Inside a render-inline scope, generateProviderImage takes a
 * unit BEFORE constructing the OpenAI client; refused -> NO provider call, a named fallback reason, and the scope
 * carries the refusal for the route. Outside a scope (worker / render-image) the call is made and nothing counted.
 * REAL: generateProviderImage, inlineImageBudget. FAKED: openai (records calls), config key, cost capture, Redis.
 */
export {};
const generateCalls: Array<Record<string, unknown>> = [];
jest.mock('@/config', () => ({ config: { OPENAI_API_KEY: 'test-key' }, getValidatedConfig: () => ({}) }));
jest.mock('../../../config', () => ({ config: { OPENAI_API_KEY: 'test-key' } }));
jest.mock('openai', () => {
  class FakeOpenAI {
    images = {
      edit: async () => ({ data: [{ b64_json: Buffer.from('EDITED').toString('base64') }] }),
      generate: async (request: Record<string, unknown>) => {
        generateCalls.push(request);
        return { data: [{ b64_json: Buffer.from('GENERATED').toString('base64') }] };
      },
    };
  }
  return { __esModule: true, default: FakeOpenAI, toFile: async () => ({}) };
});
jest.mock('../../services/billing/blackHoleCostCapture', () => ({ captureImageProviderCost: jest.fn() }));
jest.mock('../../services/aiUsageCollector', () => ({ recordAssetCredits: jest.fn() }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { generateProviderImage } = require('../../services/creatorAssetRendererMedia');
const budget = require('../../services/creator/inlineImageBudget');

const store = new Map<string, number>();
const fakeRedis = {
  incr: async (k: string) => { const n = (store.get(k) ?? 0) + 1; store.set(k, n); return n; },
  decr: async (k: string) => { const n = (store.get(k) ?? 0) - 1; store.set(k, n); return n; },
  pexpire: async () => 1,
};
const CO = 'c0a00000-0000-4000-8000-0000000000aa';

beforeEach(() => {
  generateCalls.length = 0; store.clear();
  delete process.env.CREATOR_INLINE_IMAGE_DAILY_CAP;
  budget.__setInlineImageRedisForTests(async () => fakeRedis);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => { budget.__setInlineImageRedisForTests(null); jest.restoreAllMocks(); });

describe('the inline image budget gates the PAID provider call', () => {
  it('within budget: the image is generated and one unit is taken', async () => {
    const { result, scope } = await budget.runWithInlineImageBudget(CO, () => generateProviderImage({ prompt: 'a calm product photo' }));
    expect(generateCalls).toHaveLength(1);
    expect(result.image).toBeTruthy();
    expect(scope).toMatchObject({ refusal: null, used: 1 });
    expect(store.get(budget.dailyKey(CO))).toBe(1);
  });

  it('REFUSED (cap 0): NO provider call; named fallback reason; the scope carries the refusal for the route', async () => {
    process.env.CREATOR_INLINE_IMAGE_DAILY_CAP = '0';
    const { result, scope } = await budget.runWithInlineImageBudget(CO, () => generateProviderImage({ prompt: 'a calm product photo' }));
    expect(generateCalls).toHaveLength(0);
    expect(result).toMatchObject({ image: null, fallbackReason: 'inline_image_budget_refused' });
    expect(scope.refusal).toBe('IMAGE_DAILY_LIMIT_REACHED');
  });

  it('REFUSED (counter unreadable): NO provider call - fail closed', async () => {
    budget.__setInlineImageRedisForTests(async () => null);
    const { scope } = await budget.runWithInlineImageBudget(CO, () => generateProviderImage({ prompt: 'a calm product photo' }));
    expect(generateCalls).toHaveLength(0);
    expect(scope.refusal).toBe('IMAGE_QUOTA_UNAVAILABLE');
  });

  it('CONTROL: outside a render-inline scope the call is made and NOTHING is counted (worker paths untouched)', async () => {
    process.env.CREATOR_INLINE_IMAGE_DAILY_CAP = '0';
    await generateProviderImage({ prompt: 'a calm product photo' });
    expect(generateCalls).toHaveLength(1);
    expect(store.size).toBe(0);
  });
});
