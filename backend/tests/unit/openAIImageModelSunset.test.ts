/**
 * gpt-image-1.5 leaves the OpenAI API on 2026-12-01 (OpenAI deprecations page:
 * gpt-image-1.5, gpt-image-1-mini and chatgpt-image-latest shut down 2026-12-01;
 * gpt-image-2 on 2027-02-10; replacement gpt-image-2.6-sunburst or -flare).
 * gpt-image-1 is already unavailable to the production account. A renderer that
 * still asks for any of them renders nothing once they are gone, so:
 *   - both creator renderers ask for a supported model by default;
 *   - OPENAI_IMAGE_MODEL still wins, so the model can change without a deploy;
 *   - a main-subject reference edit never sends input_fidelity to a model outside
 *     the gpt-image-1 family, and still raises quality above 'low'.
 */
export {};

const generateRequests: Array<Record<string, unknown>> = [];
const editRequests: Array<Record<string, unknown>> = [];

jest.mock('@/config', () => ({ config: { OPENAI_API_KEY: 'test-key' }, getValidatedConfig: () => ({}) }));
jest.mock('../../../config', () => ({ config: { OPENAI_API_KEY: 'test-key' } }));
jest.mock('openai', () => {
  class FakeOpenAI {
    images = {
      edit: async (request: Record<string, unknown>) => {
        editRequests.push(request);
        return { data: [{ b64_json: Buffer.from('EDITED').toString('base64') }], usage: { input_tokens: 900, output_tokens: 1100 } };
      },
      generate: async (request: Record<string, unknown>) => {
        generateRequests.push(request);
        return { data: [{ b64_json: Buffer.from('GENERATED').toString('base64') }], usage: { input_tokens: 40, output_tokens: 300 } };
      },
    };
  }
  return { __esModule: true, default: FakeOpenAI, toFile: async () => ({}) };
});
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: () => ({}) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => ({}), rpc: jest.fn(), storage: { from: () => ({}) } } }));
jest.mock('../../services/billing/blackHoleCostCapture', () => ({ captureImageProviderCost: jest.fn() }));
jest.mock('../../services/aiUsageCollector', () => ({ recordAssetCredits: jest.fn() }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { generateProviderImage } = require('../../services/creatorAssetRendererMedia');
const { openAIImageModelCandidates, imageUsageForLog, OPENAI_IMAGE_MODEL_DEFAULTS } = require('../../services/creator/openAIImageModel');
const { referenceEditParams } = require('../../services/creator/creatorMultimodalReferences');
const { createOpenAIRenderProvider } = require('../../services/creator/rendering/providers/openAIRenderProvider');
/* eslint-enable @typescript-eslint/no-var-requires */

/** Every model OpenAI has shut down or scheduled for shutdown, as of 2026-11-19. */
const RETIRING = ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-1.5-2025-12-16', 'gpt-image-1-mini', 'chatgpt-image-latest', 'gpt-image-2', 'gpt-image-2-2026-04-21', 'dall-e-2', 'dall-e-3'];

const ORIGINAL = { model: process.env.OPENAI_IMAGE_MODEL, mode: process.env.CREATOR_IMAGE_REFERENCE_MODE, key: process.env.OPENAI_API_KEY };
beforeEach(() => {
  generateRequests.length = 0;
  editRequests.length = 0;
  delete process.env.OPENAI_IMAGE_MODEL;
  delete process.env.BETA_AI_MODE;
  delete process.env.CREATOR_IMAGE_REFERENCE_MODE;
});
afterAll(() => {
  for (const [k, v] of [['OPENAI_IMAGE_MODEL', ORIGINAL.model], ['CREATOR_IMAGE_REFERENCE_MODE', ORIGINAL.mode], ['OPENAI_API_KEY', ORIGINAL.key]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('creator image model: off the models OpenAI is shutting down', () => {
  it('the default chain is the supported gpt-image-2.6 models, Sunburst first, then 2.5 Sunburst', () => {
    expect(openAIImageModelCandidates(undefined)).toEqual(['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.5-sunburst']);
    for (const m of OPENAI_IMAGE_MODEL_DEFAULTS) expect(RETIRING).not.toContain(m);
  });

  it('OPENAI_IMAGE_MODEL is tried first, trimmed, never duplicated; blank is ignored', () => {
    expect(openAIImageModelCandidates('  my-model  ')).toEqual(['my-model', 'gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.5-sunburst']);
    expect(openAIImageModelCandidates('gpt-image-2.6-flare')).toEqual(['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-2.5-sunburst']);
    expect(openAIImageModelCandidates('   ')).toEqual(['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.5-sunburst']);
  });

  it('the in-request renderer generates with gpt-image-2.6-sunburst by default', async () => {
    const result = await generateProviderImage({ prompt: 'a lighthouse at dawn' });
    expect(result.image?.buffer.toString()).toBe('GENERATED');
    expect(result.image?.model).toBe('gpt-image-2.6-sunburst');
    expect(generateRequests.map((r) => r.model)).toEqual(['gpt-image-2.6-sunburst']);
  });

  it('the in-request renderer honours OPENAI_IMAGE_MODEL', async () => {
    process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2.6-flare';
    await generateProviderImage({ prompt: 'a lighthouse at dawn' });
    expect(generateRequests[0].model).toBe('gpt-image-2.6-flare');
  });

  it('a main-subject reference edit sends no input_fidelity to 2.6, and quality stays above low', async () => {
    process.env.CREATOR_IMAGE_REFERENCE_MODE = 'edit';
    const result = await generateProviderImage({
      prompt: 'the product on a desk',
      referenceImages: [{ bytes: Buffer.from('png'), mimeType: 'image/png' }],
      referenceFidelity: 'high',
      referenceKind: 'user',
    });
    expect(result.image?.model).toBe('gpt-image-2.6-sunburst:edit');
    expect(editRequests).toHaveLength(1);
    expect(editRequests[0].model).toBe('gpt-image-2.6-sunburst');
    expect(editRequests[0]).not.toHaveProperty('input_fidelity');
    expect(editRequests[0].quality).toBe('medium');
  });

  it('referenceEditParams: input_fidelity only for the gpt-image-1 family', () => {
    expect(referenceEditParams({ fidelity: 'high', model: 'gpt-image-2.6-sunburst' })).toEqual({ quality: 'medium' });
    expect(referenceEditParams({ fidelity: 'high', model: 'gpt-image-2.6-flare', configuredQuality: 'high' })).toEqual({ quality: 'high' });
    // Control: the 1-family still gets it, so an override back to 1.5 keeps subject fidelity.
    expect(referenceEditParams({ fidelity: 'high', model: 'gpt-image-1.5' })).toEqual({ quality: 'medium', input_fidelity: 'high' });
  });

  it('the render-worker provider asks for the same default model, and honours the override', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ data: [{ url: 'https://img.example/x.png' }] }) };
    }) as unknown as typeof fetch;
    const spec = {
      render_modality: 'image',
      canonical_asset_family: 'image',
      platform_projection: { resolution: { w: 1024, h: 1024 } },
      blueprint_projection: { visual_prompt: 'a lighthouse', scene_direction: null, reference_image_url: null },
    };
    const run = async () => {
      const provider = createOpenAIRenderProvider({ apiKey: 'test-key', fetchImpl });
      await provider.submit(spec, 'idem-1');
    };
    await run();
    process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2.6-flare';
    await run();
    expect(bodies.map((b) => b.model)).toEqual(['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare']);
  });

  it('usage is logged as counts only (for the per-image price)', () => {
    expect(imageUsageForLog('m', { usage: { input_tokens: 5, output_tokens: 7 }, data: [{ b64_json: 'SECRET' }] }))
      .toEqual({ model: 'm', input_tokens: 5, output_tokens: 7 });
    expect(imageUsageForLog('m', { data: [] })).toEqual({ model: 'm', input_tokens: null, output_tokens: null });
  });
});
