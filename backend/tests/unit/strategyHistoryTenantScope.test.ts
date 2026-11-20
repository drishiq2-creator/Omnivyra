/**
 * strategyHistoryService (b3 2026-11-20, BLOCKING cross-tenant read): campaign snapshots store a client-supplied
 * recommendation_id unvalidated, and the history read resolved those ids against recommendation_snapshots by id
 * ALONE - surfacing ANOTHER company's trend_topic / category in this company's strategy history.
 * FAKED: the DB (in-memory rows honouring eq / in / order). REAL: getStrategyHistoryForCompany.
 */
export {};
type Row = Record<string, any>;
const mockDb: Record<string, Row[]> = {};
const mockFail: Record<string, boolean> = {};
function mockTable(table: string) {
  const tests: Array<(r: Row) => boolean> = [];
  const b: any = {
    select: () => b,
    order: () => b,
    eq: (c: string, v: unknown) => { tests.push((r) => r[c] === v); return b; },
    in: (c: string, v: unknown[]) => { tests.push((r) => v.includes(r[c])); return b; },
    then: (ok: any, ko: any) => Promise.resolve(mockFail[table]
      ? { data: null, error: { message: 'boom' } }
      : { data: (mockDb[table] ?? []).filter((r) => tests.every((t) => t(r))), error: null }).then(ok, ko),
  };
  return b;
}
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => mockTable(t) } }));
jest.mock('@/backend/services/context/canonicalProfileAdapter', () => ({ getCanonicalProfile: async () => null }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../middleware/withRBAC', () => ({ withRBAC: (h: unknown) => h }));
jest.mock('../../services/userContextService', () => ({ enforceCompanyAccess: async () => ({ userId: 'u-1' }) }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { getStrategyHistoryForCompany, StrategyHistoryReadError } = require('../../services/strategyHistoryService');
const route = require('../../../pages/api/recommendations/strategy-history').default;

const CO_A = 'co-a-synthetic';
const CO_B = 'co-b-synthetic';
const REC_A = 'rec-a-synthetic';
const REC_B = 'rec-b-synthetic';

beforeEach(() => {
  for (const k of Object.keys(mockFail)) delete mockFail[k];
  mockDb.recommendation_snapshots = [
    { id: REC_A, company_id: CO_A, trend_topic: 'A secret topic', category: 'A Confidential Category' },
    { id: REC_B, company_id: CO_B, trend_topic: 'B topic', category: 'B Category' },
  ];
});

const campaignOf = (company: string, recId: string) =>
  ({ company_id: company, created_at: '2026-11-01T00:00:00Z', campaign_snapshot: { source_recommendation_id: recId } });

describe('strategy history resolves recommendation ids only within the company', () => {
  it('a campaign of B carrying company A\'s recommendation id never surfaces A\'s category or topic', async () => {
    mockDb.campaign_versions = [campaignOf(CO_B, REC_A)];
    const r = await getStrategyHistoryForCompany(CO_B);
    expect(r.campaigns_count).toBe(1);
    expect(JSON.stringify(r)).not.toMatch(/A Confidential Category|A secret topic/);
  });

  it('control: B\'s own recommendation id resolves to its category', async () => {
    mockDb.campaign_versions = [campaignOf(CO_B, REC_B)];
    const r = await getStrategyHistoryForCompany(CO_B);
    expect(JSON.stringify(r)).toMatch(/B Category/);
  });
});

// Read-failure rule (b3 2026-11-20): a failed read is never an empty history.
describe('a failed read is an error with retry, never an empty history', () => {
  it.each([['campaign_versions'], ['recommendation_snapshots']])('a failed %s read throws StrategyHistoryReadError', async (table) => {
    mockDb.campaign_versions = [campaignOf(CO_B, REC_B)];
    mockFail[table] = true;
    const err = await getStrategyHistoryForCompany(CO_B).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StrategyHistoryReadError);
    expect(err).toMatchObject({ code: 'STRATEGY_HISTORY_UNAVAILABLE', retryable: true, stage: table });
  });

  it('control: a genuinely EMPTY company (no campaigns) is an empty history, not an error', async () => {
    mockDb.campaign_versions = [];
    await expect(getStrategyHistoryForCompany(CO_B)).resolves.toMatchObject({ campaigns_count: 0, dominant_aspects: [] });
  });

  const call = async () => {
    const res: any = { headers: {} as Record<string, string>, statusCode: 0, body: null,
      setHeader(k: string, v: string) { this.headers[k] = v; }, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    await route({ method: 'GET', query: { companyId: CO_B }, headers: {} }, res);
    return res;
  };

  it('route: a failed read answers 503 STRATEGY_HISTORY_UNAVAILABLE with Retry-After, never 200-empty', async () => {
    mockDb.campaign_versions = [campaignOf(CO_B, REC_B)];
    mockFail.campaign_versions = true;
    const r = await call();
    expect(r.statusCode).toBe(503);
    expect(r.headers['Retry-After']).toBe('5');
    expect(r.body).toEqual({ code: 'STRATEGY_HISTORY_UNAVAILABLE', error: 'Strategy history could not be loaded. Try again.' });
  });

  it('route control: a successful read answers 200 with the history', async () => {
    mockDb.campaign_versions = [campaignOf(CO_B, REC_B)];
    const r = await call();
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.body)).toMatch(/B Category/);
  });
});

// Casing (b3 2026-11-20): the access check matches a uuid column (any casing); the history tables store TEXT.
describe('a differently-cased company id neither empties the history nor crosses the company filter', () => {
  const UA = '0a0a0a0a-0000-4000-8000-00000000000a';
  const UB = '0b0b0b0b-0000-4000-8000-00000000000b';
  beforeEach(() => {
    mockDb.recommendation_snapshots = [
      { id: 'rec-ua', company_id: UA, trend_topic: 'UA topic', category: 'UA Category' },
      { id: 'rec-ub', company_id: UB, trend_topic: 'UB topic', category: 'UB Category' },
    ];
  });
  it('UPPER-cased own id: the history is there (same as lowercase)', async () => {
    mockDb.campaign_versions = [campaignOf(UB, 'rec-ub')];
    const upper = await getStrategyHistoryForCompany(UB.toUpperCase());
    const lower = await getStrategyHistoryForCompany(UB);
    expect(upper).toEqual(lower);
    expect(JSON.stringify(upper)).toMatch(/UB Category/);
  });
  it('UPPER-cased id still never resolves ANOTHER company\'s recommendation', async () => {
    mockDb.campaign_versions = [campaignOf(UB, 'rec-ua')];
    const r = await getStrategyHistoryForCompany(` ${UB.toUpperCase()} `);
    expect(JSON.stringify(r)).not.toMatch(/UA Category|UA topic/);
  });
});

describe('strategy memory as an OPTIONAL input (generate.ts): degrades to null, never INVISIBLY (7c)', () => {
  const { getStrategyMemoryOrNull } = require('../../services/strategyHistoryService');
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => warn.mockRestore());

  it('a failed read -> null AND a strategy_memory_unavailable warning naming the stage', async () => {
    mockDb.campaign_versions = [campaignOf(CO_B, REC_B)];
    mockFail.recommendation_snapshots = true;
    await expect(getStrategyMemoryOrNull(CO_B)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('strategy_memory_unavailable', expect.objectContaining({ companyId: CO_B, stage: 'recommendation_snapshots' }));
  });

  it('CONTROL: an empty history -> null with NO warning; a real history is returned as is', async () => {
    mockDb.campaign_versions = [];
    await expect(getStrategyMemoryOrNull(CO_B)).resolves.toBeNull();
    mockDb.campaign_versions = [campaignOf(CO_B, REC_B)];
    await expect(getStrategyMemoryOrNull(CO_B)).resolves.toMatchObject({ campaigns_count: 1 });
    expect(warn).not.toHaveBeenCalled();
  });
});
