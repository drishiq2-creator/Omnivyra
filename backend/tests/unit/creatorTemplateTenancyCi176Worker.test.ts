/**
 * CI-176: the durable render worker loads a user template for the JOB'S company (options.companyId), the same
 * value renderAsset receives. Pins a real near-miss: the first draft read a variable declared later in the
 * function (a TDZ error), which the best-effort try/catch swallowed - the worker then never loaded the company's
 * own template and silently rendered the default style.
 * REAL: processCreatorRenderJob. FAKED: persistence, the renderer, the template loader (both recorded).
 */
export {};
const mockEnsure = jest.fn(async (..._a: unknown[]) => undefined);
const mockRender = jest.fn(async (..._a: unknown[]) => ({ url: 'https://img.example/x.png', metadata: {} }));
jest.mock('../../services/creatorRenderPersistence', () => ({ persistCreatorRenderJobState: async () => undefined }));
jest.mock('../../services/creatorAssetRenderer', () => ({
  renderAsset: (...a: unknown[]) => mockRender(...a),
  templateAssetSlotsForRenderPayload: () => [],
}));
jest.mock('../../services/creator/userTemplateService', () => ({
  ensureUserTemplateRegisteredForAsset: (...a: unknown[]) => mockEnsure(...a),
  setPreviewStatus: async () => undefined,
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { processCreatorRenderJob } = require('../../services/creatorRenderWorkerProcessor');
/* eslint-enable @typescript-eslint/no-var-requires */

function job(options: Record<string, unknown>) {
  const assetPayload = { media_bundle: { metadata: { template_id: 'ut-own' } } };
  return {
    id: 'job-1', attemptsMade: 0, opts: { attempts: 3 }, updateProgress: async () => undefined,
    data: { renderer: 'creator_asset', idempotencyKey: 'k', payload: { assetPayload, options } },
  };
}

it("loads the template for the job's company, and renderAsset gets the same company", async () => {
  await processCreatorRenderJob(job({ companyId: 'co-a-synthetic' })).catch(() => undefined);
  expect(mockEnsure).toHaveBeenCalledTimes(1);
  expect(mockEnsure.mock.calls[0][1]).toBe('co-a-synthetic');
  expect((mockRender.mock.calls[0][1] as { companyId?: unknown }).companyId).toBe('co-a-synthetic');
});

it('a job with no company passes null (the chokepoint then refuses every user template)', async () => {
  mockEnsure.mockClear();
  await processCreatorRenderJob(job({})).catch(() => undefined);
  expect(mockEnsure.mock.calls[0][1]).toBeNull();
});
