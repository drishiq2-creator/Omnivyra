/**
 * S2-55 (2026-11-14) - campaign-keyed READS scoped to the AUTHORIZED company.
 *
 * enforceCompanyAccess({campaignId}) allows a campaign id that matches NOTHING (no campaigns row and no
 * campaign_versions row: checkCampaignOwnership 'not_found'), and a deleted campaign's child rows survive (no FK to
 * campaigns). A read keyed on campaign_id alone after that gate therefore returns another company's ORPHANED rows.
 * Each suite seeds such orphans for company B under ORPHAN_ID (no campaigns / versions row), calls as a member of
 * company A, and requires that no B data comes back; each has a positive control on A's own campaign.
 *
 *   pages/api/engagement/campaign-signals.ts        campaign_activity_engagement_signals
 *   pages/api/recommendations/analytics.ts          performance_feedback (recommendationAnalyticsService)
 *   backend/db/contentAssetStore.ts                 content_assets (+ content/list, campaigns/memory)
 *   pages/api/activity-workspace/resolve.ts         daily_content_plans, scheduled_posts, the canonical adapter
 *   pages/api/growth-intelligence/{publishing-success,engagement,content-velocity}.ts
 *
 * The scoping must hold WITHOUT the gate refusing not_found (a separate change), so the gate runs for real here.
 */
import {
  seed, invoke, calls, leaksB,
  CAMPAIGN_A, CO_A, CANARY_B, CO_B,
} from '../helpers/routeAuthHarness';

jest.mock('@/config', () => ({ config: { DEV_USER_ID: '', NODE_ENV: 'production' } }));
jest.mock('../../db/supabaseClient', () => jest.requireActual('../helpers/routeAuthHarness').supabaseModule());
jest.mock('../../db/writeOwner', () => jest.requireActual('../helpers/routeAuthHarness').writeOwnerModule());
jest.mock('../../services/supabaseAuthService', () => jest.requireActual('../helpers/routeAuthHarness').authModule());
jest.mock('../../security/IdentityResolver', () => jest.requireActual('../helpers/routeAuthHarness').identityModule());
jest.mock('../../utils/refineUserFacingResponse', () => ({ refineUserFacingResponse: async (x: unknown) => x }));

// resolve.ts: the canonical adapter is replaced by a fake that reads daily_content_plans BY CAMPAIGN ALONE, exactly
// as the real adapter does (loadSources -> getDailyPlans(campaignId)). The route must prove the campaign is the
// company's own before it is ever called.
const adapterCalls: string[] = [];
jest.mock('../../services/orchestration', () => {
  const h = jest.requireActual('../helpers/routeAuthHarness');
  const byCampaign = async (campaignId: string) => {
    const { data } = await h.fakeSupabase.from('daily_content_plans').select('*').eq('campaign_id', campaignId);
    return (data ?? []) as Array<Record<string, any>>;
  };
  const toItem = (row: Record<string, any>) => ({
    execution_id: row.execution_id, title: row.title, platform: 'linkedin', content_type: 'post',
    week_id: 'wk1', day_id: 'Monday', metadata: { __legacy_raw: { title: row.title, topic: row.title } },
  });
  return {
    canonicalExecutionAdapter: {
      getExecutionItem: async (campaignId: string, executionId: string) => {
        adapterCalls.push(campaignId);
        const row = (await byCampaign(campaignId)).find((r) => r.execution_id === executionId);
        return row ? toItem(row) : null;
      },
      getExecutionItems: async (campaignId: string) => {
        adapterCalls.push(campaignId);
        return (await byCampaign(campaignId)).map(toItem);
      },
    },
    resolveAuthoritativeWorkspace: async (campaignId: string) => {
      adapterCalls.push(campaignId);
      return { projection: null };
    },
  };
});
jest.mock('@/lib/planning/unifiedExecutionAdapter', () => ({ blueprintItemToUnifiedExecutionUnit: () => ({}) }));
jest.mock('@/lib/planning/repurposingContext', () => ({ buildRepurposingContext: () => null }));
jest.mock('@/lib/planning/masterContentDocument', () => ({ buildMasterContentDocument: () => null }));
jest.mock('@/backend/services/creator/intelligence/workspace', () => ({ loadCreatorWorkspace: () => ({ ok: false }) }));

/* eslint-disable @typescript-eslint/no-var-requires */
const campaignSignals = require('../../../pages/api/engagement/campaign-signals').default;
const analytics = require('../../../pages/api/recommendations/analytics').default;
const contentList = require('../../../pages/api/content/list').default;
const memory = require('../../../pages/api/campaigns/memory').default;
const resolveWorkspace = require('../../../pages/api/activity-workspace/resolve').default;
const publishingSuccess = require('../../../pages/api/growth-intelligence/publishing-success').default;
const growthEngagement = require('../../../pages/api/growth-intelligence/engagement').default;
const contentVelocity = require('../../../pages/api/growth-intelligence/content-velocity').default;
const { listAssetsWithLatestContent } = require('../../db/contentAssetStore');
/* eslint-enable @typescript-eslint/no-var-requires */

/** A campaign id with NO campaigns row and NO campaign_versions row: the gate answers not_found and allows it. */
const ORPHAN_ID = 'orph-b-00-0000-0000-00000000000b';

/** Every recorded statement against `tables` whose filters mention `value` (eq or in). */
const statementsNaming = (tables: string[], value: string) =>
  calls().filter((c) => tables.includes(c.table) && JSON.stringify(c.filters ?? {}).includes(value));

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../helpers/routeAuthHarness').assertNoHarnessConfigurationError();
});

// ──────────────────────────── engagement/campaign-signals ──
describe('GET engagement/campaign-signals - signals scoped to the authorized company', () => {
  const SIGNALS = [
    { id: 'sig-b', campaign_id: ORPHAN_ID, activity_id: 'act-b', organization_id: CO_B, platform: 'linkedin', content: CANARY_B, signal_type: 'comment', engagement_score: 9, detected_at: '2026-03-01' },
    { id: 'sig-a', campaign_id: CAMPAIGN_A, activity_id: 'act-a', organization_id: CO_A, platform: 'linkedin', content: 'A signal', signal_type: 'comment', engagement_score: 5, detected_at: '2026-03-01' },
  ];

  it('(a) nonexistent campaign id with company B orphan signals -> 200 with no signals, no B data', async () => {
    seed({ campaign_activity_engagement_signals: SIGNALS });
    const r = await invoke(campaignSignals, { method: 'GET', as: 'A', query: { companyId: CO_A, campaignId: ORPHAN_ID } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ signals: [] });
    expect(leaksB(r.body)).toBe(false);
  });

  it('(a2) activityId only (B\'s activity) -> no B data', async () => {
    seed({ campaign_activity_engagement_signals: SIGNALS });
    const r = await invoke(campaignSignals, { method: 'GET', as: 'A', query: { companyId: CO_A, activityId: 'act-b' } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ signals: [] });
    expect(leaksB(r.body)).toBe(false);
  });

  it('(b) positive control: own campaign -> its signals', async () => {
    seed({ campaign_activity_engagement_signals: SIGNALS });
    const r = await invoke(campaignSignals, { method: 'GET', as: 'A', query: { companyId: CO_A, campaignId: CAMPAIGN_A } });
    expect(r.status).toBe(200);
    expect(r.body.signals.map((s: { id: string }) => s.id)).toEqual(['sig-a']);
  });
});

// ──────────────────────────── recommendations/analytics ──
describe('GET recommendations/analytics - performance_feedback scoped to the authorized company', () => {
  const FEEDBACK = [
    { id: 'pf-b', campaign_id: ORPHAN_ID, engagement_rate: 0.77, collected_at: '2026-03-01', note: CANARY_B },
    { id: 'pf-a', campaign_id: CAMPAIGN_A, engagement_rate: 0.42, collected_at: '2026-03-01' },
  ];

  it('(a) nonexistent campaign id with company B orphan feedback -> B feedback not counted', async () => {
    seed({ performance_feedback: FEEDBACK });
    const r = await invoke(analytics, { method: 'GET', as: 'A', query: { companyId: CO_A, campaignId: ORPHAN_ID } });
    expect(r.status).toBe(200);
    expect(r.body.totals.avg_accuracy).toBe(0);
    expect(leaksB(r.body)).toBe(false);
  });

  it('(b) positive control: own campaign -> its feedback counted', async () => {
    seed({ performance_feedback: FEEDBACK });
    const r = await invoke(analytics, { method: 'GET', as: 'A', query: { companyId: CO_A, campaignId: CAMPAIGN_A } });
    expect(r.status).toBe(200);
    expect(r.body.totals.avg_accuracy).toBe(0.42);
  });
});

// ──────────────────────────── content_assets (store + content/list + campaigns/memory) ──
describe('content_assets listings scoped to the authorized company', () => {
  const ASSETS = {
    content_assets: [
      { asset_id: 'as-b', campaign_id: ORPHAN_ID, week_number: 1, day: 'Monday', platform: 'linkedin', status: 'approved', created_at: '2026-03-01' },
      { asset_id: 'as-a', campaign_id: CAMPAIGN_A, week_number: 1, day: 'Monday', platform: 'linkedin', status: 'approved', created_at: '2026-03-01' },
    ],
    content_asset_versions: [
      { asset_id: 'as-b', version: 1, content_json: { caption: CANARY_B, hook: CANARY_B } },
      { asset_id: 'as-a', version: 1, content_json: { caption: 'A caption', hook: 'A hook' } },
    ],
  };
  const assetReadsOf = (campaignId: string) => statementsNaming(['content_assets'], campaignId);

  it('(a) store: a campaign that is not the company\'s own lists nothing and content_assets is never read for it', async () => {
    seed(ASSETS);
    expect(await listAssetsWithLatestContent({ campaignId: ORPHAN_ID, companyId: CO_A })).toEqual([]);
    expect(assetReadsOf(ORPHAN_ID)).toEqual([]);
  });

  it('(a) content/list: nonexistent campaign id with company B orphan assets -> no B assets', async () => {
    seed(ASSETS);
    const r = await invoke(contentList, { method: 'GET', as: 'A', query: { companyId: CO_A, campaignId: ORPHAN_ID } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ assets: [] });
    expect(leaksB(r.body)).toBe(false);
  });

  it('(a) campaigns/memory: nonexistent campaign id with company B orphan assets -> no B content', async () => {
    seed(ASSETS);
    const r = await invoke(memory, { method: 'POST', as: 'A', body: { companyId: CO_A, campaignId: ORPHAN_ID } });
    expect(r.status).toBe(200);
    expect(r.body.pastContentSummaries).toEqual([]);
    expect(r.body.pastHooks).toEqual([]);
    expect(leaksB(r.body)).toBe(false);
  });

  it('(b) positive control: own campaign -> its assets (store, content/list, campaigns/memory)', async () => {
    seed(ASSETS);
    const listed = await listAssetsWithLatestContent({ campaignId: CAMPAIGN_A, companyId: CO_A });
    expect(listed.map((a: { asset_id: string }) => a.asset_id)).toEqual(['as-a']);
    const r = await invoke(contentList, { method: 'GET', as: 'A', query: { companyId: CO_A, campaignId: CAMPAIGN_A } });
    expect(r.status).toBe(200);
    expect(r.body.assets.map((a: { asset_id: string }) => a.asset_id)).toEqual(['as-a']);
    expect(r.body.assets[0].latest_content).toEqual({ caption: 'A caption', hook: 'A hook' });
    const m = await invoke(memory, { method: 'POST', as: 'A', body: { companyId: CO_A, campaignId: CAMPAIGN_A } });
    expect(m.status).toBe(200);
    expect(m.body.pastContentSummaries).toEqual(['A caption']);
  });
});

// ──────────────────────────── activity-workspace/resolve ──
describe('GET activity-workspace/resolve - campaign-keyed reads scoped to the authorized company', () => {
  const WORLD = {
    daily_content_plans: [
      { id: 'dcp-b', campaign_id: ORPHAN_ID, execution_id: 'exec-1', title: `B ${CANARY_B}`, creator_asset: { secret: CANARY_B }, content_status: 'b-status' },
      { id: 'dcp-a', campaign_id: CAMPAIGN_A, execution_id: 'exec-1', title: 'A title', content_status: 'a-status' },
    ],
    scheduled_posts: [
      { id: 'sp-b', campaign_id: ORPHAN_ID, execution_id: 'exec-1', status: 'scheduled', content: CANARY_B, scheduled_for: '2026-04-01' },
      { id: 'sp-a', campaign_id: CAMPAIGN_A, execution_id: 'exec-1', status: 'scheduled', content: 'A post', scheduled_for: '2026-04-02' },
    ],
  };
  beforeEach(() => { adapterCalls.length = 0; });

  it('(a) nonexistent campaign id with company B orphan rows -> 404, no B data, the adapter never runs for it', async () => {
    seed(WORLD);
    const r = await invoke(resolveWorkspace, { method: 'GET', as: 'A', query: { companyId: CO_A, campaignId: ORPHAN_ID, executionId: 'exec-1' } });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Activity not found', campaignId: ORPHAN_ID, executionId: 'exec-1' });
    expect(leaksB(r.body)).toBe(false);
    expect(adapterCalls).toEqual([]);
    expect(statementsNaming(['daily_content_plans', 'scheduled_posts'], ORPHAN_ID)).toEqual([]);
  });

  it('(b) positive control: own campaign -> 200 with its own row and schedule', async () => {
    seed(WORLD);
    const r = await invoke(resolveWorkspace, { method: 'GET', as: 'A', query: { companyId: CO_A, campaignId: CAMPAIGN_A, executionId: 'exec-1' } });
    expect(r.status).toBe(200);
    expect(r.body.payload.title).toBe('A title');
    expect(r.body.payload.dailyExecutionItem.content_status).toBe('a-status');
    expect(r.body.payload.schedules.map((s: { content: string | null }) => s.content)).toEqual(['A post']);
    expect(leaksB(r.body)).toBe(false);
  });
});

// ──────────────────────────── growth-intelligence ──
describe.each([
  ['publishing-success', publishingSuccess],
  ['engagement', growthEngagement],
  ['content-velocity', contentVelocity],
])('GET growth-intelligence/%s - a supplied campaignId is intersected with the company\'s own', (name, handler) => {
  const WORLD = {
    scheduled_posts: [
      { id: 'sp-b1', campaign_id: ORPHAN_ID, status: 'published' },
      { id: 'sp-b2', campaign_id: ORPHAN_ID, status: 'published' },
      { id: 'sp-a1', campaign_id: CAMPAIGN_A, status: 'failed' },
    ],
    daily_content_plans: [{ id: 'dcp-b', campaign_id: ORPHAN_ID }],
  };
  const metricTables = ['scheduled_posts', 'daily_content_plans', 'content_analytics'];

  it('(a) nonexistent campaign id with company B orphan rows -> no metric table read for it', async () => {
    seed(WORLD);
    const r = await invoke(handler, { method: 'GET', as: 'A', query: { companyId: CO_A, campaignId: ORPHAN_ID } });
    expect(r.status).toBe(200);
    expect(statementsNaming(metricTables, ORPHAN_ID)).toEqual([]);
    if (name === 'publishing-success') expect(r.body.data).toEqual({ published: 0, failed: 0, successRate: 0 });
  });

  it('(b) positive control: own campaign -> its rows are read', async () => {
    seed(WORLD);
    const r = await invoke(handler, { method: 'GET', as: 'A', query: { companyId: CO_A, campaignId: CAMPAIGN_A } });
    expect(r.status).toBe(200);
    expect(statementsNaming(['scheduled_posts'], CAMPAIGN_A).length).toBeGreaterThan(0);
    if (name === 'publishing-success') expect(r.body.data).toEqual({ published: 0, failed: 1, successRate: 0 });
  });
});

