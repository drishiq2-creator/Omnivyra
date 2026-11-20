/**
 * A8 step 2 (b3 2026-11-20): POST /api/command-center/creator-content/render-inline - the live AI image path -
 * moderates the payload BEFORE rendering and answers a budget refusal with its code instead of the renderer's
 * silent non-AI fallback. REAL: the route, inlineImageBudget, inlineImageModeration. FAKED: auth, company access,
 * fonts, Redis, and renderAsset (which stands in for the renderer: it takes one budget unit per "paid image").
 */
export {};
const mockRendered: { images: number; calls: number } = { images: 1, calls: 0 };
jest.mock('../../services/supabaseAuthService', () => ({ getSupabaseUserFromRequest: async () => ({ user: { id: 'u-1' }, error: null }) }));
jest.mock('../../services/userContextService', () => ({ enforceCompanyAccess: async () => ({ userId: 'u-1' }) }));
jest.mock('../../services/campaignAccessService', () => ({ requireCampaignAccess: async () => null }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) } }));
jest.mock('../../services/creatorRenderFonts', () => ({ ensureRenderFonts: () => ({ resolvedFontDir: null, fontCount: 0 }) }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/creatorAssetRenderer', () => ({
  renderAsset: async () => {
    mockRendered.calls += 1;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { admitInlineImage } = require('../../services/creator/inlineImageBudget');
    let made = 0;
    for (let i = 0; i < mockRendered.images; i++) if (await admitInlineImage()) made += 1;
    return { url: made > 0 ? 'https://cdn.test/ai.png' : 'https://cdn.test/fallback.png', files: [], metadata: { ai_images: made } };
  },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const handler = require('../../../pages/api/command-center/creator-content/render-inline').default;
const budget = require('../../services/creator/inlineImageBudget');

const store = new Map<string, number>();
const fakeRedis = {
  incr: async (k: string) => { const n = (store.get(k) ?? 0) + 1; store.set(k, n); return n; },
  decr: async (k: string) => { const n = (store.get(k) ?? 0) - 1; store.set(k, n); return n; },
  pexpire: async () => 1,
};
const CO = 'c0a00000-0000-4000-8000-0000000000aa';

async function post(assetPayload: Record<string, unknown>) {
  const res: any = { statusCode: 200, body: null, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  await handler({ method: 'POST', query: {}, headers: {}, body: { asset_payload: assetPayload, company_id: CO } }, res);
  return res;
}
const SAFE = { asset_kind: 'image', prompt: 'A bright product photo of a ceramic mug on a desk' };

beforeEach(() => {
  store.clear(); mockRendered.images = 1; mockRendered.calls = 0;
  delete process.env.CREATOR_INLINE_IMAGE_DAILY_CAP;
  budget.__setInlineImageRedisForTests(async () => fakeRedis);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { budget.__setInlineImageRedisForTests(null); jest.restoreAllMocks(); });

describe('render-inline guard', () => {
  it('CONTROL: a clean payload within budget renders (200) and takes its units', async () => {
    mockRendered.images = 3;
    const r = await post(SAFE);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ success: true, rendered: { url: 'https://cdn.test/ai.png' } });
    expect(store.get(budget.dailyKey(CO))).toBe(3);
  });

  it('a banned prompt -> 422 IMAGE_PROMPT_BLOCKED; NOTHING is rendered or counted', async () => {
    const r = await post({ asset_kind: 'image', slides: [{ prompt: 'nude portrait' }] });
    expect(r.statusCode).toBe(422);
    expect(r.body).toMatchObject({ code: 'IMAGE_PROMPT_BLOCKED' });
    expect(mockRendered.calls).toBe(0);
    expect(store.size).toBe(0);
  });

  it('a payload with NO text cannot be cleared -> 422 (fail closed)', async () => {
    const r = await post({ width: 1024, slides: [] });
    expect(r.statusCode).toBe(422);
    expect(mockRendered.calls).toBe(0);
  });

  it('daily cap reached -> 429 IMAGE_DAILY_LIMIT_REACHED, never a 200 with the non-AI fallback', async () => {
    process.env.CREATOR_INLINE_IMAGE_DAILY_CAP = '2';
    mockRendered.images = 3;
    const r = await post(SAFE);
    expect(r.statusCode).toBe(429);
    expect(r.body).toMatchObject({ success: false, code: 'IMAGE_DAILY_LIMIT_REACHED' });
  });

  it('counter unreadable -> 503 IMAGE_QUOTA_UNAVAILABLE with Retry-After', async () => {
    budget.__setInlineImageRedisForTests(async () => null);
    const r = await post(SAFE);
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatchObject({ code: 'IMAGE_QUOTA_UNAVAILABLE' });
    expect(r.headers['Retry-After']).toBe('30');
  });
});
