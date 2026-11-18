/**
 * S2-55 (7c review, 2026-11-19): POSITIVE CONTROL for "no caller can omit the tenant".
 *
 * The scoped store entry points type their tenant / companyId as REQUIRED, but the type is erased at runtime: an
 * untyped caller (or a cast) can still pass nothing. Each of the five must then refuse with TenantSeamError
 * TENANT_CONTEXT_MISSING BEFORE any database access - never degrade to the campaign_id-only (unscoped) path.
 *
 * Every DB seam these stores can reach is faked to THROW (fails unabsorbably) and to RECORD the call, so a case only
 * passes if the refusal happened first. The "with a tenant" cases prove the fakes are the live seam (they are reached
 * when a tenant IS given), so the "not called" assertions are not vacuous.
 */
export {};

const dbCalls: string[] = [];
const reached = (what: string) => {
  dbCalls.push(what);
  throw new Error(`DB_REACHED:${what}`);
};

jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: (t: string) => reached(`supabase.from(${t})`), rpc: (f: string) => reached(`supabase.rpc(${f})`) },
}));
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (t: string) => reached(`ownedDbTable(${t})`),
  ownedDbRpc: (f: string) => reached(`ownedDbRpc(${f})`),
}));
jest.mock('../../services/campaignOwnershipService', () => ({
  resolveCampaignOwnership: (id: string) => reached(`resolveCampaignOwnership(${id})`),
}));

import {
  getLatestDraftPlan,
  saveDraftBlueprint,
  saveCampaignBlueprintFromRecommendation,
} from '../../db/campaignPlanStore';
import { listContentAssets, listAssetsWithLatestContent } from '../../db/contentAssetStore';
import { TenantSeamError, systemTenantContext, type TenantContext } from '../../db/tenantTable';

const CAMPAIGN = 'c5c5c5c5-0000-4000-8000-000000000001';
const COMPANY = 'a1a1a1a1-0000-4000-8000-000000000001';
const blueprint = { campaign_id: CAMPAIGN, duration_weeks: 1, weeks: [{ week_number: 1, platform_allocation: { linkedin: 1 } }] } as any;
const none = undefined as unknown as TenantContext;
const noCompany = undefined as unknown as string;

async function expectMissing(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(TenantSeamError);
  expect((err as TenantSeamError).code).toBe('TENANT_CONTEXT_MISSING');
  expect(dbCalls).toEqual([]);
}

beforeEach(() => {
  dbCalls.length = 0;
});

describe('scoped store entry points refuse a missing tenant before any DB access', () => {
  it('getLatestDraftPlan(campaignId, undefined)', async () => {
    await expectMissing(getLatestDraftPlan(CAMPAIGN, none));
  });

  it('saveDraftBlueprint without tenant', async () => {
    await expectMissing(saveDraftBlueprint({ campaignId: CAMPAIGN, blueprint, tenant: none }));
    await expectMissing(saveDraftBlueprint({ campaignId: CAMPAIGN, blueprint } as unknown as Parameters<typeof saveDraftBlueprint>[0]));
  });

  it('saveCampaignBlueprintFromRecommendation without tenant', async () => {
    await expectMissing(saveCampaignBlueprintFromRecommendation({ campaignId: CAMPAIGN, companyId: COMPANY, blueprint, tenant: none }));
    await expectMissing(
      saveCampaignBlueprintFromRecommendation({ campaignId: CAMPAIGN, companyId: COMPANY, blueprint } as unknown as Parameters<
        typeof saveCampaignBlueprintFromRecommendation
      >[0]),
    );
  });

  it('listContentAssets without companyId (undefined and empty)', async () => {
    await expectMissing(listContentAssets({ campaignId: CAMPAIGN, companyId: noCompany }));
    await expectMissing(listContentAssets({ campaignId: CAMPAIGN } as unknown as Parameters<typeof listContentAssets>[0]));
    await expectMissing(listContentAssets({ campaignId: CAMPAIGN, companyId: '' }));
  });

  it('listAssetsWithLatestContent without companyId (undefined and empty)', async () => {
    await expectMissing(listAssetsWithLatestContent({ campaignId: CAMPAIGN, companyId: noCompany }));
    await expectMissing(listAssetsWithLatestContent({ campaignId: CAMPAIGN } as unknown as Parameters<typeof listAssetsWithLatestContent>[0]));
    await expectMissing(listAssetsWithLatestContent({ campaignId: CAMPAIGN, companyId: '  ' }));
  });
});

describe('control: with a tenant the same calls DO reach the faked DB seam (the not-called assertions are live)', () => {
  const tenant = systemTenantContext(COMPANY, 'unit test: scoped store positive control');

  it.each([
    ['getLatestDraftPlan', () => getLatestDraftPlan(CAMPAIGN, tenant)],
    ['saveDraftBlueprint', () => saveDraftBlueprint({ campaignId: CAMPAIGN, blueprint, tenant })],
    ['saveCampaignBlueprintFromRecommendation', () => saveCampaignBlueprintFromRecommendation({ campaignId: CAMPAIGN, companyId: COMPANY, blueprint, tenant })],
    ['listContentAssets', () => listContentAssets({ campaignId: CAMPAIGN, companyId: COMPANY })],
    ['listAssetsWithLatestContent', () => listAssetsWithLatestContent({ campaignId: CAMPAIGN, companyId: COMPANY })],
  ])('%s reaches the DB fake', async (_name, call) => {
    const err = await (call as () => Promise<unknown>)().then(() => null, (e: unknown) => e);
    // The fake throws, so the call fails - but only AFTER the seam reached the DB (possibly re-wrapped by the seam).
    expect(err).not.toBeNull();
    expect(dbCalls.length).toBeGreaterThan(0);
  });
});
