/**
 * S2-55 (2026-11-14) - four campaign routes derive their owner from the CANONICAL resolver
 * (resolveCampaignOwnership, 3AH-113) and read through the tenant seam:
 *
 *   pages/api/campaigns/[id]/continuity.ts
 *   pages/api/campaigns/[id]/engagement-health.ts
 *   pages/api/campaigns/[id]/health.ts
 *   pages/api/campaigns/[id]/strategic-insights.ts
 *
 * Each used to take the company from ONE campaign_versions row (`.limit(1)`), falling back to campaigns.company_id
 * or (three of them) a caller-supplied ?companyId=. SEC91 A8: the versions are authoritative and the owner is never
 * campaigns.company_id alone; the resolver decides from the SET of owner records.
 *
 * Per route, against the real resolver over the harness database:
 *   (a) LOOKUP_FAILED (an owner-record read fails)      -> 503 + Retry-After, retryable, nothing else read;
 *   (b) CONFLICT (campaigns names A, a version names B) -> 404 "Campaign not found", no tenant data read;
 *   (c) OWNED + authorized owner                         -> 200 (positive control).
 */
import { seed, invoke, failTable, calls, CAMPAIGN_A, CO_A, CO_B } from '../helpers/routeAuthHarness';

jest.mock('@/config', () => ({ config: { DEV_USER_ID: '', NODE_ENV: 'production' } }));
jest.mock('../../db/supabaseClient', () => jest.requireActual('../helpers/routeAuthHarness').supabaseModule());
jest.mock('../../db/writeOwner', () => jest.requireActual('../helpers/routeAuthHarness').writeOwnerModule());
jest.mock('../../services/supabaseAuthService', () => jest.requireActual('../helpers/routeAuthHarness').authModule());
jest.mock('../../security/IdentityResolver', () => jest.requireActual('../helpers/routeAuthHarness').identityModule());

const reportCalls: Array<{ companyId: string; entityId: string }> = [];
jest.mock('../../services/decisionReportService', () => ({
  getDecisionReportView: jest.fn(async (a: { companyId: string; entityId: string }) => {
    reportCalls.push({ companyId: a.companyId, entityId: a.entityId });
    return { companyId: a.companyId, entityId: a.entityId, sections: [] };
  }),
}));
jest.mock('../../services/intelligenceExecutionContext', () => ({
  runInApiReadContext: jest.fn(async (_n: string, fn: () => unknown) => fn()),
}));
const healthRefreshes: Array<{ campaignId: string; companyId: string }> = [];
jest.mock('../../jobs/campaignHealthEvaluationJob', () => ({
  evaluateAndPersistCampaignHealth: jest.fn(async (campaignId: string, companyId: string) => {
    healthRefreshes.push({ campaignId, companyId });
  }),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const continuity = require('../../../pages/api/campaigns/[id]/continuity').default;
const engagementHealth = require('../../../pages/api/campaigns/[id]/engagement-health').default;
const health = require('../../../pages/api/campaigns/[id]/health').default;
const strategicInsights = require('../../../pages/api/campaigns/[id]/strategic-insights').default;
/* eslint-enable @typescript-eslint/no-var-requires */

const HEALTH_REPORT = { health_score: 77, marker: 'health-report-a' };

function seedWorld(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  seed({
    campaign_health_reports: [
      {
        id: 'chr-a', company_id: CO_A, campaign_id: CAMPAIGN_A, report_json: HEALTH_REPORT,
        evaluated_at: new Date().toISOString(), created_at: new Date().toISOString(),
      },
    ],
    ...extra,
  });
  reportCalls.length = 0;
  healthRefreshes.length = 0;
}

/** Tables holding the routes' tenant DATA (not the owner records the resolver reads). */
const DATA_TABLES = ['campaign_health_reports', 'campaign_performance', 'blogs', 'public_blogs', 'campaign_topic_maps'];
const dataReads = () => calls().filter((c) => DATA_TABLES.includes(c.table));
const ownerRecordReads = () => calls().filter((c) => c.table === 'campaigns' || c.table === 'campaign_versions');

const routes = [
  { name: 'continuity', handler: continuity },
  { name: 'engagement-health', handler: engagementHealth },
  { name: 'health', handler: health },
  { name: 'strategic-insights', handler: strategicInsights },
];

describe.each(routes)('GET campaigns/[id]/$name - canonical ownership', ({ name, handler }) => {
  it('(a) LOOKUP_FAILED: an owner-record read fails -> 503 + Retry-After, retryable, no tenant data read', async () => {
    seedWorld();
    failTable('campaign_versions');
    const r = await invoke(handler, { method: 'GET', query: { id: CAMPAIGN_A }, as: 'A' });
    expect(r.status).toBe(503);
    expect(r.headers['retry-after']).toBeDefined();
    expect(r.body).toMatchObject({ code: 'CAMPAIGN_LOOKUP_ERROR', retryable: true });
    expect(dataReads()).toEqual([]);
    expect(reportCalls).toEqual([]);
  });

  it('(b) CONFLICT: campaigns names A, a version names B -> 404 Campaign not found, no tenant data read', async () => {
    seedWorld({
      campaign_versions: [{ campaign_id: CAMPAIGN_A, company_id: CO_B, version: 2, created_at: '2026-02-01', campaign_snapshot: {} }],
    });
    // The caller is an active COMPANY_ADMIN of A: the old ".limit(1)" read could authorize A on this campaign.
    const r = await invoke(handler, { method: 'GET', query: { id: CAMPAIGN_A }, as: 'A' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Campaign not found' });
    expect(dataReads()).toEqual([]);
    expect(reportCalls).toEqual([]);
    // Only the resolver's two owner-record reads ran; nothing re-read the campaign or its versions for data.
    expect(ownerRecordReads().map((c) => c.table).sort()).toEqual(['campaign_versions', 'campaigns']);
    expect(JSON.stringify(r.body)).not.toContain(CO_B);
    expect(JSON.stringify(r.body)).not.toContain(CO_A);
  });

  it('(c) positive control: OWNED + the authorized owner -> 200', async () => {
    seedWorld();
    const r = await invoke(handler, { method: 'GET', query: { id: CAMPAIGN_A }, as: 'A' });
    expect(r.status).toBe(200);
    if (name === 'health') expect(r.body).toEqual(HEALTH_REPORT);
    if (name === 'engagement-health') expect(r.body).toMatchObject({ campaign_id: CAMPAIGN_A, company_id: CO_A });
    if (name === 'strategic-insights') expect(reportCalls).toEqual([{ companyId: CO_A, entityId: CAMPAIGN_A }]);
    if (name === 'continuity') expect(r.body).toMatchObject({ has_data: false, timeline: [{ campaign_id: CAMPAIGN_A, stage: 'current' }] });
  });
});

describe('the caller-supplied ?companyId= fallback is gone', () => {
  it.each([
    ['engagement-health', engagementHealth],
    ['health', health],
    ['strategic-insights', strategicInsights],
  ])('%s: an unknown campaign with ?companyId=<own company> -> 404, never authorized against the caller company', async (_n, handler) => {
    seedWorld();
    const r = await invoke(handler, { method: 'GET', query: { id: 'unkn-x-00-0000-0000-00000000000x', companyId: CO_A }, as: 'A' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Campaign not found' });
    expect(dataReads()).toEqual([]);
    expect(reportCalls).toEqual([]);
  });
});

describe('tenant-seam reads carry the resolved owner', () => {
  it('health reads campaign_health_reports under the owner company only', async () => {
    seedWorld();
    await invoke(health, { method: 'GET', query: { id: CAMPAIGN_A }, as: 'A' });
    const reads = calls().filter((c) => c.table === 'campaign_health_reports');
    expect(reads.length).toBeGreaterThan(0);
    for (const c of reads) expect(c.filters.company_id).toBe(CO_A);
  });

  it('continuity reads campaigns / campaign_versions / campaign_performance for data under the owner company only', async () => {
    seedWorld();
    await invoke(continuity, { method: 'GET', query: { id: CAMPAIGN_A }, as: 'A' });
    const tenantReads = calls().filter((c) => ['campaigns', 'campaign_versions', 'campaign_performance'].includes(c.table));
    // The resolver's two owner-record reads carry no company predicate by design; every data read after it does.
    const dataPhase = tenantReads.slice(2);
    expect(dataPhase.length).toBeGreaterThan(0);
    for (const c of dataPhase) expect(c.filters.company_id).toBe(CO_A);
  });
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../helpers/routeAuthHarness').assertNoHarnessConfigurationError();
});
