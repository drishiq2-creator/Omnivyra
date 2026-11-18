/**
 * S2-55 (2026-11-14) - campaign-keyed WRITES scoped to the AUTHORIZED company.
 *
 * enforceCompanyAccess({campaignId}) allows a campaign id that matches NOTHING (no campaigns row and no
 * campaign_versions row: checkCampaignOwnership 'not_found'), and a deleted campaign's child rows survive (no FK to
 * campaigns). A route that reads or writes by campaign_id alone after that gate therefore reaches another company's
 * ORPHANED rows. These suites seed such orphans for company B under ORPHAN_ID (no campaigns / versions row), call as
 * a member of company A, and require that nothing of B's is read, returned or modified. Each has a positive control
 * on A's own campaign.
 *
 *   pages/api/campaigns/planner/apply-opportunity.ts -> campaignPlanStore getLatestDraftPlan / saveDraftBlueprint
 *   pages/api/campaigns/recommendations.ts           -> getCampaignPlanningInputs + saveCampaignBlueprintFromRecommendation
 *
 * The scoping must hold WITHOUT the gate refusing not_found (a separate change), so the gate runs for real here.
 */
import {
  seed, invoke, rows, completedWrites, resolveUpsertConflicts, leaksB,
  CAMPAIGN_A, CO_A, CO_B, CANARY_B,
} from '../helpers/routeAuthHarness';

jest.mock('@/config', () => ({ config: { DEV_USER_ID: '', NODE_ENV: 'production' } }));
jest.mock('../../db/supabaseClient', () => jest.requireActual('../helpers/routeAuthHarness').supabaseModule());
jest.mock('../../db/writeOwner', () => jest.requireActual('../helpers/routeAuthHarness').writeOwnerModule());
jest.mock('../../services/supabaseAuthService', () => jest.requireActual('../helpers/routeAuthHarness').authModule());
jest.mock('../../security/IdentityResolver', () => jest.requireActual('../helpers/routeAuthHarness').identityModule());

// apply-opportunity: a deterministic suggestion (week 1, a fixed topic).
jest.mock('../../services/plannerOpportunityAdvisor', () => ({
  generateCampaignSuggestions: () => [{ topic: 'Opportunity topic', week_hint: 1, action: 'Add week 1 content' }],
}));

// recommendations: the LLM strategy, the blueprint adapter and the version store are not under test.
jest.mock('../../services/campaignRecommendationService', () => ({
  generateCampaignStrategy: jest.fn(async () => ({
    status: 'ready', campaign: { name: 'x' }, weekly_plan: [{ week: 1 }], daily_plan: [], trend_alerts: null,
  })),
}));
jest.mock('../../services/campaignBlueprintAdapter', () => ({
  fromRecommendationPlan: (_weeks: unknown[], campaignId: string) => ({
    campaign_id: campaignId, duration_weeks: 1, weeks: [{ week_number: 1, platform_allocation: { linkedin: 2 } }],
  }),
  blueprintWeekToLegacyWeekPlan: (w: unknown) => w,
  fromStructuredPlan: (x: any) => ({ campaign_id: x.campaign_id, weeks: x.weeks }),
}));
const mockSaveVersion = jest.fn(async () => undefined);
jest.mock('../../db/campaignVersionStore', () => ({
  saveCampaignVersion: (...a: unknown[]) => (mockSaveVersion as any)(...a),
  saveWeekVersions: jest.fn(async () => undefined),
  saveTrendSnapshot: jest.fn(async () => undefined),
}));
// The capacity gateway ECHOES the planning inputs it was given into an invalid result, which the route returns in
// its 400 body - so whichever company's campaign_planning_inputs the route read is visible in the response.
jest.mock('../../services/capacityFrequencyValidationGateway', () => ({
  validateCapacityAndFrequency: (input: { weekly_capacity?: unknown }) =>
    input.weekly_capacity == null
      ? { status: 'valid' }
      : { status: 'invalid', override_confirmed: false, echoed_weekly_capacity: input.weekly_capacity },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const applyOpportunity = require('../../../pages/api/campaigns/planner/apply-opportunity').default;
const recommendations = require('../../../pages/api/campaigns/recommendations').default;
/* eslint-enable @typescript-eslint/no-var-requires */

/** A campaign id with NO campaigns row and NO campaign_versions row: the gate answers not_found and allows it. */
const ORPHAN_ID = 'orph-b-00-0000-0000-00000000000b';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../helpers/routeAuthHarness').assertNoHarnessConfigurationError();
});

// ──────────────────────────── apply-opportunity: draft read + overwrite ──
describe('POST campaigns/planner/apply-opportunity - campaign_week_plan scoped to the authorized company', () => {
  const B_DRAFT = {
    id: 9001, campaign_id: ORPHAN_ID, status: 'draft', updated_at: '2026-03-01',
    weeks: [{ week_number: 1, topics_to_cover: [`B secret ${CANARY_B}`] }],
  };
  const A_DRAFT = {
    id: 9002, campaign_id: CAMPAIGN_A, status: 'draft', updated_at: '2026-03-01',
    weeks: [{ week_number: 1, topics_to_cover: ['A existing'] }],
  };
  const OPP_A = {
    id: 'opp-a', organization_id: CO_A, opportunity_type: 'trend', title: 'Opp A', description: 'd', signal_count: 1,
    confidence_score: 0.5, topic_keywords: ['kw'], related_campaign_id: null, status: 'new',
  };
  const seedWorld = () => seed({ campaign_week_plan: [B_DRAFT, A_DRAFT], opportunity_radar: [OPP_A] });

  it('(a) nonexistent campaign id with company B orphan draft: 404, B draft unchanged, nothing written', async () => {
    seedWorld();
    const before = clone(rows('campaign_week_plan').find((r) => r.id === 9001));
    const r = await invoke(applyOpportunity, {
      method: 'POST', as: 'A', body: { companyId: CO_A, campaignId: ORPHAN_ID, opportunityId: 'opp-a' },
    });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
    expect(leaksB(r.body)).toBe(false);
    // B's row is byte-for-byte what was seeded, and no write of any kind reached the plan table.
    expect(rows('campaign_week_plan').find((r2) => r2.id === 9001)).toEqual(before);
    expect(rows('campaign_week_plan')).toHaveLength(2);
    expect(completedWrites(['campaign_week_plan'])).toEqual([]);
    // Refused before ANY write: the opportunity is not marked applied to the foreign/missing campaign either.
    expect(completedWrites(['opportunity_radar'])).toEqual([]);
    expect(rows('opportunity_radar').find((o) => o.id === 'opp-a')?.status).toBe('new');
  });

  it('(b) positive control: own campaign -> 200, own draft updated, B draft untouched', async () => {
    seedWorld();
    const beforeB = clone(rows('campaign_week_plan').find((r) => r.id === 9001));
    const r = await invoke(applyOpportunity, {
      method: 'POST', as: 'A', body: { companyId: CO_A, campaignId: CAMPAIGN_A, opportunityId: 'opp-a' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, planUpdated: true, campaignId: CAMPAIGN_A });
    const ownDraft = rows('campaign_week_plan').find((x) => x.id === 9002)!;
    expect(ownDraft.weeks[0].topics_to_cover).toEqual(['A existing', 'Opportunity topic']);
    expect(rows('campaign_week_plan').find((x) => x.id === 9001)).toEqual(beforeB);
    // Every plan write was pinned to A's campaign.
    const writes = completedWrites(['campaign_week_plan']);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w.filters.campaign_id).toBe(CAMPAIGN_A);
  });
});

// ──────────────────────────── recommendations: planning-inputs read + plan insert ──
describe('POST campaigns/recommendations - planning inputs and plan writes scoped to the authorized company', () => {
  const B_INPUTS = {
    id: 'cpi-b', campaign_id: ORPHAN_ID, company_id: CO_B, updated_at: '2026-03-01',
    recommendation_snapshot: {}, weekly_capacity: { secret: CANARY_B },
  };
  const A_INPUTS = {
    id: 'cpi-a', campaign_id: CAMPAIGN_A, company_id: CO_A, updated_at: '2026-03-01',
    recommendation_snapshot: {}, weekly_capacity: { own: 'A-capacity' },
  };
  const B_PROJECTION = { campaign_id: ORPHAN_ID, week_number: 1, total_posts: 77, platform_allocation: { b: CANARY_B } };

  beforeEach(() => {
    resolveUpsertConflicts('campaign_resource_projection', ['campaign_id', 'week_number']);
    mockSaveVersion.mockClear();
  });

  it('(a) nonexistent campaign id with company B orphan inputs/projection: B inputs never echoed, nothing written under it', async () => {
    seed({ campaign_planning_inputs: [B_INPUTS, A_INPUTS], campaign_resource_projection: [B_PROJECTION] });
    const beforeProjection = clone(rows('campaign_resource_projection'));
    const r = await invoke(recommendations, { method: 'POST', as: 'A', body: { companyId: CO_A, campaignId: ORPHAN_ID } });
    // B's capacity would come back in a 400 validation body if the read were keyed on campaign_id alone.
    expect(leaksB(r.body)).toBe(false);
    expect(JSON.stringify(r.body ?? '')).not.toContain('secret');
    // The plan insert is refused by the seam (the campaign is not A's own): the route's campaign 404.
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
    expect(completedWrites(['campaign_week_plan', 'campaign_resource_projection'])).toEqual([]);
    expect(rows('campaign_week_plan').filter((x) => x.campaign_id === ORPHAN_ID)).toEqual([]);
    expect(rows('campaign_resource_projection')).toEqual(beforeProjection);
    // Every planning-inputs read carried A's company predicate.
    const { calls } = require('../helpers/routeAuthHarness');
    const inputReads = calls().filter((c: any) => c.table === 'campaign_planning_inputs');
    expect(inputReads.length).toBeGreaterThan(0);
    for (const c of inputReads) expect(c.filters.company_id).toBe(CO_A);
  });

  it('(b1) positive control: own campaign\'s planning inputs are still read (echoed in the 400)', async () => {
    seed({ campaign_planning_inputs: [B_INPUTS, A_INPUTS] });
    const r = await invoke(recommendations, { method: 'POST', as: 'A', body: { companyId: CO_A, campaignId: CAMPAIGN_A } });
    expect(r.status).toBe(400);
    expect(r.body.validation_result).toMatchObject({ echoed_weekly_capacity: { own: 'A-capacity' } });
    expect(leaksB(r.body)).toBe(false);
  });

  it('(b2) positive control: own campaign with no capacity block -> 200, plan + projection written under A\'s campaign', async () => {
    seed({ campaign_planning_inputs: [B_INPUTS], campaign_resource_projection: [B_PROJECTION] });
    const r = await invoke(recommendations, { method: 'POST', as: 'A', body: { companyId: CO_A, campaignId: CAMPAIGN_A } });
    expect(r.status).toBe(200);
    expect(rows('campaign_week_plan').filter((x) => x.campaign_id === CAMPAIGN_A)).toHaveLength(1);
    expect(rows('campaign_resource_projection').filter((x) => x.campaign_id === CAMPAIGN_A)).toHaveLength(1);
    expect(rows('campaign_resource_projection').find((x) => x.campaign_id === ORPHAN_ID)).toEqual(B_PROJECTION);
    expect(mockSaveVersion).toHaveBeenCalledWith(expect.objectContaining({ companyId: CO_A, campaignId: CAMPAIGN_A }));
  });
});
